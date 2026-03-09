import { fsClient } from './fsClient';
import { terminalClient, type TerminalEvent, type TerminalState } from './terminalClient';

export type ClaudeCodeRuntimeEvent = {
  kind: 'status' | 'plan' | 'question' | 'approval' | 'diff' | 'message' | 'tool' | 'lifecycle';
  text: string;
  createdAt: number;
};

type ClaudeRuntimeResumeInfo = {
  restoredFromStorage: boolean;
  restoredAt: number | null;
  snapshotSavedAt: number | null;
  snapshotSessionId: number | null;
};

export type ClaudeCodeRuntimeState = {
  sessionId: number | null;
  workspaceRoot: string | null;
  connected: boolean;
  running: boolean;
  rawTail: string;
  debugLogPath: string | null;
  debugLogTail: string;
  pendingQuestion: string | null;
  pendingApproval: string | null;
  lastPlan: string[];
  diffDetected: boolean;
  events: ClaudeCodeRuntimeEvent[];
  resumeInfo: ClaudeRuntimeResumeInfo;
  capabilities: {
    interactiveStructuredOutput: boolean;
    printStructuredOutput: boolean;
    source: string;
  };
};

const CLAUDE_SESSION_TITLE = 'Claude Code';
const MAX_EVENTS = 24;
const MAX_RAW_TAIL = 6000;
const MAX_DEBUG_TAIL = 6000;
const DEBUG_POLL_INTERVAL_ACTIVE_MS = 1800;
const DEBUG_POLL_INTERVAL_IDLE_MS = 5000;
const DEBUG_DELTA_FALLBACK_CHARS = 1600;
const PLAN_BULLET_PATTERN = /^(?:[-*]|\d+\.)\s+/;
const PLAN_START_PATTERN = /\b(plan|implementation plan|proposed plan|approach options|execution plans?)\b/i;
const APPROVAL_PATTERN = /\b(approve|approval|permission|allow|proceed|continue\?)\b/i;
const QUESTION_PATTERN = /\?|\b(which|choose|select|pick|enter|provide|what should)\b/i;
const DIFF_PATTERN = /^(diff --git|@@ |\+\+\+ |--- )/;
const STORAGE_PREFIX = 'claudeCodeRuntime:';
const DEBUG_LOG_RELATIVE_PATH = '.claude/inspiration-debug.log';
const DEBUG_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T[^\s]+\s+\[(?:DEBUG|WARN|ERROR)\]\s*/;
const DEBUG_APPROVAL_PATTERN = /\b(approve|approval|permission|allow rule|denied|disallowed|consent)\b/i;
const DEBUG_TOOL_PATTERN = /\b(tool|websearch|mcp|hook|plugin|ripgrep|\brg\b|\blsp\b|bash\()\b/i;
const DEBUG_LIFECYCLE_PATTERN = /\b(sessionstart|\bstop\b|startup|stream started|shut down|initialize|loading commands and agents|setup\(\) completed|session exited)\b/i;
const TERMINAL_NOISE_PATTERNS = [
  /^\[user\]\s+/i,
  /^claude(?:\s|$)/i,
  /^\S+[@:]\S+[#$%]\s/,
  /^zsh:/i,
  /^\$\s/,
  /^>\s/,
  /^\.+$/,
  /^\[process exited/i
];

type StoredClaudeRuntime = {
  workspaceRoot: string;
  debugLogPath: string | null;
  pendingQuestion: string | null;
  pendingApproval: string | null;
  lastPlan: string[];
  diffDetected: boolean;
  rawTail: string;
  debugLogTail: string;
  events: ClaudeCodeRuntimeEvent[];
  lastSessionId: number | null;
  savedAt: number;
};

function stripAnsiSequences(value: string) {
  const escapeChar = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function normalizeText(value: string) {
  return stripAnsiSequences(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u2500-\u257f]/g, ' ');
}

function appendTail(current: string, addition: string) {
  const next = `${current}${addition}`;
  return next.length <= MAX_RAW_TAIL ? next : next.slice(next.length - MAX_RAW_TAIL);
}

function appendLimitedTail(current: string, addition: string, maxLength: number) {
  const next = `${current}${addition}`;
  return next.length <= maxLength ? next : next.slice(next.length - maxLength);
}

function pushEvent(state: ClaudeCodeRuntimeState, kind: ClaudeCodeRuntimeEvent['kind'], text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const next = [...state.events, { kind, text: trimmed, createdAt: Date.now() }];
  state.events = next.slice(-MAX_EVENTS);
}

function syncSession(state: ClaudeCodeRuntimeState, terminalState: TerminalState) {
  const session = terminalState.sessions.find((item) => item.title === CLAUDE_SESSION_TITLE) ?? null;
  state.sessionId = session?.id ?? null;
  state.connected = session?.connected ?? false;
  state.workspaceRoot = terminalState.workspaceRoot;
  state.debugLogPath = terminalState.workspaceRoot ? `${terminalState.workspaceRoot}/${DEBUG_LOG_RELATIVE_PATH}` : null;
}

function toStorageKey(workspaceRoot: string) {
  return `${STORAGE_PREFIX}${workspaceRoot}`;
}

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function stripDebugPrefix(line: string) {
  return line.replace(DEBUG_PREFIX_PATTERN, '').trim();
}

function defaultResumeInfo(): ClaudeRuntimeResumeInfo {
  return {
    restoredFromStorage: false,
    restoredAt: null,
    snapshotSavedAt: null,
    snapshotSessionId: null
  };
}

function isLikelyTerminalNoise(line: string) {
  return TERMINAL_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

class ClaudeCodeClient {
  private state: ClaudeCodeRuntimeState = {
    sessionId: null,
    workspaceRoot: null,
    connected: false,
    running: false,
    rawTail: '',
    debugLogPath: null,
    debugLogTail: '',
    pendingQuestion: null,
    pendingApproval: null,
    lastPlan: [],
    diffDetected: false,
    events: [],
    resumeInfo: defaultResumeInfo(),
    capabilities: {
      interactiveStructuredOutput: false,
      printStructuredOutput: true,
      source: 'PTY stream + workspace --debug-file diagnostics (stream-json only with --print)'
    }
  };

  private listeners = new Set<(state: ClaudeCodeRuntimeState) => void>();
  private offTerminal: (() => void) | null = null;
  private lineBuffer = '';
  private collectingPlan = false;
  private debugPollTimer: number | null = null;
  private debugPollInFlight = false;
  private lastDebugContents = '';
  private lastDebugSize = 0;
  private lastDebugMtimeMs = 0;
  private restoredWorkspaceRoot: string | null = null;

  private emit() {
    this.persistState();
    const snapshot: ClaudeCodeRuntimeState = {
      ...this.state,
      lastPlan: [...this.state.lastPlan],
      events: [...this.state.events],
      resumeInfo: { ...this.state.resumeInfo },
      capabilities: { ...this.state.capabilities }
    };
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private clearWorkspaceScopedState() {
    this.state.rawTail = '';
    this.state.debugLogTail = '';
    this.state.pendingQuestion = null;
    this.state.pendingApproval = null;
    this.state.lastPlan = [];
    this.state.diffDetected = false;
    this.state.events = [];
    this.state.resumeInfo = defaultResumeInfo();
    this.lineBuffer = '';
    this.collectingPlan = false;
    this.lastDebugContents = '';
    this.lastDebugSize = 0;
    this.lastDebugMtimeMs = 0;
  }

  private cloneStateSnapshot(): ClaudeCodeRuntimeState {
    return {
      ...this.state,
      lastPlan: [...this.state.lastPlan],
      events: [...this.state.events],
      resumeInfo: { ...this.state.resumeInfo },
      capabilities: { ...this.state.capabilities }
    };
  }

  private stopDebugPolling() {
    if (this.debugPollTimer !== null) {
      window.clearTimeout(this.debugPollTimer);
      this.debugPollTimer = null;
    }
  }

  private maybeTearDownSubscriptions() {
    if (this.listeners.size > 0) return;
    this.stopDebugPolling();
    this.offTerminal?.();
    this.offTerminal = null;
  }

  private getDebugPollIntervalMs() {
    if (this.state.running) return DEBUG_POLL_INTERVAL_ACTIVE_MS;
    if (this.state.connected) return 3200;
    return DEBUG_POLL_INTERVAL_IDLE_MS;
  }

  private ensureSubscribed() {
    if (this.offTerminal) return;

    this.offTerminal = terminalClient.onEvent((event: TerminalEvent) => {
      if (event.type === 'state') {
        const previousWorkspaceRoot = this.state.workspaceRoot;
        syncSession(this.state, event);
        if (this.state.workspaceRoot !== previousWorkspaceRoot) {
          this.clearWorkspaceScopedState();
          this.restorePersistedState(this.state.workspaceRoot);
        }
        if (this.state.sessionId === null) {
          this.state.running = false;
        }
        this.ensureDebugPolling();
        this.emit();
        return;
      }

      if (event.type === 'data') {
        if (this.state.sessionId !== event.sessionId) return;
        this.state.running = true;
        const normalized = normalizeText(event.data);
        this.state.rawTail = appendTail(this.state.rawTail, normalized);
        this.processChunk(normalized);
        this.emit();
        return;
      }

      if (event.type === 'input-line') {
        return;
      }

      if (this.state.sessionId !== event.sessionId) return;
      this.state.connected = false;
      this.state.running = false;
      pushEvent(this.state, 'lifecycle', `Claude Code session exited (${event.signal ?? event.exitCode ?? 'unknown'})`);
      this.ensureDebugPolling();
      this.emit();
    });

    void terminalClient.getState().then((terminalState) => {
      syncSession(this.state, terminalState);
      this.clearWorkspaceScopedState();
      this.restorePersistedState(this.state.workspaceRoot);
      this.ensureDebugPolling();
      this.emit();
    }).catch(() => {});
  }

  private persistState() {
    if (!canUseStorage()) return;
    const workspaceRoot = this.state.workspaceRoot;
    if (!workspaceRoot) return;
    const payload: StoredClaudeRuntime = {
      workspaceRoot,
      debugLogPath: this.state.debugLogPath,
      pendingQuestion: this.state.pendingQuestion,
      pendingApproval: this.state.pendingApproval,
      lastPlan: [...this.state.lastPlan],
      diffDetected: this.state.diffDetected,
      rawTail: this.state.rawTail,
      debugLogTail: this.state.debugLogTail,
      events: [...this.state.events],
      lastSessionId: this.state.sessionId,
      savedAt: Date.now()
    };

    try {
      window.localStorage.setItem(toStorageKey(workspaceRoot), JSON.stringify(payload));
    } catch {
      // Ignore storage failures in renderer-only mode.
    }
  }

  private restorePersistedState(workspaceRoot: string | null) {
    if (!canUseStorage()) return;
    if (!workspaceRoot) return;
    if (this.restoredWorkspaceRoot === workspaceRoot) return;
    this.restoredWorkspaceRoot = workspaceRoot;

    try {
      const raw = window.localStorage.getItem(toStorageKey(workspaceRoot));
      if (!raw) {
        this.state.resumeInfo = defaultResumeInfo();
        return;
      }

      const stored = JSON.parse(raw) as Partial<StoredClaudeRuntime>;
      this.state.pendingQuestion = typeof stored.pendingQuestion === 'string' ? stored.pendingQuestion : null;
      this.state.pendingApproval = typeof stored.pendingApproval === 'string' ? stored.pendingApproval : null;
      this.state.lastPlan = Array.isArray(stored.lastPlan)
        ? stored.lastPlan.filter((item): item is string => typeof item === 'string').slice(-6)
        : [];
      this.state.diffDetected = Boolean(stored.diffDetected);
      this.state.rawTail = typeof stored.rawTail === 'string' ? stored.rawTail.slice(-MAX_RAW_TAIL) : '';
      this.state.debugLogTail = typeof stored.debugLogTail === 'string' ? stored.debugLogTail.slice(-MAX_DEBUG_TAIL) : '';
      this.lastDebugContents = this.state.debugLogTail;
      this.lastDebugSize = this.lastDebugContents.length;
      this.lastDebugMtimeMs = 0;
      this.state.events = Array.isArray(stored.events)
        ? stored.events.filter((event): event is ClaudeCodeRuntimeEvent => (
          Boolean(event)
          && typeof event === 'object'
          && typeof event.kind === 'string'
          && typeof event.text === 'string'
          && typeof event.createdAt === 'number'
        )).slice(-MAX_EVENTS)
        : [];
      this.state.resumeInfo = {
        restoredFromStorage: true,
        restoredAt: Date.now(),
        snapshotSavedAt: typeof stored.savedAt === 'number' ? stored.savedAt : null,
        snapshotSessionId: typeof stored.lastSessionId === 'number' ? stored.lastSessionId : null
      };
      pushEvent(this.state, 'lifecycle', 'Restored Claude runtime state for this workspace');
    } catch {
      // Ignore invalid stored state.
    }
  }

  private ensureDebugPolling() {
    if (this.listeners.size === 0 || !this.state.debugLogPath) {
      this.stopDebugPolling();
      return;
    }
    if (this.debugPollTimer !== null) return;

    this.debugPollTimer = window.setTimeout(() => {
      this.debugPollTimer = null;
      void this.pollDebugLog();
    }, this.getDebugPollIntervalMs());
  }

  private async pollDebugLog() {
    const debugLogPath = this.state.debugLogPath;
    if (!debugLogPath || this.debugPollInFlight) {
      this.ensureDebugPolling();
      return;
    }

    this.debugPollInFlight = true;

    try {
      const snapshot = await fsClient.readWorkspaceTextFileTail(debugLogPath, MAX_DEBUG_TAIL);
      if (snapshot.size === this.lastDebugSize && snapshot.mtimeMs === this.lastDebugMtimeMs && snapshot.contents === this.lastDebugContents) {
        return;
      }

      const previous = this.lastDebugContents;
      const contents = snapshot.contents;
      this.lastDebugContents = contents;
      this.lastDebugSize = snapshot.size;
      this.lastDebugMtimeMs = snapshot.mtimeMs;
      this.state.debugLogTail = contents;

      const delta = contents.startsWith(previous)
        ? contents.slice(previous.length)
        : contents.slice(Math.max(0, contents.length - DEBUG_DELTA_FALLBACK_CHARS));
      if (delta) {
        this.processDebugChunk(delta);
        this.emit();
      }
    } catch {
      // Debug file may not exist before Claude creates it.
    } finally {
      this.debugPollInFlight = false;
      this.ensureDebugPolling();
    }
  }

  private processDebugChunk(chunk: string) {
    const normalized = normalizeText(chunk);
    const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);

    for (const rawLine of lines.slice(-24)) {
      const line = stripDebugPrefix(rawLine);
      if (!line) continue;

      if (DEBUG_APPROVAL_PATTERN.test(line)) {
        this.state.pendingApproval = line;
        pushEvent(this.state, 'approval', `[debug] ${line}`);
        continue;
      }

      if (DEBUG_TOOL_PATTERN.test(line)) {
        pushEvent(this.state, 'tool', `[debug] ${line}`);
        continue;
      }

      if (DEBUG_LIFECYCLE_PATTERN.test(line)) {
        pushEvent(this.state, 'lifecycle', `[debug] ${line}`);
        continue;
      }

      if (/\b(user_prompt|UserPromptSubmit|Stop|SessionStart)\b/i.test(line)) {
        pushEvent(this.state, 'message', `[debug] ${line}`);
        continue;
      }

      if (/\[API:request\]|Sending .*skills/i.test(line)) {
        pushEvent(this.state, 'status', `[debug] ${line}`);
      }
    }
  }

  private async ensureDebugDirectory(sessionId: number) {
    if (!this.state.workspaceRoot) return;
    await terminalClient.sendCommand(`mkdir -p "${this.state.workspaceRoot}/.claude"`, sessionId, 'system');
  }

  private getLaunchCommand() {
    const debugLogPath = this.state.debugLogPath;
    if (!debugLogPath) return 'claude';
    return `claude --debug-file "${debugLogPath}"`;
  }

  private processChunk(chunk: string) {
    const combined = `${this.lineBuffer}${chunk}`;
    const lines = combined.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        this.collectingPlan = false;
        continue;
      }

      if (PLAN_START_PATTERN.test(line)) {
        this.collectingPlan = true;
        this.state.lastPlan = [];
        pushEvent(this.state, 'plan', line);
        continue;
      }

      if (this.collectingPlan && PLAN_BULLET_PATTERN.test(line)) {
        this.state.lastPlan = [...this.state.lastPlan, line].slice(-6);
        pushEvent(this.state, 'plan', line);
        continue;
      }

      if (DIFF_PATTERN.test(line)) {
        this.state.diffDetected = true;
        pushEvent(this.state, 'diff', line);
        continue;
      }

      if (APPROVAL_PATTERN.test(line) && /\?$/.test(line)) {
        this.state.pendingApproval = line;
        pushEvent(this.state, 'approval', line);
        continue;
      }

      if (QUESTION_PATTERN.test(line) && /\?$/.test(line)) {
        this.state.pendingQuestion = line;
        pushEvent(this.state, 'question', line);
        continue;
      }

      if (/^claude\b/i.test(line) || /^thinking/i.test(line) || /^error:/i.test(line) || /^note:/i.test(line)) {
        pushEvent(this.state, 'message', line);
        continue;
      }

      if (isLikelyTerminalNoise(line)) {
        continue;
      }

      // Most useful Claude responses are plain text lines; keep them as message events.
      pushEvent(this.state, 'message', line);
    }
  }

  async ensureSession() {
    this.ensureSubscribed();
    const latestState = await terminalClient.getState();
    syncSession(this.state, latestState);
    this.restorePersistedState(this.state.workspaceRoot);
    this.ensureDebugPolling();

    const session = latestState.sessions.find((item) => item.title === CLAUDE_SESSION_TITLE) ?? null;
    if (!session) {
      const created = await terminalClient.createSession(latestState.workspaceRoot ?? undefined, CLAUDE_SESSION_TITLE);
      if (created === null) {
        throw new Error('Unable to create Claude Code terminal session');
      }
      await terminalClient.setActiveSession(created);
      await this.ensureDebugDirectory(created);
      await terminalClient.sendCommand(this.getLaunchCommand(), created, 'system');
      this.state.sessionId = created;
      this.state.connected = true;
      this.state.running = true;
      pushEvent(this.state, 'lifecycle', 'Started Claude Code session');
      this.emit();
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      return created;
    }

    await terminalClient.setActiveSession(session.id);
    this.state.sessionId = session.id;
    this.state.connected = session.connected;

    if (!session.connected) {
      await terminalClient.restart(session.id);
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      await this.ensureDebugDirectory(session.id);
      await terminalClient.sendCommand(this.getLaunchCommand(), session.id, 'system');
      this.state.connected = true;
      this.state.running = true;
      pushEvent(this.state, 'lifecycle', 'Restarted Claude Code session');
      this.emit();
      await new Promise((resolve) => window.setTimeout(resolve, 900));
    }

    return session.id;
  }

  async sendPrompt(prompt: string) {
    const sessionId = await this.ensureSession();
    this.state.pendingQuestion = null;
    this.state.pendingApproval = null;
    this.state.diffDetected = false;
    this.state.rawTail = appendLimitedTail(this.state.rawTail, `\n[user] ${prompt}\n`, MAX_RAW_TAIL);
    pushEvent(this.state, 'message', `User prompt sent: ${prompt}`);
    this.emit();
    await terminalClient.write(`${prompt}\n`, sessionId, 'chat');
  }

  async interrupt() {
    this.ensureSubscribed();
    const latestState = await terminalClient.getState();
    const session = latestState.sessions.find((item) => item.title === CLAUDE_SESSION_TITLE) ?? null;
    if (!session) return;
    await terminalClient.interrupt(session.id);
    pushEvent(this.state, 'lifecycle', 'Interrupt requested for Claude Code');
    this.emit();
  }

  subscribe(listener: (state: ClaudeCodeRuntimeState) => void) {
    this.ensureSubscribed();
    this.listeners.add(listener);
    this.ensureDebugPolling();
    listener(this.cloneStateSnapshot());
    return () => {
      this.listeners.delete(listener);
      this.maybeTearDownSubscriptions();
    };
  }
}

export const claudeCodeClient = new ClaudeCodeClient();
