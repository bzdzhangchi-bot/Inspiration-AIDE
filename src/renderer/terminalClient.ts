export type TerminalState = {
  workspaceRoot: string | null;
  activeSessionId: number | null;
  sessions: Array<{ id: number; title: string; cwd: string; connected: boolean }>;
};

export type TerminalEvent =
  | { type: 'state'; workspaceRoot: string | null; activeSessionId: number | null; sessions: Array<{ id: number; title: string; cwd: string; connected: boolean }> }
  | { type: 'data'; sessionId: number; data: string }
  | { type: 'exit'; sessionId: number; exitCode: number | null; signal: string | null }
  | { type: 'input-line'; sessionId: number; source: 'chat' | 'terminal' | 'system'; text: string };

export type TerminalCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  cwd: string;
  sessionId: number;
};

function getBridge() {
  const bridge = window.assistantDesk;
  if (!bridge) return null;
  if (typeof bridge.getTerminalState !== 'function') return null;
  if (typeof bridge.createTerminalSession !== 'function') return null;
  if (typeof bridge.setActiveTerminalSession !== 'function') return null;
  if (typeof bridge.closeTerminalSession !== 'function') return null;
  if (typeof bridge.writeTerminalInput !== 'function') return null;
  if (typeof bridge.runTerminalCommandWithCapture !== 'function') return null;
  if (typeof bridge.resizeTerminal !== 'function') return null;
  if (typeof bridge.restartTerminal !== 'function') return null;
  if (typeof bridge.interruptTerminal !== 'function') return null;
  if (typeof bridge.onTerminalEvent !== 'function') return null;
  return bridge;
}

function isBridgeAvailable() {
  return getBridge() !== null;
}

export const terminalClient = {
  isAvailable() {
    return isBridgeAvailable();
  },

  async getState(): Promise<TerminalState> {
    const bridge = getBridge();
    if (!bridge) {
      return {
        workspaceRoot: null,
        activeSessionId: null,
        sessions: []
      };
    }
    return bridge.getTerminalState();
  },

  async createSession(cwd?: string, title?: string): Promise<number | null> {
    const bridge = getBridge();
    if (!bridge) return null;
    return bridge.createTerminalSession(cwd, title);
  },

  async setActiveSession(sessionId: number): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.setActiveTerminalSession(sessionId);
  },

  async closeSession(sessionId: number): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.closeTerminalSession(sessionId);
  },

  async write(data: string, sessionId?: number, source?: 'chat' | 'terminal' | 'system'): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.writeTerminalInput(data, sessionId, source);
  },

  async sendCommand(command: string, sessionId?: number, source?: 'chat' | 'terminal' | 'system'): Promise<void> {
    const normalized = command.endsWith('\n') ? command : `${command}\n`;
    return this.write(normalized, sessionId, source);
  },

  async runCommandWithCapture(command: string, timeoutMs = 20000, sessionId?: number): Promise<TerminalCommandResult> {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error('Terminal bridge unavailable');
    }
    return bridge.runTerminalCommandWithCapture(command, timeoutMs, sessionId);
  },

  async resize(cols: number, rows: number): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.resizeTerminal(cols, rows);
  },

  async restart(sessionId?: number): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.restartTerminal(sessionId);
  },

  async interrupt(sessionId?: number): Promise<void> {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.interruptTerminal(sessionId);
  },

  onEvent(listener: (event: TerminalEvent) => void) {
    const bridge = getBridge();
    if (!bridge) {
      return () => {};
    }
    return bridge.onTerminalEvent(listener);
  }
};