const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const pty = require('node-pty');

// MVP phase: run core server as a separate process using your system Node
// (avoids native module ABI issues inside Electron)
let coreProc;

const WORKSPACE_WATCH_DEBOUNCE_MS = 240;
const WORKSPACE_WATCH_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  '.next',
  '.turbo',
  '.vite',
  'coverage'
]);
const WORKSPACE_WATCH_IGNORED_BASENAMES = new Set([
  '.ds_store'
]);
const UPDATE_RELEASE_API_URL = 'https://api.github.com/repos/bzdzhangchi-bot/Inspiration-AIDE/releases/latest';
const UPDATE_DOWNLOADS_SUBDIR = 'Inspiration Downloads';
const UPDATE_REQUEST_TIMEOUT_MS = 20000;
const STARTER_PROJECT_TEMPLATE_DIR = path.join(__dirname, 'starter-project');
const STARTER_PROJECT_TARGET_DIRNAME = 'starter-project';
const STARTER_PROJECT_MANIFEST_NAME = '.inspiration-starter.json';
const OPENCLAW_INSTALL_COMMAND = 'npm install -g openclaw@latest';
const OPENCLAW_DEFAULT_ONBOARD_ARGS = [
  'onboard',
  '--non-interactive',
  '--flow',
  'quickstart',
  '--mode',
  'local',
  '--auth-choice',
  'skip',
  '--skip-search',
  '--skip-skills',
  '--install-daemon',
  '--daemon-runtime',
  'node',
  '--accept-risk',
  '--json'
];

const state = {
  workspaceRoot: null,
  workspaceRoots: [],
  workspaceWatchers: new Map(),
  workspaceWatchDebounceTimers: new Map(),
  pendingWorkspaceChanges: new Map(),
  terminal: {
    sessions: new Map(),
    activeSessionId: null,
    nextSessionId: 1,
    nextCaptureId: 1,
    cols: 120,
    rows: 30
  },
  updater: {
    activeDownload: null
  },
  openClawInstaller: {
    currentRunId: 0,
    activePromise: null,
    state: {
      status: 'idle',
      mode: 'install',
      step: 'idle',
      message: 'OpenClaw installer idle.',
      detail: null,
      log: '',
      percent: null,
      startedAt: null,
      finishedAt: null,
      openClawVersion: null
    }
  }
};

function closeWorkspaceWatchers() {
  for (const watcher of state.workspaceWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  state.workspaceWatchers.clear();

  for (const timer of state.workspaceWatchDebounceTimers.values()) {
    clearTimeout(timer);
  }
  state.workspaceWatchDebounceTimers.clear();
  state.pendingWorkspaceChanges.clear();
}

function emitWorkspaceEvent(payload) {
  broadcast('workspace:event', payload);
}

function emitAppUpdateEvent(payload) {
  broadcast('app-update:event', payload);
}

function buildOpenClawInstallerStatePayload() {
  return {
    ...state.openClawInstaller.state
  };
}

function emitOpenClawInstallerEvent() {
  broadcast('openclaw-installer:event', buildOpenClawInstallerStatePayload());
}

function updateOpenClawInstallerState(patch) {
  state.openClawInstaller.state = {
    ...state.openClawInstaller.state,
    ...patch
  };
  emitOpenClawInstallerEvent();
}

function appendOpenClawInstallerLog(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text) return state.openClawInstaller.state.log;
  const next = `${state.openClawInstaller.state.log || ''}${text}`;
  const maxChars = 120000;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

function summarizeProcessChunk(value) {
  const text = String(value || '').replace(/\r/g, '\n');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

function normalizeWorkspaceRoots(nextRoots) {
  const seen = new Set();
  const normalized = [];
  for (const root of Array.isArray(nextRoots) ? nextRoots : []) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

function filterExistingWorkspaceRoots(nextRoots) {
  return normalizeWorkspaceRoots(nextRoots).filter((rootPath) => {
    try {
      return fs.statSync(rootPath).isDirectory();
    } catch {
      return false;
    }
  });
}

function shouldIgnoreWorkspaceWatchPath(rootPath, targetPath) {
  if (!targetPath || targetPath === rootPath) return false;
  const relativePath = path.relative(rootPath, targetPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }

  const parts = relativePath.split(path.sep).filter(Boolean);
  if (!parts.length) return false;

  return parts.some((part) => {
    const lower = part.toLowerCase();
    return WORKSPACE_WATCH_IGNORED_NAMES.has(lower) || WORKSPACE_WATCH_IGNORED_BASENAMES.has(lower);
  });
}

function flushWorkspaceWatchEvents(rootPath) {
  const timer = state.workspaceWatchDebounceTimers.get(rootPath);
  if (timer) {
    clearTimeout(timer);
    state.workspaceWatchDebounceTimers.delete(rootPath);
  }

  const pendingPaths = state.pendingWorkspaceChanges.get(rootPath);
  state.pendingWorkspaceChanges.delete(rootPath);
  if (!pendingPaths || pendingPaths.size === 0) return;

  const paths = [...pendingPaths];
  const nextPath = paths.length === 1 ? paths[0] : rootPath;
  emitWorkspaceEvent({
    type: 'changed',
    eventType: 'change',
    path: nextPath
  });
}

function scheduleWorkspaceWatchEvent(rootPath, changedPath) {
  const normalizedPath = typeof changedPath === 'string' && changedPath ? path.resolve(rootPath, changedPath) : rootPath;
  if (shouldIgnoreWorkspaceWatchPath(rootPath, normalizedPath)) {
    return;
  }

  const pendingPaths = state.pendingWorkspaceChanges.get(rootPath) ?? new Set();
  pendingPaths.add(normalizedPath);
  state.pendingWorkspaceChanges.set(rootPath, pendingPaths);

  if (state.workspaceWatchDebounceTimers.has(rootPath)) {
    return;
  }

  const timer = setTimeout(() => {
    flushWorkspaceWatchEvents(rootPath);
  }, WORKSPACE_WATCH_DEBOUNCE_MS);
  state.workspaceWatchDebounceTimers.set(rootPath, timer);
}

function watchWorkspaceRoots(rootPaths) {
  closeWorkspaceWatchers();
  for (const rootPath of rootPaths) {
    if (!rootPath) continue;
    try {
      const watcher = fs.watch(rootPath, { recursive: true }, (eventType, changedPath) => {
        void eventType;
        scheduleWorkspaceWatchEvent(rootPath, changedPath);
      });

      watcher.on('error', (error) => {
        emitWorkspaceEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Workspace watch failed'
        });
      });

      state.workspaceWatchers.set(rootPath, watcher);
    } catch (error) {
      emitWorkspaceEvent({
        type: 'error',
        message: error instanceof Error ? error.message : 'Workspace watch failed'
      });
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendLimitedOutput(current, addition, maxOutputChars) {
  if (!addition) return current;
  if (current.endsWith('\n...[truncated]')) return current;
  const next = current + addition;
  if (next.length <= maxOutputChars) return next;
  return `${next.slice(0, maxOutputChars)}\n...[truncated]`;
}

function normalizeCapturedOutput(value) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+/, '').trimEnd();
}

function finalizeTerminalCapture(session, result) {
  const capture = session?.capture;
  if (!capture) return;
  session.capture = null;
  clearTimeout(capture.timer);
  capture.resolve(result);
}

function rejectTerminalCapture(session, error) {
  const capture = session?.capture;
  if (!capture) return;
  session.capture = null;
  clearTimeout(capture.timer);
  capture.reject(error);
}

function processTerminalCaptureChunk(session, chunk) {
  const capture = session?.capture;
  if (!capture) return;

  capture.pending += String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (!capture.started) {
    const startIndex = capture.pending.indexOf(capture.startMarker);
    if (startIndex === -1) {
      const keep = Math.max(capture.startMarker.length * 2, 128);
      if (capture.pending.length > keep) {
        capture.pending = capture.pending.slice(-keep);
      }
      return;
    }

    capture.started = true;
    capture.pending = capture.pending.slice(startIndex + capture.startMarker.length).replace(/^\n+/, '');
  }

  const endPattern = new RegExp(`${escapeRegExp(capture.endMarker)}:(-?\\d+)`);
  const match = endPattern.exec(capture.pending);
  if (!match) {
    const tailLength = capture.endMarker.length + 32;
    if (capture.pending.length > tailLength) {
      const flush = capture.pending.slice(0, capture.pending.length - tailLength);
      capture.captured = appendLimitedOutput(capture.captured, flush, capture.maxOutputChars);
      capture.pending = capture.pending.slice(capture.pending.length - tailLength);
    }
    return;
  }

  const markerIndex = match.index ?? capture.pending.indexOf(match[0]);
  const body = capture.pending.slice(0, markerIndex);
  capture.captured = appendLimitedOutput(capture.captured, body, capture.maxOutputChars);

  finalizeTerminalCapture(session, {
    stdout: normalizeCapturedOutput(capture.captured),
    stderr: '',
    exitCode: Number(match[1]),
    signal: null,
    cwd: session.cwd,
    sessionId: session.id
  });
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function emitAppCommand(type, browserWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  browserWindow.webContents.send('app:command', { type });
}

function buildApplicationMenu() {
  const template = [];

  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Open Project…',
        click: (_menuItem, browserWindow) => emitAppCommand('open-project', browserWindow)
      },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
    ]
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  });

  template.push({
    label: 'Window',
    submenu: process.platform === 'darwin'
      ? [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' }
        ]
      : [
          { role: 'minimize' },
          { role: 'close' }
        ]
  });

  return Menu.buildFromTemplate(template);
}

function getDefaultTerminalCwd() {
  return state.workspaceRoot || app.getPath('home');
}

function getTerminalCwd() {
  const activeSession = getTerminalSession(state.terminal.activeSessionId);
  return activeSession?.cwd || getDefaultTerminalCwd();
}

function getTerminalSessions() {
  return [...state.terminal.sessions.values()]
    .sort((a, b) => a.id - b.id)
    .map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      connected: session.connected
    }));
}

function getTerminalSession(sessionId) {
  if (typeof sessionId !== 'number') return null;
  return state.terminal.sessions.get(sessionId) || null;
}

function buildTerminalStatePayload() {
  return {
    workspaceRoot: state.workspaceRoot,
    activeSessionId: state.terminal.activeSessionId,
    sessions: getTerminalSessions()
  };
}

function emitTerminalState() {
  broadcast('terminal:event', {
    type: 'state',
    ...buildTerminalStatePayload()
  });
}

function setWorkspaceState(nextRoots, nextActiveRoot, options = {}) {
  const normalizedRoots = normalizeWorkspaceRoots(nextRoots);
  const resolvedActiveRoot = typeof nextActiveRoot === 'string' && nextActiveRoot.trim()
    ? path.resolve(nextActiveRoot)
    : normalizedRoots[0] ?? null;
  const activeRoot = normalizedRoots.includes(resolvedActiveRoot) ? resolvedActiveRoot : normalizedRoots[0] ?? null;
  const activeChanged = state.workspaceRoot !== activeRoot;

  state.workspaceRoots = normalizedRoots;
  state.workspaceRoot = activeRoot;
  saveConfig();
  watchWorkspaceRoots(state.workspaceRoots);
  if (options.resetTerminal !== false && activeChanged) {
    resetTerminalSessions();
  }
}

function addWorkspaceRoot(nextRoot, options = {}) {
  if (typeof nextRoot !== 'string' || !nextRoot.trim()) return state.workspaceRoot;
  const resolved = path.resolve(nextRoot);
  const nextRoots = state.workspaceRoots.includes(resolved)
    ? state.workspaceRoots
    : [...state.workspaceRoots, resolved];
  setWorkspaceState(nextRoots, options.makeActive === false ? state.workspaceRoot : resolved, {
    resetTerminal: options.resetTerminal ?? options.makeActive !== false
  });
  return state.workspaceRoot;
}

function setActiveWorkspaceRoot(nextRoot, options = {}) {
  if (typeof nextRoot !== 'string' || !nextRoot.trim()) {
    setWorkspaceState(state.workspaceRoots, state.workspaceRoots[0] ?? null, options);
    return;
  }
  const resolved = path.resolve(nextRoot);
  if (!state.workspaceRoots.includes(resolved)) {
    addWorkspaceRoot(resolved, { makeActive: true, resetTerminal: options.resetTerminal });
    return;
  }
  setWorkspaceState(state.workspaceRoots, resolved, options);
}

function removeWorkspaceRoot(nextRoot, options = {}) {
  if (typeof nextRoot !== 'string' || !nextRoot.trim()) return state.workspaceRoot;
  const resolved = path.resolve(nextRoot);
  if (!state.workspaceRoots.includes(resolved)) return state.workspaceRoot;

  const nextRoots = state.workspaceRoots.filter((root) => root !== resolved);
  const nextActiveRoot = state.workspaceRoot === resolved ? nextRoots[0] ?? null : state.workspaceRoot;
  setWorkspaceState(nextRoots, nextActiveRoot, {
    resetTerminal: options.resetTerminal ?? state.workspaceRoot === resolved
  });
  return state.workspaceRoot;
}

function reorderWorkspaceRoots(nextRoots, options = {}) {
  const requestedRoots = normalizeWorkspaceRoots(nextRoots).filter((root) => state.workspaceRoots.includes(root));
  const missingRoots = state.workspaceRoots.filter((root) => !requestedRoots.includes(root));
  const reorderedRoots = [...requestedRoots, ...missingRoots];
  setWorkspaceState(reorderedRoots, state.workspaceRoot, {
    resetTerminal: options.resetTerminal ?? false
  });
  return {
    workspaceRoot: state.workspaceRoot,
    workspaceRoots: [...state.workspaceRoots]
  };
}

async function isCoreHealthy(port = 17840) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    clearTimeout(timeout);
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return payload?.ok === true;
  } catch {
    return false;
  }
}

async function startCore() {
  if (process.env.ASSISTANT_DESK_NO_CORE === '1') {
    console.log('[core] skipped (ASSISTANT_DESK_NO_CORE=1)');
    return;
  }

  if (await isCoreHealthy()) {
    console.log('[core] reusing existing core on 17840');
    return;
  }

  const isPackaged = app.isPackaged;
  const coreEntry = isPackaged
    ? path.join(__dirname, '..', 'dist-electron', 'main', 'core-server.js')
    : path.join(__dirname, '..', 'src', 'main', 'core-server.ts');
  const command = isPackaged ? process.execPath : 'node';
  const args = isPackaged ? [coreEntry] : ['--import', 'tsx', coreEntry];

  coreProc = spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      // ensure Node trusts macOS system roots (workaround for TLS issues)
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '/tmp/system-root-cas.pem'
    }
  });

  coreProc.on('exit', (code) => {
    console.log('[core] exited', code);
  });
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const parsedRoots = filterExistingWorkspaceRoots(parsed?.workspaceRoots);
    const fallbackRoot = typeof parsed?.workspaceRoot === 'string' && parsed.workspaceRoot.length
      ? path.resolve(parsed.workspaceRoot)
      : null;
    const usableFallbackRoot = fallbackRoot && parsedRoots.includes(fallbackRoot) ? fallbackRoot : null;
    state.workspaceRoots = parsedRoots.length ? parsedRoots : usableFallbackRoot ? [usableFallbackRoot] : [];
    state.workspaceRoot = usableFallbackRoot ?? state.workspaceRoots[0] ?? null;
  } catch {
    // ignore
  }
}

function saveConfig() {
  const next = JSON.stringify({ workspaceRoot: state.workspaceRoot, workspaceRoots: state.workspaceRoots }, null, 2);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(), next, 'utf8');
}

function hashBuffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

async function collectStarterTemplateFiles(baseDir, currentDir = baseDir) {
  const entries = await fsp.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const sourcePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, sourcePath).replace(/\\/g, '/');
    if (relativePath === STARTER_PROJECT_MANIFEST_NAME) continue;

    if (entry.isDirectory()) {
      files.push(...await collectStarterTemplateFiles(baseDir, sourcePath));
      continue;
    }

    if (!entry.isFile()) continue;
    files.push({ sourcePath, relativePath });
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readStarterManifest(destinationDir) {
  const manifestPath = path.join(destinationDir, STARTER_PROJECT_MANIFEST_NAME);
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed
      ? parsed
      : { templateHashes: {} };
  } catch {
    return { templateHashes: {} };
  }
}

async function writeStarterManifest(destinationDir, manifest) {
  const manifestPath = path.join(destinationDir, STARTER_PROJECT_MANIFEST_NAME);
  await fsp.mkdir(destinationDir, { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

async function syncStarterTemplateTree(sourceDir, destinationDir) {
  const templateFiles = await collectStarterTemplateFiles(sourceDir);
  const previousManifest = await readStarterManifest(destinationDir);
  const previousHashes = typeof previousManifest.templateHashes === 'object' && previousManifest.templateHashes
    ? previousManifest.templateHashes
    : {};
  const nextHashes = {};

  await fsp.mkdir(destinationDir, { recursive: true });

  for (const file of templateFiles) {
    const destinationPath = path.join(destinationDir, file.relativePath);
    const templateBuffer = await fsp.readFile(file.sourcePath);
    const templateHash = hashBuffer(templateBuffer);
    nextHashes[file.relativePath] = templateHash;

    let shouldWrite = !(await pathExists(destinationPath));
    if (!shouldWrite) {
      if (!previousHashes[file.relativePath]) {
        shouldWrite = true;
      } else {
        const existingBuffer = await fsp.readFile(destinationPath);
        const existingHash = hashBuffer(existingBuffer);
        shouldWrite = existingHash === previousHashes[file.relativePath];
      }
    }

    if (shouldWrite) {
      await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
      await fsp.writeFile(destinationPath, templateBuffer);
    }
  }

  await writeStarterManifest(destinationDir, {
    updatedAt: new Date().toISOString(),
    templateHashes: nextHashes
  });
}

async function ensureStarterWorkspace() {
  if (!(await pathExists(STARTER_PROJECT_TEMPLATE_DIR))) {
    return null;
  }

  const starterRoot = path.join(app.getPath('userData'), STARTER_PROJECT_TARGET_DIRNAME);
  await syncStarterTemplateTree(STARTER_PROJECT_TEMPLATE_DIR, starterRoot);
  return starterRoot;
}

async function syncStarterWorkspaceState() {
  const starterRoot = await ensureStarterWorkspace();
  if (!starterRoot) return;

  const starterIsTracked = state.workspaceRoot === starterRoot || state.workspaceRoots.includes(starterRoot);
  if (!state.workspaceRoots.length) {
    setWorkspaceState([starterRoot], starterRoot, { resetTerminal: false });
    return;
  }

  if (starterIsTracked) {
    const nextRoots = state.workspaceRoots.includes(starterRoot)
      ? state.workspaceRoots
      : [...state.workspaceRoots, starterRoot];
    setWorkspaceState(nextRoots, state.workspaceRoot ?? starterRoot, { resetTerminal: false });
  }
}

function getDefaultTerminalTitle(id) {
  return `shell-${id}`;
}

function createTerminalSession(options = {}) {
  const cwd = path.resolve(options.cwd || getDefaultTerminalCwd());
  const id = state.terminal.nextSessionId++;
  const session = {
    id,
    title: typeof options.title === 'string' && options.title.trim() ? options.title.trim() : getDefaultTerminalTitle(id),
    cwd,
    proc: null,
    connected: false,
    capture: null,
    inputBuffer: ''
  };

  state.terminal.sessions.set(id, session);
  state.terminal.activeSessionId = id;
  attachTerminalProcess(session);
  emitTerminalState();
  return session;
}

function ensureTerminalSession() {
  if (state.terminal.sessions.size) {
    if (!getTerminalSession(state.terminal.activeSessionId)) {
      const first = getTerminalSessions()[0];
      state.terminal.activeSessionId = first?.id ?? null;
      emitTerminalState();
    }
    return getTerminalSession(state.terminal.activeSessionId);
  }

  return createTerminalSession();
}

function attachTerminalProcess(session) {
  if (!session) return;

  const shell = process.env.SHELL || '/bin/zsh';
  const sessionId = session.id;
  const proc = pty.spawn(shell, ['-il'], {
    name: process.env.TERM || 'xterm-256color',
    cols: state.terminal.cols,
    rows: state.terminal.rows,
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color',
      COLORTERM: process.env.COLORTERM || 'truecolor'
    }
  });

  session.proc = proc;
  session.connected = true;

  proc.onData((chunk) => {
    const current = getTerminalSession(sessionId);
    if (!current || current.proc !== proc) return;
    broadcast('terminal:event', {
      type: 'data',
      sessionId,
      data: String(chunk)
    });
    processTerminalCaptureChunk(current, chunk);
  });

  proc.onExit(({ exitCode, signal }) => {
    const current = getTerminalSession(sessionId);
    if (!current || current.proc !== proc) return;
    if (current.capture) {
      const capture = current.capture;
      finalizeTerminalCapture(current, {
        stdout: normalizeCapturedOutput(capture.captured + capture.pending),
        stderr: '',
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: typeof signal === 'number' ? String(signal) : null,
        cwd: current.cwd,
        sessionId: current.id
      });
    }
    current.proc = null;
    current.connected = false;
    broadcast('terminal:event', {
      type: 'exit',
      sessionId,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      signal: typeof signal === 'number' ? String(signal) : null
    });
    emitTerminalState();
  });
}

function destroyTerminalSession(sessionId, options = {}) {
  const session = getTerminalSession(sessionId);
  if (!session) return;

  if (session.capture) {
    rejectTerminalCapture(session, new Error('Terminal session was closed during command execution'));
  }

  const proc = session.proc;
  session.proc = null;
  session.connected = false;
  if (proc) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  if (options.remove !== false) {
    state.terminal.sessions.delete(sessionId);
  }

  if (state.terminal.activeSessionId === sessionId) {
    const first = getTerminalSessions()[0];
    state.terminal.activeSessionId = first?.id ?? null;
  }

  emitTerminalState();
}

function resetTerminalSessions() {
  const ids = getTerminalSessions().map((session) => session.id);
  for (const sessionId of ids) {
    destroyTerminalSession(sessionId, { remove: true });
  }
  createTerminalSession({ cwd: getDefaultTerminalCwd() });
}

function restartTerminalSession(sessionId) {
  const session = getTerminalSession(sessionId);
  if (!session) {
    createTerminalSession();
    return;
  }

  const nextTitle = session.title;
  const nextCwd = session.cwd;
  const shouldActivate = state.terminal.activeSessionId === sessionId;
  destroyTerminalSession(sessionId, { remove: true });
  const next = createTerminalSession({ cwd: nextCwd, title: nextTitle });
  if (!shouldActivate) {
    state.terminal.activeSessionId = next.id;
    emitTerminalState();
  }
}

function emitTerminalInputLine(sessionId, source, text) {
  const trimmed = sanitizeTerminalInputLine(text);
  if (!trimmed) return;
  broadcast('terminal:event', {
    type: 'input-line',
    sessionId,
    source,
    text: trimmed
  });
}

function stripAnsiSequences(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

function sanitizeTerminalInputLine(value) {
  let cleaned = stripAnsiSequences(String(value || '')).replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  while (cleaned.includes('\b')) {
    cleaned = cleaned.replace(/[^\n]\x08/g, '').replace(/\x08/g, '');
  }
  return cleaned.trim();
}

function processTerminalInputSync(session, data, source) {
  if (!session) return;
  const normalized = String(data).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  session.inputBuffer += normalized;
  const lines = session.inputBuffer.split('\n');
  session.inputBuffer = lines.pop() || '';

  for (const rawLine of lines) {
    emitTerminalInputLine(session.id, source, rawLine);
  }
}

function writeTerminalInput(data, sessionId, source = 'terminal') {
  if (typeof data !== 'string' || !data.length) return;
  let session = getTerminalSession(sessionId ?? state.terminal.activeSessionId);
  if (!session) {
    session = createTerminalSession();
  }
  if (!session.proc || !session.connected) {
    attachTerminalProcess(session);
    emitTerminalState();
  }
  session.proc?.write(data);
  processTerminalInputSync(session, data, source);
}

function resizeTerminal(cols, rows) {
  if (Number.isFinite(cols) && cols > 0) {
    state.terminal.cols = Math.floor(cols);
  }
  if (Number.isFinite(rows) && rows > 0) {
    state.terminal.rows = Math.floor(rows);
  }
  for (const session of state.terminal.sessions.values()) {
    session.proc?.resize(state.terminal.cols, state.terminal.rows);
  }
}

function interruptTerminalSession(sessionId) {
  const session = getTerminalSession(sessionId ?? state.terminal.activeSessionId);
  session?.proc?.write('\x03');
}

async function runWorkspaceCommand(command, timeoutMs = 20000) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Command is required');
  }

  const shell = process.env.SHELL || '/bin/zsh';
  const cwd = getDefaultTerminalCwd();
  const maxOutputChars = 16000;

  return await new Promise((resolve, reject) => {
    const proc = spawn(shell, ['-lc', command], {
      cwd,
      env: {
        ...process.env
      }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const append = (current, chunk) => {
      const next = current + chunk;
      if (next.length <= maxOutputChars) return next;
      return `${next.slice(0, maxOutputChars)}\n...[truncated]`;
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({ stdout, stderr: append(stderr, '\nCommand timed out.'), exitCode: null, signal: 'SIGTERM', cwd });
    }, Math.max(1000, timeoutMs));

    proc.stdout.on('data', (chunk) => {
      stdout = append(stdout, String(chunk));
    });

    proc.stderr.on('data', (chunk) => {
      stderr = append(stderr, String(chunk));
    });

    proc.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal ? String(signal) : null,
        cwd
      });
    });
  });
}

async function runProgramCommand(command, args, cwd, timeoutMs = 15000, maxOutputChars = 24000) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C'
      }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const append = (current, chunk) => {
      const next = current + chunk;
      if (next.length <= maxOutputChars) return next;
      return `${next.slice(0, maxOutputChars)}\n...[truncated]`;
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({ stdout, stderr: append(stderr, '\nCommand timed out.'), exitCode: null, signal: 'SIGTERM', cwd });
    }, Math.max(1000, timeoutMs));

    proc.stdout.on('data', (chunk) => {
      stdout = append(stdout, String(chunk));
    });

    proc.stderr.on('data', (chunk) => {
      stderr = append(stderr, String(chunk));
    });

    proc.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal ? String(signal) : null,
        cwd
      });
    });
  });
}

async function runShellCommandWithStreaming(command, options = {}) {
  const shell = process.env.SHELL || '/bin/zsh';
  const cwd = options.cwd || getDefaultTerminalCwd();
  const timeoutMs = Math.max(1000, options.timeoutMs || 20000);

  return await new Promise((resolve, reject) => {
    const proc = spawn(shell, ['-lc', command], {
      cwd,
      env: {
        ...process.env,
        ...(options.env || {})
      }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({ stdout, stderr: `${stderr}\nCommand timed out.`.trim(), exitCode: null, signal: 'SIGTERM', cwd });
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onStdout?.(text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });

    proc.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal ? String(signal) : null,
        cwd
      });
    });
  });
}

async function resolveOpenClawCommandPath(cwd) {
  const resolved = await runWorkspaceCommand('command -v openclaw || true', 10000);
  const commandPath = resolved.stdout.trim();
  if (commandPath) return commandPath;

  const prefixResult = await runWorkspaceCommand('npm prefix -g', 10000);
  const prefix = prefixResult.stdout.trim();
  if (prefix) {
    const candidate = path.join(prefix, 'bin', 'openclaw');
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // ignore
    }
  }

  return 'openclaw';
}

async function startOpenClawInstaller(options = {}) {
  if (state.openClawInstaller.activePromise) {
    return buildOpenClawInstallerStatePayload();
  }

  const mode = options.update ? 'update' : 'install';
  const runId = state.openClawInstaller.currentRunId + 1;
  state.openClawInstaller.currentRunId = runId;

  const task = (async () => {
    try {
      updateOpenClawInstallerState({
        status: 'running',
        mode,
        step: 'preflight',
        message: mode === 'update' ? 'Preparing OpenClaw CLI update…' : 'Preparing OpenClaw one-click install…',
        detail: 'Checking runtime and install prerequisites.',
        log: '',
        percent: 6,
        startedAt: Date.now(),
        finishedAt: null,
        openClawVersion: state.openClawInstaller.state.openClawVersion
      });

      const installResult = await runShellCommandWithStreaming(OPENCLAW_INSTALL_COMMAND, {
        cwd: getDefaultTerminalCwd(),
        timeoutMs: 15 * 60 * 1000,
        onStdout: (chunk) => {
          const detail = summarizeProcessChunk(chunk);
          const log = appendOpenClawInstallerLog(chunk);
          if (!detail) {
            updateOpenClawInstallerState({ log });
            return;
          }
          updateOpenClawInstallerState({
            step: 'installing-cli',
            message: mode === 'update' ? 'Updating OpenClaw CLI…' : 'Installing OpenClaw CLI…',
            detail,
            log,
            percent: 28
          });
        },
        onStderr: (chunk) => {
          const detail = summarizeProcessChunk(chunk);
          const log = appendOpenClawInstallerLog(chunk);
          if (!detail) {
            updateOpenClawInstallerState({ log });
            return;
          }
          updateOpenClawInstallerState({
            step: 'installing-cli',
            message: mode === 'update' ? 'Updating OpenClaw CLI…' : 'Installing OpenClaw CLI…',
            detail,
            log,
            percent: 28
          });
        }
      });

      if (installResult.exitCode !== 0) {
        throw new Error(installResult.stderr.trim() || installResult.stdout.trim() || 'OpenClaw CLI installation failed.');
      }

      const openClawCommand = await resolveOpenClawCommandPath(getDefaultTerminalCwd());
      const versionResult = await runProgramCommand(openClawCommand, ['--version'], getDefaultTerminalCwd(), 15000);
      const openClawVersion = versionResult.exitCode === 0
        ? (versionResult.stdout.trim().split(/\s+/).find((part) => /^v?\d+\./.test(part)) ?? (versionResult.stdout.trim() || null))
        : null;

      if (!options.update) {
        const onboardCommand = `${JSON.stringify(openClawCommand)} ${OPENCLAW_DEFAULT_ONBOARD_ARGS.map((arg) => JSON.stringify(arg)).join(' ')}`;
        const onboardResult = await runShellCommandWithStreaming(onboardCommand, {
          cwd: getDefaultTerminalCwd(),
          timeoutMs: 20 * 60 * 1000,
          onStdout: (chunk) => {
            const detail = summarizeProcessChunk(chunk);
            const log = appendOpenClawInstallerLog(chunk);
            if (!detail) {
              updateOpenClawInstallerState({ log, openClawVersion });
              return;
            }
            updateOpenClawInstallerState({
              step: 'onboarding',
              message: 'Applying default OpenClaw setup…',
              detail,
              log,
              percent: 72,
              openClawVersion
            });
          },
          onStderr: (chunk) => {
            const detail = summarizeProcessChunk(chunk);
            const log = appendOpenClawInstallerLog(chunk);
            if (!detail) {
              updateOpenClawInstallerState({ log, openClawVersion });
              return;
            }
            updateOpenClawInstallerState({
              step: 'onboarding',
              message: 'Applying default OpenClaw setup…',
              detail,
              log,
              percent: 72,
              openClawVersion
            });
          }
        });

        if (onboardResult.exitCode !== 0) {
          throw new Error(onboardResult.stderr.trim() || onboardResult.stdout.trim() || 'OpenClaw onboarding failed.');
        }
      }

      updateOpenClawInstallerState({
        step: 'verifying',
        message: 'Verifying OpenClaw installation…',
        detail: 'Checking CLI health and final version.',
        percent: 92,
        openClawVersion
      });

      const verifyResult = await runProgramCommand(openClawCommand, ['--version'], getDefaultTerminalCwd(), 15000);
      if (verifyResult.exitCode !== 0) {
        throw new Error(verifyResult.stderr.trim() || 'OpenClaw verification failed.');
      }

      const verifiedVersion = verifyResult.stdout.trim().split(/\s+/).find((part) => /^v?\d+\./.test(part)) ?? (verifyResult.stdout.trim() || openClawVersion);
      const completionDetail = mode === 'update'
        ? 'Background update finished successfully.'
        : 'Background install finished with default QuickStart setup and daemon install.';

      updateOpenClawInstallerState({
        status: 'success',
        mode,
        step: 'completed',
        message: mode === 'update' ? 'OpenClaw CLI updated.' : 'OpenClaw installed and configured.',
        detail: completionDetail,
        log: appendOpenClawInstallerLog(`\n${completionDetail}\n`),
        percent: 100,
        finishedAt: Date.now(),
        openClawVersion: verifiedVersion
      });

      return buildOpenClawInstallerStatePayload();
    } catch (error) {
      const errorDetail = error instanceof Error ? error.message : 'OpenClaw installer failed unexpectedly.';
      updateOpenClawInstallerState({
        status: 'error',
        step: 'failed',
        message: mode === 'update' ? 'OpenClaw update failed.' : 'OpenClaw installation failed.',
        detail: errorDetail,
        log: appendOpenClawInstallerLog(`\n${errorDetail}\n`),
        percent: null,
        finishedAt: Date.now()
      });
      return buildOpenClawInstallerStatePayload();
    } finally {
      if (state.openClawInstaller.currentRunId === runId) {
        state.openClawInstaller.activePromise = null;
      }
    }
  })();

  state.openClawInstaller.activePromise = task;
  return buildOpenClawInstallerStatePayload();
}

function parseGitBranchHeader(headerLine) {
  const result = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0
  };

  if (!headerLine) return result;

  const normalized = headerLine.startsWith('## ') ? headerLine.slice(3).trim() : headerLine.trim();
  if (!normalized) return result;

  if (normalized.startsWith('No commits yet on ')) {
    result.branch = normalized.slice('No commits yet on '.length).trim() || null;
    return result;
  }

  if (normalized === 'HEAD (no branch)' || normalized.startsWith('HEAD (')) {
    result.branch = 'Detached HEAD';
    return result;
  }

  const trackingMatch = / \[(.+)\]$/.exec(normalized);
  const branchSegment = trackingMatch ? normalized.slice(0, trackingMatch.index) : normalized;

  if (branchSegment.includes('...')) {
    const [branch, upstream] = branchSegment.split('...');
    result.branch = branch?.trim() || null;
    result.upstream = upstream?.trim() || null;
  } else {
    result.branch = branchSegment.trim() || null;
  }

  const trackingInfo = trackingMatch?.[1]?.split(',').map((part) => part.trim()) ?? [];
  for (const part of trackingInfo) {
    const aheadMatch = /^ahead (\d+)$/.exec(part);
    if (aheadMatch) {
      result.ahead = Number(aheadMatch[1]);
      continue;
    }
    const behindMatch = /^behind (\d+)$/.exec(part);
    if (behindMatch) {
      result.behind = Number(behindMatch[1]);
    }
  }

  return result;
}

function classifyGitStatus(staged, unstaged) {
  if (staged === '?' && unstaged === '?') return 'untracked';
  if (staged === 'U' || unstaged === 'U') return 'unmerged';

  const code = staged !== ' ' && staged !== '?' ? staged : unstaged;
  if (code === 'A') return 'added';
  if (code === 'M') return 'modified';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  if (code === 'T') return 'typechange';
  return 'unknown';
}

function parseGitStatusOutput(stdout) {
  const lines = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  const branchInfo = lines[0]?.startsWith('## ') ? parseGitBranchHeader(lines[0]) : parseGitBranchHeader('');
  const statusEntries = [];

  for (const line of (lines[0]?.startsWith('## ') ? lines.slice(1) : lines)) {
    if (line.length < 3) continue;
    const staged = line[0];
    const unstaged = line[1];
    const payload = line.slice(3).trim();
    if (!payload) continue;

    let originalPath = null;
    let filePath = payload;
    if (payload.includes(' -> ')) {
      const [fromPath, toPath] = payload.split(' -> ');
      originalPath = fromPath?.trim() || null;
      filePath = toPath?.trim() || payload;
    }

    statusEntries.push({
      path: filePath,
      originalPath,
      staged,
      unstaged,
      kind: classifyGitStatus(staged, unstaged)
    });
  }

  return {
    ...branchInfo,
    statusEntries
  };
}

function parseGitLogOutput(stdout) {
  return stdout
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, author, subject, relativeTime] = line.split('\t');
      return {
        sha: sha || '',
        shortSha: shortSha || '',
        author: author || '',
        subject: subject || '',
        relativeTime: relativeTime || ''
      };
    })
    .filter((entry) => entry.sha && entry.shortSha);
}

async function inspectGitRepository(workspaceRoot) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  const baseSnapshot = {
    workspaceRoot: resolvedWorkspaceRoot,
    gitRoot: null,
    branch: null,
    upstream: null,
    headShortSha: null,
    ahead: 0,
    behind: 0,
    isClean: true,
    changedFiles: 0,
    stagedFiles: 0,
    unstagedFiles: 0,
    untrackedFiles: 0,
    statusEntries: [],
    recentCommits: [],
    error: null
  };

  let topLevelResult;
  try {
    topLevelResult = await runProgramCommand('git', ['rev-parse', '--show-toplevel'], resolvedWorkspaceRoot, 8000, 4000);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return {
        ...baseSnapshot,
        error: 'Git is not installed or not available in PATH.'
      };
    }
    return {
      ...baseSnapshot,
      error: error instanceof Error ? error.message : 'Unable to inspect Git repository.'
    };
  }

  if (topLevelResult.exitCode !== 0) {
    return baseSnapshot;
  }

  const gitRoot = normalizeCapturedOutput(topLevelResult.stdout) || resolvedWorkspaceRoot;

  const statusResult = await runProgramCommand('git', ['status', '--porcelain=1', '-b'], resolvedWorkspaceRoot, 10000, 64000);
  if (statusResult.exitCode !== 0) {
    return {
      ...baseSnapshot,
      gitRoot,
      error: normalizeCapturedOutput(statusResult.stderr) || 'Unable to read Git status.'
    };
  }

  const parsedStatus = parseGitStatusOutput(statusResult.stdout);
  const stagedFiles = parsedStatus.statusEntries.filter((entry) => entry.staged !== ' ' && entry.staged !== '?').length;
  const unstagedFiles = parsedStatus.statusEntries.filter((entry) => entry.unstaged !== ' ' && entry.unstaged !== '?').length;
  const untrackedFiles = parsedStatus.statusEntries.filter((entry) => entry.kind === 'untracked').length;

  let headShortSha = null;
  try {
    const headResult = await runProgramCommand('git', ['rev-parse', '--short', 'HEAD'], resolvedWorkspaceRoot, 5000, 200);
    if (headResult.exitCode === 0) {
      headShortSha = normalizeCapturedOutput(headResult.stdout) || null;
    }
  } catch {
    // ignore missing HEAD for empty repositories
  }

  let recentCommits = [];
  try {
    const logResult = await runProgramCommand('git', ['log', '--max-count=5', '--pretty=format:%H%x09%h%x09%an%x09%s%x09%cr'], resolvedWorkspaceRoot, 10000, 12000);
    if (logResult.exitCode === 0) {
      recentCommits = parseGitLogOutput(logResult.stdout);
    }
  } catch {
    // ignore empty repositories
  }

  return {
    ...baseSnapshot,
    gitRoot,
    branch: parsedStatus.branch,
    upstream: parsedStatus.upstream,
    headShortSha,
    ahead: parsedStatus.ahead,
    behind: parsedStatus.behind,
    isClean: parsedStatus.statusEntries.length === 0,
    changedFiles: parsedStatus.statusEntries.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    statusEntries: parsedStatus.statusEntries,
    recentCommits
  };
}

async function collectGitRepositories() {
  const workspaceRoots = state.workspaceRoots.length ? state.workspaceRoots : (state.workspaceRoot ? [state.workspaceRoot] : []);
  if (!workspaceRoots.length) return [];
  return await Promise.all(workspaceRoots.map((rootPath) => inspectGitRepository(rootPath)));
}

async function ensureGitRepository(workspaceRoot) {
  const snapshot = await inspectGitRepository(workspaceRoot);
  if (!snapshot.gitRoot) {
    throw new Error('Workspace is not inside a Git repository.');
  }
  if (snapshot.error) {
    throw new Error(snapshot.error);
  }
  return snapshot;
}

function resolveGitFilePath(workspaceRoot, filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Git file path is required');
  }

  if (path.isAbsolute(filePath)) {
    return resolveWithinWorkspace(filePath);
  }

  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  return resolveWithinWorkspace(path.join(resolvedWorkspaceRoot, filePath));
}

async function runGitCommandForWorkspace(workspaceRoot, args, options = {}) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxOutputChars = options.maxOutputChars ?? 24000;
  return await runProgramCommand('git', args, resolvedWorkspaceRoot, timeoutMs, maxOutputChars);
}

async function readGitDiff(workspaceRoot, filePath, staged = false) {
  const repository = await ensureGitRepository(workspaceRoot);
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  const resolvedFilePath = resolveGitFilePath(resolvedWorkspaceRoot, filePath);
  const relativePath = path.relative(resolvedWorkspaceRoot, resolvedFilePath).replace(/\\/g, '/');
  const diffArgs = ['diff', '--no-ext-diff', '--', relativePath];
  if (staged) {
    diffArgs.splice(1, 0, '--cached');
  }

  const diffResult = await runGitCommandForWorkspace(resolvedWorkspaceRoot, diffArgs, {
    timeoutMs: 15000,
    maxOutputChars: 120000
  });

  if (diffResult.exitCode !== 0) {
    throw new Error(normalizeCapturedOutput(diffResult.stderr) || 'Unable to read Git diff.');
  }

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    gitRoot: repository.gitRoot,
    path: relativePath,
    staged,
    diff: diffResult.stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  };
}

async function stageGitFile(workspaceRoot, filePath) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  const resolvedFilePath = resolveGitFilePath(resolvedWorkspaceRoot, filePath);
  const relativePath = path.relative(resolvedWorkspaceRoot, resolvedFilePath).replace(/\\/g, '/');
  const result = await runGitCommandForWorkspace(resolvedWorkspaceRoot, ['add', '--', relativePath]);
  if (result.exitCode !== 0) {
    throw new Error(normalizeCapturedOutput(result.stderr) || 'Unable to stage file.');
  }
  emitWorkspaceEvent({ type: 'changed', eventType: 'change', path: resolvedFilePath });
  return await inspectGitRepository(resolvedWorkspaceRoot);
}

async function unstageGitFile(workspaceRoot, filePath) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  const resolvedFilePath = resolveGitFilePath(resolvedWorkspaceRoot, filePath);
  const relativePath = path.relative(resolvedWorkspaceRoot, resolvedFilePath).replace(/\\/g, '/');
  const result = await runGitCommandForWorkspace(resolvedWorkspaceRoot, ['reset', 'HEAD', '--', relativePath]);
  if (result.exitCode !== 0) {
    throw new Error(normalizeCapturedOutput(result.stderr) || 'Unable to unstage file.');
  }
  emitWorkspaceEvent({ type: 'changed', eventType: 'change', path: resolvedFilePath });
  return await inspectGitRepository(resolvedWorkspaceRoot);
}

async function discardGitFile(workspaceRoot, filePath) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  const resolvedFilePath = resolveGitFilePath(resolvedWorkspaceRoot, filePath);
  const relativePath = path.relative(resolvedWorkspaceRoot, resolvedFilePath).replace(/\\/g, '/');
  const repository = await ensureGitRepository(resolvedWorkspaceRoot);
  const matchingEntry = repository.statusEntries.find((entry) => entry.path === relativePath);

  if (matchingEntry?.kind === 'untracked') {
    await fsp.unlink(resolvedFilePath);
  } else {
    const result = await runGitCommandForWorkspace(resolvedWorkspaceRoot, ['checkout', '--', relativePath]);
    if (result.exitCode !== 0) {
      throw new Error(normalizeCapturedOutput(result.stderr) || 'Unable to discard changes.');
    }
  }

  emitWorkspaceEvent({ type: 'changed', eventType: 'change', path: resolvedFilePath });
  return await inspectGitRepository(resolvedWorkspaceRoot);
}

async function commitGitChanges(workspaceRoot, message) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot);
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Commit message is required.');
  }

  const result = await runGitCommandForWorkspace(resolvedWorkspaceRoot, ['commit', '-m', message.trim()], {
    timeoutMs: 30000,
    maxOutputChars: 40000
  });

  if (result.exitCode !== 0) {
    throw new Error(normalizeCapturedOutput(result.stderr || result.stdout) || 'Unable to create commit.');
  }

  emitWorkspaceEvent({ type: 'changed', eventType: 'change', path: resolvedWorkspaceRoot });
  return {
    repository: await inspectGitRepository(resolvedWorkspaceRoot),
    output: normalizeCapturedOutput(result.stdout)
  };
}

async function runTerminalCommandWithCapture(command, timeoutMs = 20000, sessionId) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('Command is required');
  }

  let session = getTerminalSession(sessionId ?? state.terminal.activeSessionId);
  if (!session) {
    session = createTerminalSession();
  }

  if (!session.proc || !session.connected) {
    attachTerminalProcess(session);
    emitTerminalState();
  }

  if (session.capture) {
    throw new Error('Active terminal session is busy');
  }

  state.terminal.activeSessionId = session.id;
  emitTerminalState();

  const captureId = state.terminal.nextCaptureId++;
  const startMarker = `__ASSISTANT_DESK_CAPTURE_START_${captureId}__`;
  const endMarker = `__ASSISTANT_DESK_CAPTURE_END_${captureId}__`;
  const normalizedCommand = command.endsWith('\n') ? command : `${command}\n`;

  return await new Promise((resolve, reject) => {
    session.capture = {
      startMarker,
      endMarker,
      started: false,
      pending: '',
      captured: '',
      maxOutputChars: 16000,
      timer: setTimeout(() => {
        const current = getTerminalSession(session.id);
        if (!current?.capture) return;
        current.proc?.write('\x03');
        finalizeTerminalCapture(current, {
          stdout: normalizeCapturedOutput(current.capture.captured + current.capture.pending),
          stderr: 'Command timed out.',
          exitCode: null,
          signal: 'SIGINT',
          cwd: current.cwd,
          sessionId: current.id
        });
      }, Math.max(1000, timeoutMs)),
      resolve,
      reject
    };

    try {
      session.proc.write(`printf '%s\\n' '${startMarker}'\n`);
      session.proc.write(normalizedCommand);
      session.proc.write(`__assistant_desk_exit_code=$?\nprintf '\\n%s:%s\\n' '${endMarker}' "$__assistant_desk_exit_code"\nunset __assistant_desk_exit_code\n`);
    } catch (error) {
      rejectTerminalCapture(session, error);
    }
  });
}

function setActiveTerminalSession(sessionId) {
  const session = getTerminalSession(sessionId);
  if (!session) return;
  state.terminal.activeSessionId = sessionId;
  emitTerminalState();
}

function resolveWithinWorkspace(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('Invalid workspace path');
  }
  const workspaceRoots = state.workspaceRoots.length ? state.workspaceRoots : (state.workspaceRoot ? [state.workspaceRoot] : []);
  if (!workspaceRoots.length) throw new Error('No workspace selected');

  let resolved;
  if (path.isAbsolute(targetPath)) {
    resolved = path.resolve(targetPath);
  } else {
    if (!state.workspaceRoot) throw new Error('No active workspace selected');
    resolved = path.resolve(state.workspaceRoot, targetPath);
  }

  const allowedRoot = [...workspaceRoots]
    .sort((a, b) => b.length - a.length)
    .find((root) => resolved === root || resolved.startsWith(root + path.sep));

  if (!allowedRoot) throw new Error('Path denied (outside opened workspaces)');
  return resolved;
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function copyWorkspaceEntryToClipboard(targetPath) {
  const resolved = resolveWithinWorkspace(targetPath);
  clipboard.writeText(resolved);

  if (process.platform !== 'darwin') {
    return;
  }

  const appleScriptPath = escapeAppleScriptString(resolved);
  const script = `set the clipboard to (POSIX file "${appleScriptPath}")`;
  const result = await runProgramCommand('/usr/bin/osascript', ['-e', script], path.dirname(resolved), 10000, 4000);
  if (result.exitCode !== 0) {
    const detail = normalizeCapturedOutput(result.stderr) || normalizeCapturedOutput(result.stdout);
    throw new Error(detail || 'Unable to copy the selected file to the macOS clipboard.');
  }
}

async function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.inspiration.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fsp.writeFile(tmp, contents, 'utf8');
  await fsp.rename(tmp, filePath);
}

function assertSiblingPaths(sourcePath, destinationPath) {
  if (sourcePath === destinationPath) {
    throw new Error('Source and destination must be different');
  }
}

function detectBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isControl = byte < 7 || (byte > 13 && byte < 32);
    if (isControl) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function toAgentProjectKey(rootPath) {
  const resolved = path.resolve(rootPath);
  return resolved.replace(/[\\/]+/g, '-');
}

function withTilde(targetPath) {
  const home = os.homedir();
  if (!targetPath.startsWith(home)) return targetPath;
  return `~${targetPath.slice(home.length)}`;
}

function normalizeVersionString(value) {
  return String(value || '').trim().replace(/^v/i, '').split('-')[0];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersionString(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersionString(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function getAppInfo() {
  return {
    name: 'Inspiration',
    version: app.getVersion(),
    displayVersion: app.isPackaged ? app.getVersion() : `${app.getVersion()}-dev`,
    releaseVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    downloadsPath: app.getPath('downloads')
  };
}

function requestJson(url, redirectsRemaining = 4) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `Inspiration/${app.getVersion()}`
      }
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location && redirectsRemaining > 0) {
        response.resume();
        resolve(requestJson(location, redirectsRemaining - 1));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Release check failed (${statusCode}): ${body.trim() || 'Unexpected response'}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(UPDATE_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Release check timed out.'));
    });
    request.on('error', reject);
  });
}

function pickReleaseAsset(assets, arch) {
  const normalizedArch = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch;
  const candidates = (Array.isArray(assets) ? assets : [])
    .map((asset) => {
      const name = String(asset?.name || '');
      const lower = name.toLowerCase();
      if (!name || lower.endsWith('.blockmap')) return null;
      const extensionScore = lower.endsWith('.dmg') ? 30 : lower.endsWith('.zip') ? 20 : 0;
      if (!extensionScore) return null;
      let archScore = 0;
      if (lower.includes(`-${normalizedArch}.`)) {
        archScore = 50;
      } else if (lower.includes('-universal.')) {
        archScore = 35;
      }
      const brandScore = lower.includes('inspiration') ? 10 : lower.includes('assistant desk') || lower.includes('assistant-desk') ? 5 : 0;
      if (!archScore && !brandScore) return null;
      return {
        id: asset.id,
        name,
        url: asset.browser_download_url,
        size: typeof asset.size === 'number' ? asset.size : null,
        contentType: typeof asset.content_type === 'string' ? asset.content_type : null,
        score: archScore + extensionScore + brandScore
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return candidates[0] ?? null;
}

async function fetchLatestReleaseSummary() {
  const release = await requestJson(UPDATE_RELEASE_API_URL);
  const currentVersion = app.getVersion();
  const latestTag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const latestVersion = normalizeVersionString(latestTag);
  const asset = pickReleaseAsset(release.assets, process.arch);
  const comparison = latestVersion ? compareVersions(latestVersion, currentVersion) : 0;
  const status = comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current';

  return {
    currentVersion,
    latestVersion: latestVersion || currentVersion,
    latestTag: latestTag || `v${currentVersion}`,
    status,
    releaseName: typeof release.name === 'string' && release.name.trim() ? release.name.trim() : latestTag || `v${currentVersion}`,
    htmlUrl: typeof release.html_url === 'string' ? release.html_url : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    body: typeof release.body === 'string' ? release.body : '',
    asset
  };
}

async function createUniqueDownloadTarget(fileName) {
  const downloadsDir = path.join(app.getPath('downloads'), UPDATE_DOWNLOADS_SUBDIR);
  await fsp.mkdir(downloadsDir, { recursive: true });

  const parsed = path.parse(fileName);
  let candidate = path.join(downloadsDir, fileName);
  let suffix = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(downloadsDir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

function downloadReleaseAsset(asset, destinationPath) {
  return new Promise((resolve, reject) => {
    const tmpPath = `${destinationPath}.download`;
    let settled = false;

    const cleanup = async () => {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // ignore
      }
    };

    const finalizeError = async (error) => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(error);
    };

    const request = https.get(asset.url, {
      headers: {
        'Accept': 'application/octet-stream',
        'User-Agent': `Inspiration/${app.getVersion()}`
      }
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        downloadReleaseAsset({ ...asset, url: location }, destinationPath).then(resolve).catch(reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          void finalizeError(new Error(`Download failed (${statusCode}): ${body.trim() || 'Unexpected response'}`));
        });
        return;
      }

      const totalBytes = Number.parseInt(String(response.headers['content-length'] || ''), 10);
      let receivedBytes = 0;
      const fileStream = fs.createWriteStream(tmpPath);

      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        const percent = Number.isFinite(totalBytes) && totalBytes > 0
          ? Math.min(100, Math.round((receivedBytes / totalBytes) * 1000) / 10)
          : null;
        emitAppUpdateEvent({
          type: 'download-progress',
          receivedBytes,
          totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
          percent,
          fileName: asset.name
        });
      });

      fileStream.on('error', (error) => {
        response.destroy();
        void finalizeError(error);
      });

      response.on('error', (error) => {
        fileStream.destroy(error);
      });

      fileStream.on('finish', async () => {
        if (settled) return;
        settled = true;
        fileStream.close(async () => {
          try {
            await fsp.rename(tmpPath, destinationPath);
            resolve({
              filePath: destinationPath,
              totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : receivedBytes
            });
          } catch (error) {
            await cleanup();
            reject(error);
          }
        });
      });

      response.pipe(fileStream);
    });

    request.setTimeout(UPDATE_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Download timed out.'));
    });

    request.on('error', (error) => {
      void finalizeError(error);
    });
  });
}

async function downloadLatestReleaseAsset() {
  if (state.updater.activeDownload) {
    throw new Error('A release download is already in progress.');
  }

  const release = await fetchLatestReleaseSummary();
  if (!release.asset) {
    throw new Error(`No compatible installer was found for ${process.arch}.`);
  }
  if (release.status !== 'available') {
    throw new Error('No newer release is available.');
  }

  const destinationPath = await createUniqueDownloadTarget(release.asset.name);
  state.updater.activeDownload = { fileName: release.asset.name, destinationPath };
  emitAppUpdateEvent({ type: 'download-start', fileName: release.asset.name, destinationPath });

  try {
    const result = await downloadReleaseAsset(release.asset, destinationPath);
    const openError = await shell.openPath(result.filePath);
    shell.showItemInFolder(result.filePath);
    emitAppUpdateEvent({
      type: 'download-complete',
      filePath: result.filePath,
      fileName: release.asset.name,
      totalBytes: result.totalBytes,
      openError: openError || null
    });
    return {
      ...release,
      downloadedFilePath: result.filePath,
      openError: openError || null
    };
  } finally {
    state.updater.activeDownload = null;
  }
}

async function readTextPreview(filePath, maxLines = 24) {
  const contents = await fsp.readFile(filePath, 'utf8');
  const normalized = contents.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  return {
    preview: lines.slice(0, maxLines).join('\n').trim(),
    lineCount: lines.length
  };
}

async function buildAgentMemoryFileItem(filePath, scope, kind, rootPath = null) {
  const stat = await fsp.stat(filePath);
  const { preview, lineCount } = await readTextPreview(filePath);
  return {
    id: `${scope}:${kind}:${filePath}`,
    path: filePath,
    displayPath: withTilde(filePath),
    relativePath: rootPath ? path.relative(rootPath, filePath).replace(/\\/g, '/') : path.basename(filePath),
    name: path.basename(filePath),
    scope,
    kind,
    lineCount,
    preview,
    updatedAt: stat.mtimeMs,
    size: stat.size
  };
}

async function collectMarkdownFilesRecursively(baseDir, scope, kind, maxDepth = 5) {
  const items = [];
  if (!(await pathExists(baseDir))) return items;

  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      items.push(await buildAgentMemoryFileItem(nextPath, scope, kind, baseDir));
    }
  }

  await walk(baseDir, 0);
  items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return items;
}

async function inspectAgentMemory(workspaceRoot) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot || state.workspaceRoot);
  const instructionFiles = [];
  const autoMemoryFiles = [];
  const notices = [];
  const homeDir = os.homedir();
  const userAgentDir = path.join(homeDir, '.inspiration');
  const projectKey = toAgentProjectKey(resolvedWorkspaceRoot);
  const autoMemoryRoot = path.join(userAgentDir, 'projects', projectKey, 'memory');
  const workspaceCandidates = [
    { filePath: path.join(resolvedWorkspaceRoot, 'AGENT.md'), scope: 'project', kind: 'agent' },
    { filePath: path.join(resolvedWorkspaceRoot, 'AGENT.local.md'), scope: 'project', kind: 'local' },
    { filePath: path.join(resolvedWorkspaceRoot, '.inspiration', 'AGENT.md'), scope: 'project', kind: 'agent' }
  ];

  for (const candidate of workspaceCandidates) {
    if (!(await pathExists(candidate.filePath))) continue;
    instructionFiles.push(await buildAgentMemoryFileItem(candidate.filePath, candidate.scope, candidate.kind, resolvedWorkspaceRoot));
  }

  const projectRulesDir = path.join(resolvedWorkspaceRoot, '.inspiration', 'rules');
  instructionFiles.push(...await collectMarkdownFilesRecursively(projectRulesDir, 'project', 'rule'));

  const userAgentFile = path.join(userAgentDir, 'AGENT.md');
  if (await pathExists(userAgentFile)) {
    instructionFiles.push(await buildAgentMemoryFileItem(userAgentFile, 'user', 'agent', userAgentDir));
  }

  const userRulesDir = path.join(userAgentDir, 'rules');
  instructionFiles.push(...await collectMarkdownFilesRecursively(userRulesDir, 'user', 'rule'));

  let autoMemoryEnabled = true;
  const localSettingsPath = path.join(resolvedWorkspaceRoot, '.inspiration', 'settings.local.json');
  if (await pathExists(localSettingsPath)) {
    try {
      const raw = await fsp.readFile(localSettingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.autoMemoryEnabled === 'boolean') {
        autoMemoryEnabled = parsed.autoMemoryEnabled;
      }
    } catch {
      notices.push('Unable to parse .inspiration/settings.local.json');
    }
  }

  if (await pathExists(autoMemoryRoot)) {
    autoMemoryFiles.push(...await collectMarkdownFilesRecursively(autoMemoryRoot, 'auto', 'memory'));
  } else {
    notices.push('Auto memory folder has not been created for this workspace yet');
  }

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    projectKey,
    autoMemoryEnabled,
    autoMemoryRoot: withTilde(autoMemoryRoot),
    instructionFiles,
    autoMemoryFiles,
    notices
  };
}

function resolveAgentAccessiblePath(targetPath, workspaceRoot) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('Invalid agent memory path');
  }

  const resolved = path.resolve(targetPath);
  const homeAgentRoot = path.join(os.homedir(), '.inspiration');
  const allowedRoots = [homeAgentRoot];

  try {
    const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot || state.workspaceRoot);
    allowedRoots.push(resolvedWorkspaceRoot);
  } catch {
    // Ignore if no workspace is active; ~/.inspiration is still allowed.
  }

  const allowedRoot = allowedRoots
    .sort((a, b) => b.length - a.length)
    .find((root) => resolved === root || resolved.startsWith(root + path.sep));

  if (!allowedRoot) {
    throw new Error('Path denied (outside agent-accessible locations)');
  }

  return resolved;
}

function registerIpc() {
  ipcMain.handle('app:getInfo', async () => getAppInfo());
  ipcMain.handle('app:checkForUpdates', async () => await fetchLatestReleaseSummary());
  ipcMain.handle('app:downloadLatestUpdate', async () => await downloadLatestReleaseAsset());
  ipcMain.handle('openclaw-installer:getState', async () => buildOpenClawInstallerStatePayload());
  ipcMain.handle('openclaw-installer:start', async (_ev, options) => await startOpenClawInstaller(options || {}));
  ipcMain.handle('workspace:getRoot', async () => state.workspaceRoot);
  ipcMain.handle('workspace:getRoots', async () => [...state.workspaceRoots]);

  ipcMain.handle('workspace:setActiveRoot', async (_ev, { rootPath }) => {
    setActiveWorkspaceRoot(rootPath);
    return state.workspaceRoot;
  });

  ipcMain.handle('workspace:removeRoot', async (_ev, { rootPath }) => {
    removeWorkspaceRoot(rootPath);
    return {
      workspaceRoot: state.workspaceRoot,
      workspaceRoots: [...state.workspaceRoots]
    };
  });

  ipcMain.handle('workspace:setRoots', async (_ev, { rootPaths }) => {
    return reorderWorkspaceRoots(rootPaths);
  });

  ipcMain.handle('workspace:selectFolder', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths?.[0]) return null;
    addWorkspaceRoot(r.filePaths[0], { makeActive: true });
    return state.workspaceRoot;
  });

  ipcMain.handle('terminal:getState', async () => ({
    ...buildTerminalStatePayload()
  }));

  ipcMain.handle('terminal:createSession', async (_ev, { cwd, title }) => {
    const session = createTerminalSession({ cwd, title });
    return session.id;
  });

  ipcMain.handle('terminal:setActiveSession', async (_ev, { sessionId }) => {
    setActiveTerminalSession(sessionId);
  });

  ipcMain.handle('terminal:closeSession', async (_ev, { sessionId }) => {
    if (state.terminal.sessions.size <= 1) {
      resetTerminalSessions();
      return;
    }
    destroyTerminalSession(sessionId, { remove: true });
  });

  ipcMain.handle('terminal:write', async (_ev, { data, sessionId, source }) => {
    writeTerminalInput(data, sessionId, source);
  });

  ipcMain.handle('terminal:resize', async (_ev, { cols, rows }) => {
    resizeTerminal(cols, rows);
  });

  ipcMain.handle('terminal:restart', async (_ev, { sessionId }) => {
    restartTerminalSession(sessionId ?? state.terminal.activeSessionId);
  });

  ipcMain.handle('terminal:interrupt', async (_ev, { sessionId }) => {
    interruptTerminalSession(sessionId ?? state.terminal.activeSessionId);
  });

  ipcMain.handle('terminal:execWorkspaceCommand', async (_ev, { command, timeoutMs }) => {
    return await runWorkspaceCommand(command, timeoutMs);
  });

  ipcMain.handle('terminal:runCommandWithCapture', async (_ev, { command, timeoutMs, sessionId }) => {
    return await runTerminalCommandWithCapture(command, timeoutMs, sessionId);
  });

  ipcMain.handle('git:getRepositories', async () => {
    return await collectGitRepositories();
  });

  ipcMain.handle('git:getRepository', async (_ev, { workspaceRoot }) => {
    return await inspectGitRepository(workspaceRoot);
  });

  ipcMain.handle('git:getDiff', async (_ev, { workspaceRoot, filePath, staged }) => {
    return await readGitDiff(workspaceRoot, filePath, Boolean(staged));
  });

  ipcMain.handle('git:stageFile', async (_ev, { workspaceRoot, filePath }) => {
    return await stageGitFile(workspaceRoot, filePath);
  });

  ipcMain.handle('git:unstageFile', async (_ev, { workspaceRoot, filePath }) => {
    return await unstageGitFile(workspaceRoot, filePath);
  });

  ipcMain.handle('git:discardFile', async (_ev, { workspaceRoot, filePath }) => {
    return await discardGitFile(workspaceRoot, filePath);
  });

  ipcMain.handle('git:commit', async (_ev, { workspaceRoot, message }) => {
    return await commitGitChanges(workspaceRoot, message);
  });

  ipcMain.handle('fs:listWorkspaceDir', async (_ev, { dirPath }) => {
    const resolvedDir = resolveWithinWorkspace(dirPath);
    const entries = await fsp.readdir(resolvedDir, { withFileTypes: true });
    return entries.map((ent) => ({
      name: ent.name,
      path: path.join(resolvedDir, ent.name),
      kind: ent.isDirectory() ? 'dir' : 'file'
    }));
  });

  ipcMain.handle('fs:readWorkspaceTextFile', async (_ev, { filePath }) => {
    const resolved = resolveWithinWorkspace(filePath);
    const st = await fsp.stat(resolved);
    if (!st.isFile()) throw new Error('Not a file');
    return fsp.readFile(resolved, 'utf8');
  });

  ipcMain.handle('fs:readWorkspaceTextFileTail', async (_ev, { filePath, maxChars }) => {
    const resolved = resolveWithinWorkspace(filePath);
    const st = await fsp.stat(resolved);
    if (!st.isFile()) throw new Error('Not a file');

    const charLimit = Math.max(512, Number.isFinite(maxChars) ? Math.floor(maxChars) : 6000);
    const buffer = await fsp.readFile(resolved, 'utf8');
    return {
      contents: buffer.slice(-charLimit),
      size: st.size,
      mtimeMs: st.mtimeMs
    };
  });

  ipcMain.handle('fs:readWorkspaceFile', async (_ev, { filePath }) => {
    const resolved = resolveWithinWorkspace(filePath);
    const st = await fsp.stat(resolved);
    if (!st.isFile()) throw new Error('Not a file');

    const buffer = await fsp.readFile(resolved);
    const binary = detectBinary(buffer);
    const isPdf = path.extname(resolved).toLowerCase() === '.pdf';
    let readOnly = false;
    try {
      await fsp.access(resolved, fs.constants.W_OK);
    } catch {
      readOnly = true;
    }

    return {
      kind: binary ? 'binary' : 'text',
      contents: binary ? (isPdf ? buffer.toString('base64') : null) : buffer.toString('utf8'),
      contentsEncoding: binary && isPdf ? 'base64' : binary ? null : 'utf8',
      mimeType: isPdf ? 'application/pdf' : null,
      readOnly,
      size: st.size
    };
  });

  ipcMain.handle('fs:writeWorkspaceTextFile', async (_ev, { filePath, contents }) => {
    const resolved = resolveWithinWorkspace(filePath);
    await writeFileAtomic(resolved, contents);
    emitWorkspaceEvent({ type: 'changed', eventType: 'change', path: resolved });
  });

  ipcMain.handle('fs:createWorkspaceFile', async (_ev, { filePath, contents }) => {
    const resolved = resolveWithinWorkspace(filePath);
    if (await pathExists(resolved)) {
      throw new Error('File already exists');
    }
    await writeFileAtomic(resolved, typeof contents === 'string' ? contents : '');
    emitWorkspaceEvent({ type: 'changed', eventType: 'create', path: resolved });
  });

  ipcMain.handle('fs:createWorkspaceDir', async (_ev, { dirPath }) => {
    const resolved = resolveWithinWorkspace(dirPath);
    if (await pathExists(resolved)) {
      throw new Error('Folder already exists');
    }
    await fsp.mkdir(resolved, { recursive: false });
    emitWorkspaceEvent({ type: 'changed', eventType: 'create', path: resolved });
  });

  ipcMain.handle('fs:copyWorkspaceEntry', async (_ev, { sourcePath, destinationPath }) => {
    const resolvedSource = resolveWithinWorkspace(sourcePath);
    const resolvedDestination = resolveWithinWorkspace(destinationPath);
    assertSiblingPaths(resolvedSource, resolvedDestination);
    if (!(await pathExists(resolvedSource))) {
      throw new Error('Source path does not exist');
    }
    if (await pathExists(resolvedDestination)) {
      throw new Error('Destination already exists');
    }

    await fsp.mkdir(path.dirname(resolvedDestination), { recursive: true });
    await fsp.cp(resolvedSource, resolvedDestination, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    emitWorkspaceEvent({ type: 'changed', eventType: 'copy', path: resolvedDestination });
  });

  ipcMain.handle('fs:copyWorkspaceEntryToClipboard', async (_ev, { targetPath }) => {
    await copyWorkspaceEntryToClipboard(targetPath);
  });

  ipcMain.handle('fs:deleteWorkspaceEntry', async (_ev, { targetPath }) => {
    const resolved = resolveWithinWorkspace(targetPath);
    if (!(await pathExists(resolved))) {
      throw new Error('Path does not exist');
    }
    await fsp.rm(resolved, { recursive: true, force: false });
    emitWorkspaceEvent({ type: 'changed', eventType: 'delete', path: resolved });
  });

  ipcMain.handle('fs:openArbitraryTextFile', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: 'Code and Text',
          extensions: [
            'txt', 'md', 'mdx', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sass', 'less',
            'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'fish', 'py',
            'rb', 'php', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'go', 'rs', 'swift', 'sql', 'graphql',
            'gql', 'vue', 'svelte', 'astro', 'dart', 'lua', 'pl', 'r', 'scala', 'dockerfile'
          ]
        }
      ]
    });
    if (r.canceled || !r.filePaths?.[0]) return null;
    const pickedPath = r.filePaths[0];
    const contents = await fsp.readFile(pickedPath, 'utf8');
    return { path: pickedPath, contents };
  });

  ipcMain.handle('agent:getMemorySnapshot', async (_ev, { workspaceRoot }) => {
    return await inspectAgentMemory(workspaceRoot);
  });

  ipcMain.handle('agent:readMemoryFile', async (_ev, { filePath, workspaceRoot }) => {
    const resolved = resolveAgentAccessiblePath(filePath, workspaceRoot);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error('Not a file');
    return await fsp.readFile(resolved, 'utf8');
  });

  ipcMain.handle('agent:revealPath', async (_ev, { filePath, workspaceRoot }) => {
    const resolved = resolveAgentAccessiblePath(filePath, workspaceRoot);
    shell.showItemInFolder(resolved);
    return true;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      plugins: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const distIndexPath = path.join(__dirname, '..', 'dist', 'index.html');
  let fellBackToDist = false;

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level <= 1) {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
      return;
    }
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[window] did-fail-load', { errorCode, errorDescription, validatedURL });

    if (!fellBackToDist && devUrl && validatedURL === `${devUrl}/`) {
      fellBackToDist = true;
      console.warn('[window] dev server unavailable, falling back to dist/index.html');
      void win.loadFile(distIndexPath);
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] render-process-gone', details);
  });

  win.webContents.on('unresponsive', () => {
    console.error('[window] unresponsive');
  });

  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(distIndexPath);
  }
}

app.whenReady().then(async () => {
  loadConfig();
  await syncStarterWorkspaceState();
  watchWorkspaceRoots(state.workspaceRoots);
  registerIpc();
  Menu.setApplicationMenu(buildApplicationMenu());

  await startCore();
  ensureTerminalSession();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeWorkspaceWatchers();
  for (const session of getTerminalSessions()) {
    destroyTerminalSession(session.id, { remove: true });
  }
  if (coreProc) coreProc.kill();
});
