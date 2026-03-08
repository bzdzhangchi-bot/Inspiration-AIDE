const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
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

function startCore() {
  if (process.env.ASSISTANT_DESK_NO_CORE === '1') {
    console.log('[core] skipped (ASSISTANT_DESK_NO_CORE=1)');
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
    const parsedRoots = normalizeWorkspaceRoots(parsed?.workspaceRoots);
    const fallbackRoot = typeof parsed?.workspaceRoot === 'string' && parsed.workspaceRoot.length
      ? path.resolve(parsed.workspaceRoot)
      : null;
    state.workspaceRoots = parsedRoots.length ? parsedRoots : fallbackRoot ? [fallbackRoot] : [];
    state.workspaceRoot = state.workspaceRoots.includes(fallbackRoot) ? fallbackRoot : state.workspaceRoots[0] ?? fallbackRoot;
  } catch {
    // ignore
  }
}

function saveConfig() {
  const next = JSON.stringify({ workspaceRoot: state.workspaceRoot, workspaceRoots: state.workspaceRoots }, null, 2);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(), next, 'utf8');
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

async function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.assistant-desk.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fsp.writeFile(tmp, contents, 'utf8');
  await fsp.rename(tmp, filePath);
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

function toClaudeProjectKey(rootPath) {
  const resolved = path.resolve(rootPath);
  return resolved.replace(/[\\/]+/g, '-');
}

function withTilde(targetPath) {
  const home = os.homedir();
  if (!targetPath.startsWith(home)) return targetPath;
  return `~${targetPath.slice(home.length)}`;
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

async function buildClaudeMemoryFileItem(filePath, scope, kind, rootPath = null) {
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
      items.push(await buildClaudeMemoryFileItem(nextPath, scope, kind, baseDir));
    }
  }

  await walk(baseDir, 0);
  items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return items;
}

async function inspectClaudeMemory(workspaceRoot) {
  const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot || state.workspaceRoot);
  const instructionFiles = [];
  const autoMemoryFiles = [];
  const notices = [];
  const homeDir = os.homedir();
  const userClaudeDir = path.join(homeDir, '.claude');
  const projectKey = toClaudeProjectKey(resolvedWorkspaceRoot);
  const autoMemoryRoot = path.join(userClaudeDir, 'projects', projectKey, 'memory');
  const workspaceCandidates = [
    { filePath: path.join(resolvedWorkspaceRoot, 'CLAUDE.md'), scope: 'project', kind: 'claude' },
    { filePath: path.join(resolvedWorkspaceRoot, 'CLAUDE.local.md'), scope: 'project', kind: 'local' },
    { filePath: path.join(resolvedWorkspaceRoot, '.claude', 'CLAUDE.md'), scope: 'project', kind: 'claude' }
  ];

  for (const candidate of workspaceCandidates) {
    if (!(await pathExists(candidate.filePath))) continue;
    instructionFiles.push(await buildClaudeMemoryFileItem(candidate.filePath, candidate.scope, candidate.kind, resolvedWorkspaceRoot));
  }

  const projectRulesDir = path.join(resolvedWorkspaceRoot, '.claude', 'rules');
  instructionFiles.push(...await collectMarkdownFilesRecursively(projectRulesDir, 'project', 'rule'));

  const userClaudeFile = path.join(userClaudeDir, 'CLAUDE.md');
  if (await pathExists(userClaudeFile)) {
    instructionFiles.push(await buildClaudeMemoryFileItem(userClaudeFile, 'user', 'claude', userClaudeDir));
  }

  const userRulesDir = path.join(userClaudeDir, 'rules');
  instructionFiles.push(...await collectMarkdownFilesRecursively(userRulesDir, 'user', 'rule'));

  let autoMemoryEnabled = true;
  const localSettingsPath = path.join(resolvedWorkspaceRoot, '.claude', 'settings.local.json');
  if (await pathExists(localSettingsPath)) {
    try {
      const raw = await fsp.readFile(localSettingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.autoMemoryEnabled === 'boolean') {
        autoMemoryEnabled = parsed.autoMemoryEnabled;
      }
    } catch {
      notices.push('Unable to parse .claude/settings.local.json');
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

function resolveClaudeAccessiblePath(targetPath, workspaceRoot) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('Invalid Claude memory path');
  }

  const resolved = path.resolve(targetPath);
  const homeClaudeRoot = path.join(os.homedir(), '.claude');
  const allowedRoots = [homeClaudeRoot];

  try {
    const resolvedWorkspaceRoot = resolveWithinWorkspace(workspaceRoot || state.workspaceRoot);
    allowedRoots.push(resolvedWorkspaceRoot);
  } catch {
    // Ignore if no workspace is active; ~/.claude is still allowed.
  }

  const allowedRoot = allowedRoots
    .sort((a, b) => b.length - a.length)
    .find((root) => resolved === root || resolved.startsWith(root + path.sep));

  if (!allowedRoot) {
    throw new Error('Path denied (outside Claude-accessible locations)');
  }

  return resolved;
}

function registerIpc() {
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

  ipcMain.handle('claude:getMemorySnapshot', async (_ev, { workspaceRoot }) => {
    return await inspectClaudeMemory(workspaceRoot);
  });

  ipcMain.handle('claude:readMemoryFile', async (_ev, { filePath, workspaceRoot }) => {
    const resolved = resolveClaudeAccessiblePath(filePath, workspaceRoot);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error('Not a file');
    return await fsp.readFile(resolved, 'utf8');
  });

  ipcMain.handle('claude:revealPath', async (_ev, { filePath, workspaceRoot }) => {
    const resolved = resolveClaudeAccessiblePath(filePath, workspaceRoot);
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

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level <= 1) {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
      return;
    }
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[window] did-fail-load', { errorCode, errorDescription, validatedURL });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] render-process-gone', details);
  });

  win.webContents.on('unresponsive', () => {
    console.error('[window] unresponsive');
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  loadConfig();
  watchWorkspaceRoots(state.workspaceRoots);
  registerIpc();

  startCore();
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
