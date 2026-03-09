const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantDesk', {
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  downloadLatestUpdate: () => ipcRenderer.invoke('app:downloadLatestUpdate'),
  selectWorkspaceFolder: () => ipcRenderer.invoke('workspace:selectFolder'),
  getWorkspaceRoot: () => ipcRenderer.invoke('workspace:getRoot'),
  getWorkspaceRoots: () => ipcRenderer.invoke('workspace:getRoots'),
  getGitRepositories: () => ipcRenderer.invoke('git:getRepositories'),
  getGitRepository: (workspaceRoot) => ipcRenderer.invoke('git:getRepository', { workspaceRoot }),
  getGitDiff: (workspaceRoot, filePath, staged) => ipcRenderer.invoke('git:getDiff', { workspaceRoot, filePath, staged }),
  stageGitFile: (workspaceRoot, filePath) => ipcRenderer.invoke('git:stageFile', { workspaceRoot, filePath }),
  unstageGitFile: (workspaceRoot, filePath) => ipcRenderer.invoke('git:unstageFile', { workspaceRoot, filePath }),
  discardGitFile: (workspaceRoot, filePath) => ipcRenderer.invoke('git:discardFile', { workspaceRoot, filePath }),
  commitGitChanges: (workspaceRoot, message) => ipcRenderer.invoke('git:commit', { workspaceRoot, message }),
  setActiveWorkspaceRoot: (rootPath) => ipcRenderer.invoke('workspace:setActiveRoot', { rootPath }),
  removeWorkspaceRoot: (rootPath) => ipcRenderer.invoke('workspace:removeRoot', { rootPath }),
  setWorkspaceRoots: (rootPaths) => ipcRenderer.invoke('workspace:setRoots', { rootPaths }),
  listWorkspaceDir: (dirPath) => ipcRenderer.invoke('fs:listWorkspaceDir', { dirPath }),
  readWorkspaceTextFile: (filePath) => ipcRenderer.invoke('fs:readWorkspaceTextFile', { filePath }),
  readWorkspaceTextFileTail: (filePath, maxChars) => ipcRenderer.invoke('fs:readWorkspaceTextFileTail', { filePath, maxChars }),
  readWorkspaceFile: (filePath) => ipcRenderer.invoke('fs:readWorkspaceFile', { filePath }),
  writeWorkspaceTextFile: (filePath, contents) => ipcRenderer.invoke('fs:writeWorkspaceTextFile', { filePath, contents }),
  openArbitraryTextFile: () => ipcRenderer.invoke('fs:openArbitraryTextFile'),
  getClaudeMemorySnapshot: (workspaceRoot) => ipcRenderer.invoke('claude:getMemorySnapshot', { workspaceRoot }),
  readClaudeMemoryFile: (filePath, workspaceRoot) => ipcRenderer.invoke('claude:readMemoryFile', { filePath, workspaceRoot }),
  revealClaudePath: (filePath, workspaceRoot) => ipcRenderer.invoke('claude:revealPath', { filePath, workspaceRoot }),
  getTerminalState: () => ipcRenderer.invoke('terminal:getState'),
  createTerminalSession: (cwd, title) => ipcRenderer.invoke('terminal:createSession', { cwd, title }),
  setActiveTerminalSession: (sessionId) => ipcRenderer.invoke('terminal:setActiveSession', { sessionId }),
  closeTerminalSession: (sessionId) => ipcRenderer.invoke('terminal:closeSession', { sessionId }),
  writeTerminalInput: (data, sessionId, source) => ipcRenderer.invoke('terminal:write', { data, sessionId, source }),
  execWorkspaceCommand: (command, timeoutMs) => ipcRenderer.invoke('terminal:execWorkspaceCommand', { command, timeoutMs }),
  runTerminalCommandWithCapture: (command, timeoutMs, sessionId) => ipcRenderer.invoke('terminal:runCommandWithCapture', { command, timeoutMs, sessionId }),
  resizeTerminal: (cols, rows) => ipcRenderer.invoke('terminal:resize', { cols, rows }),
  restartTerminal: (sessionId) => ipcRenderer.invoke('terminal:restart', { sessionId }),
  interruptTerminal: (sessionId) => ipcRenderer.invoke('terminal:interrupt', { sessionId }),
  onTerminalEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('terminal:event', wrapped);
    return () => ipcRenderer.removeListener('terminal:event', wrapped);
  },
  onWorkspaceEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('workspace:event', wrapped);
    return () => ipcRenderer.removeListener('workspace:event', wrapped);
  },
  onAppUpdateEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('app-update:event', wrapped);
    return () => ipcRenderer.removeListener('app-update:event', wrapped);
  }
});
