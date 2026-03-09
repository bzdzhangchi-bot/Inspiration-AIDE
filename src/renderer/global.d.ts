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

type ClaudeMemoryFile = {
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

type ClaudeMemorySnapshot = {
  workspaceRoot: string;
  projectKey: string;
  autoMemoryEnabled: boolean;
  autoMemoryRoot: string;
  instructionFiles: ClaudeMemoryFile[];
  autoMemoryFiles: ClaudeMemoryFile[];
  notices: string[];
};

type GitStatusEntry = {
  path: string;
  originalPath: string | null;
  staged: string;
  unstaged: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'unmerged' | 'unknown';
};

type GitCommitSummary = {
  sha: string;
  shortSha: string;
  author: string;
  subject: string;
  relativeTime: string;
};

type GitRepositorySnapshot = {
  workspaceRoot: string;
  gitRoot: string | null;
  branch: string | null;
  upstream: string | null;
  headShortSha: string | null;
  ahead: number;
  behind: number;
  isClean: boolean;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  statusEntries: GitStatusEntry[];
  recentCommits: GitCommitSummary[];
  error: string | null;
};

type GitDiffSnapshot = {
  workspaceRoot: string;
  gitRoot: string | null;
  path: string;
  staged: boolean;
  diff: string;
};

type GitCommitResult = {
  repository: GitRepositorySnapshot;
  output: string;
};

declare global {
  type AppInfo = {
    name: string;
    version: string;
    displayVersion: string;
    releaseVersion: string;
    isPackaged: boolean;
    platform: string;
    arch: string;
    downloadsPath: string;
  };

  type AppUpdateSummary = {
    currentVersion: string;
    latestVersion: string;
    latestTag: string;
    status: 'available' | 'current' | 'ahead';
    releaseName: string;
    htmlUrl: string;
    publishedAt: string | null;
    body: string;
    asset: {
      id: number;
      name: string;
      url: string;
      size: number | null;
      contentType: string | null;
      score: number;
    } | null;
    downloadedFilePath?: string;
    openError?: string | null;
  };

  type AppUpdateEvent =
    | { type: 'download-start'; fileName: string; destinationPath: string }
    | { type: 'download-progress'; fileName: string; receivedBytes: number; totalBytes: number | null; percent: number | null }
    | { type: 'download-complete'; fileName: string; filePath: string; totalBytes: number; openError: string | null };

  interface Window {
    assistantDesk: {
      getAppInfo(): Promise<AppInfo>;
      checkForUpdates(): Promise<AppUpdateSummary>;
      downloadLatestUpdate(): Promise<AppUpdateSummary>;
      selectWorkspaceFolder(): Promise<string | null>;
      getWorkspaceRoot(): Promise<string | null>;
      getWorkspaceRoots(): Promise<string[]>;
      getGitRepositories(): Promise<GitRepositorySnapshot[]>;
      getGitRepository(workspaceRoot: string): Promise<GitRepositorySnapshot>;
      getGitDiff(workspaceRoot: string, filePath: string, staged?: boolean): Promise<GitDiffSnapshot>;
      stageGitFile(workspaceRoot: string, filePath: string): Promise<GitRepositorySnapshot>;
      unstageGitFile(workspaceRoot: string, filePath: string): Promise<GitRepositorySnapshot>;
      discardGitFile(workspaceRoot: string, filePath: string): Promise<GitRepositorySnapshot>;
      commitGitChanges(workspaceRoot: string, message: string): Promise<GitCommitResult>;
      setActiveWorkspaceRoot(rootPath: string): Promise<string | null>;
      removeWorkspaceRoot(rootPath: string): Promise<{ workspaceRoot: string | null; workspaceRoots: string[] }>;
      setWorkspaceRoots(rootPaths: string[]): Promise<{ workspaceRoot: string | null; workspaceRoots: string[] }>;
      listWorkspaceDir(dirPath: string): Promise<Array<{ name: string; path: string; kind: 'file' | 'dir' }>>;
      readWorkspaceTextFile(filePath: string): Promise<string>;
      readWorkspaceTextFileTail(filePath: string, maxChars?: number): Promise<{ contents: string; size: number; mtimeMs: number }>;
      readWorkspaceFile(filePath: string): Promise<{ kind: 'text' | 'binary'; contents: string | null; contentsEncoding: 'utf8' | 'base64' | null; mimeType: string | null; readOnly: boolean; size: number }>;
      writeWorkspaceTextFile(filePath: string, contents: string): Promise<void>;
      openArbitraryTextFile(): Promise<{ path: string; contents: string } | null>;
      getClaudeMemorySnapshot(workspaceRoot?: string | null): Promise<ClaudeMemorySnapshot>;
      readClaudeMemoryFile(filePath: string, workspaceRoot?: string | null): Promise<string>;
      revealClaudePath(filePath: string, workspaceRoot?: string | null): Promise<boolean>;
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
      onAppUpdateEvent(listener: (event: AppUpdateEvent) => void): () => void;
    };
  }
}
