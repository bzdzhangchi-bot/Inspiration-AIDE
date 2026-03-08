type DirEntry = { name: string; path: string; kind: 'file' | 'dir' };
type WorkspaceEvent =
  | { type: 'changed'; eventType: string; path: string }
  | { type: 'error'; message: string };

export type ClaudeMemoryFile = {
  id: string;
  path: string;
  displayPath: string;
  relativePath: string;
  name: string;
  scope: 'user' | 'project' | 'auto';
  kind: 'claude' | 'local' | 'rule' | 'memory';
  lineCount: number;
  preview: string;
  updatedAt: number;
  size: number;
};

export type ClaudeMemorySnapshot = {
  workspaceRoot: string;
  projectKey: string;
  autoMemoryEnabled: boolean;
  autoMemoryRoot: string;
  instructionFiles: ClaudeMemoryFile[];
  autoMemoryFiles: ClaudeMemoryFile[];
  notices: string[];
};

export const fsClient = {
  async selectWorkspaceFolder(): Promise<string | null> {
    return window.assistantDesk.selectWorkspaceFolder();
  },

  async getWorkspaceRoot(): Promise<string | null> {
    return window.assistantDesk.getWorkspaceRoot();
  },

  async getWorkspaceRoots(): Promise<string[]> {
    return window.assistantDesk.getWorkspaceRoots();
  },

  async setActiveWorkspaceRoot(rootPath: string): Promise<string | null> {
    return window.assistantDesk.setActiveWorkspaceRoot(rootPath);
  },

  async removeWorkspaceRoot(rootPath: string): Promise<{ workspaceRoot: string | null; workspaceRoots: string[] }> {
    return window.assistantDesk.removeWorkspaceRoot(rootPath);
  },

  async setWorkspaceRoots(rootPaths: string[]): Promise<{ workspaceRoot: string | null; workspaceRoots: string[] }> {
    return window.assistantDesk.setWorkspaceRoots(rootPaths);
  },

  async listWorkspaceDir(dirPath: string): Promise<DirEntry[]> {
    return window.assistantDesk.listWorkspaceDir(dirPath);
  },

  async readWorkspaceTextFile(filePath: string): Promise<string> {
    return window.assistantDesk.readWorkspaceTextFile(filePath);
  },

  async readWorkspaceTextFileTail(filePath: string, maxChars = 6000): Promise<{ contents: string; size: number; mtimeMs: number }> {
    return window.assistantDesk.readWorkspaceTextFileTail(filePath, maxChars);
  },

  async readWorkspaceFile(filePath: string): Promise<{ kind: 'text' | 'binary'; contents: string | null; contentsEncoding: 'utf8' | 'base64' | null; mimeType: string | null; readOnly: boolean; size: number }> {
    return window.assistantDesk.readWorkspaceFile(filePath);
  },

  async writeWorkspaceTextFile(filePath: string, contents: string): Promise<void> {
    return window.assistantDesk.writeWorkspaceTextFile(filePath, contents);
  },

  async runWorkspaceCommand(command: string, timeoutMs = 20000): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; cwd: string }> {
    return window.assistantDesk.execWorkspaceCommand(command, timeoutMs);
  },

  async openArbitraryTextFile(): Promise<{ path: string; contents: string } | null> {
    return window.assistantDesk.openArbitraryTextFile();
  },

  async getClaudeMemorySnapshot(workspaceRoot?: string | null): Promise<ClaudeMemorySnapshot> {
    return window.assistantDesk.getClaudeMemorySnapshot(workspaceRoot);
  },

  async readClaudeMemoryFile(filePath: string, workspaceRoot?: string | null): Promise<string> {
    return window.assistantDesk.readClaudeMemoryFile(filePath, workspaceRoot);
  },

  async revealClaudePath(filePath: string, workspaceRoot?: string | null): Promise<boolean> {
    return window.assistantDesk.revealClaudePath(filePath, workspaceRoot);
  },

  onWorkspaceEvent(listener: (event: WorkspaceEvent) => void) {
    return window.assistantDesk.onWorkspaceEvent(listener);
  }
};
