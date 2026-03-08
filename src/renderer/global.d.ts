export {};

type TerminalState = {
  workspaceRoot: string | null;
  activeSessionId: number | null;
  sessions: Array<{ id: number; title: string; cwd: string; connected: boolean }>;
};

type TerminalEvent =
  | { type: 'state'; workspaceRoot: string | null; activeSessionId: number | null; sessions: Array<{ id: number; title: string; cwd: string; connected: boolean }> }
  | { type: 'data'; sessionId: number; data: string }
  | { type: 'exit'; sessionId: number; exitCode: number | null; signal: string | null }
  | { type: 'input-line'; sessionId: number; source: 'chat' | 'terminal' | 'system'; text: string };

type WorkspaceEvent =
  | { type: 'changed'; eventType: string; path: string }
  | { type: 'error'; message: string };

declare global {
  interface Window {
    assistantDesk: {
      selectWorkspaceFolder(): Promise<string | null>;
      getWorkspaceRoot(): Promise<string | null>;
      getWorkspaceRoots(): Promise<string[]>;
      setActiveWorkspaceRoot(rootPath: string): Promise<string | null>;
      removeWorkspaceRoot(rootPath: string): Promise<{ workspaceRoot: string | null; workspaceRoots: string[] }>;
      setWorkspaceRoots(rootPaths: string[]): Promise<{ workspaceRoot: string | null; workspaceRoots: string[] }>;
      listWorkspaceDir(dirPath: string): Promise<Array<{ name: string; path: string; kind: 'file' | 'dir' }>>;
      readWorkspaceTextFile(filePath: string): Promise<string>;
      readWorkspaceFile(filePath: string): Promise<{ kind: 'text' | 'binary'; contents: string | null; contentsEncoding: 'utf8' | 'base64' | null; mimeType: string | null; readOnly: boolean; size: number }>;
      writeWorkspaceTextFile(filePath: string, contents: string): Promise<void>;
      openArbitraryTextFile(): Promise<{ path: string; contents: string } | null>;
      getTerminalState(): Promise<TerminalState>;
      createTerminalSession(cwd?: string, title?: string): Promise<number>;
      setActiveTerminalSession(sessionId: number): Promise<void>;
      closeTerminalSession(sessionId: number): Promise<void>;
      writeTerminalInput(data: string, sessionId?: number, source?: 'chat' | 'terminal' | 'system'): Promise<void>;
      execWorkspaceCommand(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; cwd: string }>;
      runTerminalCommandWithCapture(command: string, timeoutMs?: number, sessionId?: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; cwd: string; sessionId: number }>;
      resizeTerminal(cols: number, rows: number): Promise<void>;
      restartTerminal(sessionId?: number): Promise<void>;
      interruptTerminal(sessionId?: number): Promise<void>;
      onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
      onWorkspaceEvent(listener: (event: WorkspaceEvent) => void): () => void;
    };
  }
}
