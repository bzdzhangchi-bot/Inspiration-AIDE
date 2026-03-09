import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { terminalClient, type TerminalCommandResult, type TerminalEvent, type TerminalState } from '../terminalClient';
import type { SettingsState } from '../pages/SettingsPage';

const initialState: TerminalState = {
  workspaceRoot: null
  ,activeSessionId: null,
  sessions: []
};

export type TerminalPanelHandle = {
  runCommand: (command: string, timeoutMs?: number) => Promise<TerminalCommandResult | null>;
  interruptAgentCommand: () => Promise<void>;
  focusActiveSession: () => void;
};

function buildTerminalTheme(source: HTMLElement | null) {
  const styles = getComputedStyle(source ?? document.documentElement);
  return {
    background: styles.getPropertyValue('--terminal-bg').trim() || '#111318',
    foreground: styles.getPropertyValue('--terminal-fg').trim() || '#d4d4d4',
    cursor: styles.getPropertyValue('--terminal-cursor').trim() || '#3794ff',
    selectionBackground: styles.getPropertyValue('--terminal-selection').trim() || 'rgba(55, 148, 255, 0.28)',
    black: styles.getPropertyValue('--terminal-ansi-black').trim() || '#111318',
    brightBlack: styles.getPropertyValue('--terminal-ansi-bright-black').trim() || '#5f6368',
    red: styles.getPropertyValue('--terminal-ansi-red').trim() || '#f14c4c',
    brightRed: styles.getPropertyValue('--terminal-ansi-bright-red').trim() || '#ff8c8c',
    green: styles.getPropertyValue('--terminal-ansi-green').trim() || '#6a9955',
    brightGreen: styles.getPropertyValue('--terminal-ansi-bright-green').trim() || '#8ec07c',
    yellow: styles.getPropertyValue('--terminal-ansi-yellow').trim() || '#d7ba7d',
    brightYellow: styles.getPropertyValue('--terminal-ansi-bright-yellow').trim() || '#f5d547',
    blue: styles.getPropertyValue('--terminal-ansi-blue').trim() || '#3794ff',
    brightBlue: styles.getPropertyValue('--terminal-ansi-bright-blue').trim() || '#61afef',
    magenta: styles.getPropertyValue('--terminal-ansi-magenta').trim() || '#c586c0',
    brightMagenta: styles.getPropertyValue('--terminal-ansi-bright-magenta').trim() || '#d16d9e',
    cyan: styles.getPropertyValue('--terminal-ansi-cyan').trim() || '#4ec9b0',
    brightCyan: styles.getPropertyValue('--terminal-ansi-bright-cyan').trim() || '#56b6c2',
    white: styles.getPropertyValue('--terminal-ansi-white').trim() || '#d4d4d4',
    brightWhite: styles.getPropertyValue('--terminal-ansi-bright-white').trim() || '#ffffff'
  };
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, {
  isOpen: boolean;
  height: number;
  themeMode: 'system' | 'dark' | 'light';
  settings: SettingsState;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}>(function TerminalPanel(props, ref) {
  const { isOpen, height, themeMode, settings, onResizeStart } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const bufferRef = useRef(new Map<number, string>());
  const activeSessionIdRef = useRef<number | null>(null);
  const activeAgentSessionIdRef = useRef<number | null>(null);
  const [terminalState, setTerminalState] = useState<TerminalState>(initialState);
  const [bridgeAvailable, setBridgeAvailable] = useState(() => terminalClient.isAvailable());

  const getActiveSession = useCallback(() => {
    return terminalState.sessions.find((session) => session.id === terminalState.activeSessionId) ?? null;
  }, [terminalState.activeSessionId, terminalState.sessions]);

  function appendLocalNotice(sessionId: number, text: string) {
    const next = `${text.endsWith('\n') ? text : `${text}\n`}`;
    const prev = bufferRef.current.get(sessionId) ?? '';
    bufferRef.current.set(sessionId, prev + next);
    if (sessionId === activeSessionIdRef.current) {
      terminalRef.current?.write(next.replace(/\n/g, '\r\n'));
    }
  }

  function renderSessionBuffer(sessionId: number | null) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.clear();
    terminal.reset();
    if (sessionId === null) return;
    const text = bufferRef.current.get(sessionId);
    if (text) {
      terminal.write(text);
    }
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el || terminalRef.current || !isOpen) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit')
    ]).then(([xtermModule, fitAddonModule]) => {
      if (cancelled || terminalRef.current) return;

      const terminal = new xtermModule.Terminal({
        cursorBlink: true,
        fontFamily: settings.terminalFontFamily,
        fontSize: settings.terminalFontSize,
        lineHeight: 1.35,
        scrollback: 5000,
        theme: buildTerminalTheme(el)
      });
      const fitAddon = new fitAddonModule.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(el);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      const syncSize = () => {
        fitAddon.fit();
        const dimensions = fitAddon.proposeDimensions();
        if (!dimensions) return;
        void terminalClient.resize(dimensions.cols, dimensions.rows);
      };

      syncSize();
      renderSessionBuffer(activeSessionIdRef.current);

      const dataDisposable = terminal.onData((data) => {
        void terminalClient.write(data, undefined, 'terminal');
      });

      resizeObserverRef.current = new ResizeObserver(() => {
        syncSize();
      });
      resizeObserverRef.current.observe(el);

      if (bridgeAvailable) {
        terminal.focus();
      }

      cleanup = () => {
        dataDisposable.dispose();
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        fitAddonRef.current = null;
        terminalRef.current = null;
        terminal.dispose();
      };
    }).catch(() => {
      setBridgeAvailable(false);
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [bridgeAvailable, isOpen, settings.terminalFontFamily, settings.terminalFontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal) return;
    terminal.options = {
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      theme: buildTerminalTheme(containerRef.current)
    };
    queueMicrotask(() => {
      fitAddon?.fit();
      const dimensions = fitAddon?.proposeDimensions();
      if (dimensions) {
        void terminalClient.resize(dimensions.cols, dimensions.rows);
      }
    });
  }, [settings.terminalFontFamily, settings.terminalFontSize, themeMode]);

  useEffect(() => {
    activeSessionIdRef.current = terminalState.activeSessionId;
  }, [terminalState.activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    void terminalClient
      .getState()
      .then((state) => {
        if (cancelled) return;
        setTerminalState(state);
      })
      .catch(() => {});

    const off = terminalClient.onEvent((event: TerminalEvent) => {
      setBridgeAvailable(true);
      if (event.type === 'state') {
        setTerminalState({ workspaceRoot: event.workspaceRoot, activeSessionId: event.activeSessionId, sessions: event.sessions });
        return;
      }
      if (event.type === 'data') {
        const prev = bufferRef.current.get(event.sessionId) ?? '';
        bufferRef.current.set(event.sessionId, prev + event.data);
        if (event.sessionId === activeSessionIdRef.current) {
          terminalRef.current?.write(event.data);
        }
        return;
      }
      if (event.type === 'exit') {
        const line = `\r\n[process exited${event.signal ? `: ${event.signal}` : `: ${event.exitCode ?? 0}`}]\r\n`;
        const prev = bufferRef.current.get(event.sessionId) ?? '';
        bufferRef.current.set(event.sessionId, prev + line);
        if (event.sessionId === activeSessionIdRef.current) {
          terminalRef.current?.write(line);
        }
      }
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    queueMicrotask(() => {
      fitAddon.fit();
      const dimensions = fitAddon.proposeDimensions();
      if (dimensions) {
        void terminalClient.resize(dimensions.cols, dimensions.rows);
      }
      if (bridgeAvailable) {
        terminal.focus();
      }
    });
  }, [bridgeAvailable, height, isOpen]);

  useEffect(() => {
    renderSessionBuffer(terminalState.activeSessionId);
  }, [terminalState.activeSessionId]);

  async function restartTerminal() {
    const activeSession = getActiveSession();
    if (!activeSession) return;
    bufferRef.current.delete(activeSession.id);
    terminalRef.current?.clear();
    await terminalClient.restart(activeSession.id);
  }

  async function interruptTerminal() {
    const activeSession = getActiveSession();
    if (!activeSession) return;
    await terminalClient.interrupt(activeSession.id);
  }

  function clearViewport() {
    const activeSession = getActiveSession();
    if (activeSession) {
      bufferRef.current.set(activeSession.id, '');
    }
    terminalRef.current?.clear();
  }

  async function createSession() {
    const created = await terminalClient.createSession(undefined, undefined);
    if (created !== null) {
      bufferRef.current.set(created, '');
    }
  }

  async function closeSession(sessionId: number) {
    bufferRef.current.delete(sessionId);
    await terminalClient.closeSession(sessionId);
  }

  async function activateSession(sessionId: number) {
    await terminalClient.setActiveSession(sessionId);
  }

  useImperativeHandle(ref, () => ({
    async runCommand(command: string, timeoutMs = 20000) {
      const activeSession = getActiveSession();
      if (!activeSession) {
        const created = await terminalClient.createSession(undefined, undefined);
        if (created === null) return null;
        activeAgentSessionIdRef.current = created;
        appendLocalNotice(created, `[Inspiration] Running agent command: ${command}`);
        try {
          const result = await terminalClient.runCommandWithCapture(command, timeoutMs, created);
          appendLocalNotice(created, `[Inspiration] Command finished with exit code ${result.exitCode ?? 'null'}`);
          return result;
        } finally {
          if (activeAgentSessionIdRef.current === created) {
            activeAgentSessionIdRef.current = null;
          }
        }
      }
      activeAgentSessionIdRef.current = activeSession.id;
      appendLocalNotice(activeSession.id, `[Inspiration] Running agent command: ${command}`);
      try {
        const result = await terminalClient.runCommandWithCapture(command, timeoutMs, activeSession.id);
        appendLocalNotice(activeSession.id, `[Inspiration] Command finished with exit code ${result.exitCode ?? 'null'}`);
        return result;
      } finally {
        if (activeAgentSessionIdRef.current === activeSession.id) {
          activeAgentSessionIdRef.current = null;
        }
      }
    },
    async interruptAgentCommand() {
      const sessionId = activeAgentSessionIdRef.current ?? activeSessionIdRef.current;
      if (sessionId === null) return;
      appendLocalNotice(sessionId, '[Inspiration] Interrupt requested from chat');
      await terminalClient.interrupt(sessionId);
    },
    focusActiveSession() {
      terminalRef.current?.focus();
    }
  }), [getActiveSession]);

  return (
    <div className={isOpen ? 'terminalPanel open' : 'terminalPanel'} style={isOpen ? { height: `${height}px` } : undefined}>
      {isOpen ? <div className="terminalResizeHandle" onPointerDown={onResizeStart} /> : null}
      <div className="terminalHeader">
        <div>
          <div className="cardTitle">Terminal</div>
          <div className="terminalMeta">{getActiveSession()?.cwd || 'No working directory'}</div>
        </div>
        <div className="terminalHeaderActions">
          <div className="pill" style={{ opacity: 1 }}>{getActiveSession()?.connected ? 'Live' : 'Closed'}</div>
          <button type="button" onClick={() => void createSession()} disabled={!bridgeAvailable}>
            New Tab
          </button>
          <button type="button" onClick={clearViewport}>
            Clear
          </button>
          <button type="button" onClick={() => void interruptTerminal()} disabled={!bridgeAvailable || !getActiveSession()?.connected}>
            Ctrl+C
          </button>
          <button type="button" onClick={() => void restartTerminal()} disabled={!bridgeAvailable}>
            Restart
          </button>
        </div>
      </div>

      <div className="terminalTabs">
        {terminalState.sessions.map((session) => (
          <div key={session.id} className={session.id === terminalState.activeSessionId ? 'terminalTab active' : 'terminalTab'}>
            <button type="button" className="terminalTabMain" onClick={() => void activateSession(session.id)}>
              <span>{session.title}</span>
              <span className="terminalTabMeta">{session.connected ? 'live' : 'closed'}</span>
            </button>
            <button
              type="button"
              className="terminalTabClose"
              onClick={() => void closeSession(session.id)}
              disabled={terminalState.sessions.length <= 1}
              aria-label={`Close ${session.title}`}
            >
              x
            </button>
          </div>
        ))}
      </div>

      <div className={isOpen ? 'terminalViewportShell' : 'terminalViewportShell collapsed'}>
        <div
          ref={containerRef}
          className={bridgeAvailable ? 'terminalViewport' : 'terminalViewport disabled'}
          onMouseDown={() => {
            if (bridgeAvailable && isOpen) {
              terminalRef.current?.focus();
            }
          }}
        />
        {!bridgeAvailable ? (
          <div className="terminalOverlay">Terminal bridge unavailable. Restart the Electron app.</div>
        ) : null}
        {!bridgeAvailable && terminalState.sessions.length === 0 ? (
          <div className="empty" style={{ position: 'absolute', left: 14, bottom: 10 }}>
            Waiting for terminal bridge…
          </div>
        ) : null}
      </div>
    </div>
  );
});
