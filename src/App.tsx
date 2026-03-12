import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import './App.css';
import { Sidebar, type PageId } from './renderer/components/Sidebar';
import { TerminalPanel, type TerminalPanelHandle } from './renderer/components/TerminalPanel';
import { nativeAgentClient } from './renderer/nativeAgentClient';
import type { TerminalCommandResult } from './renderer/terminalClient';
import { fsClient, type OpenClawInstallerState } from './renderer/fsClient';
import { ChatPage } from './renderer/pages/ChatPage';
import { GitPage } from './renderer/pages/GitPage';
import { SettingsPage, type ModelProfile, type SettingsState } from './renderer/pages/SettingsPage';

const DEFAULT_PROFILE: ModelProfile = {
  id: 'default-profile',
  name: 'Copilot',
  providerId: 'github_copilot',
  baseUrl: 'http://127.0.0.1:4141',
  apiKey: '',
  model: 'gpt-5.2',
  interactionMode: 'standard',
  inlineCompletionsEnabled: false,
  agentPatchesEnabled: false
};

const DEFAULT_SETTINGS: SettingsState = {
  activeProfileId: DEFAULT_PROFILE.id,
  profiles: [DEFAULT_PROFILE],
  uiFontSize: 13,
  chatFontSize: 13,
  editorFontSize: 13,
  terminalFontSize: 12,
  uiFontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  chatFontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  editorFontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace',
  terminalFontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace',
};

const MIN_ASSISTANT_VISIBLE_HEIGHT = 420;
const MIN_ASSISTANT_VISIBLE_HEIGHT_CLAUDE_CLI = 160;
const SETTINGS_PERSIST_DEBOUNCE_MS = 220;
const TERMINAL_HEIGHT_PERSIST_DEBOUNCE_MS = 120;

function getTerminalMaxHeight(interactionMode?: ModelProfile['interactionMode']) {
  const minAssistantVisibleHeight = interactionMode === 'claude_cli'
    ? MIN_ASSISTANT_VISIBLE_HEIGHT_CLAUDE_CLI
    : MIN_ASSISTANT_VISIBLE_HEIGHT;

  if (typeof window === 'undefined') return 420;
  return Math.max(180, window.innerHeight - minAssistantVisibleHeight);
}

function normalizeInteractionMode(value: unknown): ModelProfile['interactionMode'] {
  if (value === 'native_agent' || value === 'claude_code') return 'native_agent';
  if (value === 'claude_cli') return 'claude_cli';
  return 'standard';
}

function normalizeSettings(parsed: Partial<SettingsState> & {
  fontSize?: number;
  providerId?: ModelProfile['providerId'];
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  interactionMode?: string;
  inlineCompletionsEnabled?: boolean;
  agentPatchesEnabled?: boolean;
}): SettingsState {
  const fallbackFontSize = typeof parsed.fontSize === 'number' ? parsed.fontSize : DEFAULT_SETTINGS.uiFontSize;
  const profiles = Array.isArray(parsed.profiles) && parsed.profiles.length
    ? parsed.profiles.map((profile, index): ModelProfile => ({
        id: typeof profile.id === 'string' && profile.id ? profile.id : `profile-${index + 1}`,
        name: typeof profile.name === 'string' && profile.name ? profile.name : `Profile ${index + 1}`,
        providerId: profile.providerId ?? DEFAULT_PROFILE.providerId,
        baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : DEFAULT_PROFILE.baseUrl,
        apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : DEFAULT_PROFILE.apiKey,
        model: typeof profile.model === 'string' ? profile.model : DEFAULT_PROFILE.model,
        interactionMode: normalizeInteractionMode(profile.interactionMode),
        inlineCompletionsEnabled: typeof profile.inlineCompletionsEnabled === 'boolean' ? profile.inlineCompletionsEnabled : DEFAULT_PROFILE.inlineCompletionsEnabled,
        agentPatchesEnabled: typeof profile.agentPatchesEnabled === 'boolean' ? profile.agentPatchesEnabled : DEFAULT_PROFILE.agentPatchesEnabled
      }))
    : [{
        ...DEFAULT_PROFILE,
        providerId: parsed.providerId ?? DEFAULT_PROFILE.providerId,
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_PROFILE.baseUrl,
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_PROFILE.apiKey,
        model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_PROFILE.model,
        interactionMode: normalizeInteractionMode(parsed.interactionMode),
        inlineCompletionsEnabled: typeof parsed.inlineCompletionsEnabled === 'boolean' ? parsed.inlineCompletionsEnabled : DEFAULT_PROFILE.inlineCompletionsEnabled,
        agentPatchesEnabled: typeof parsed.agentPatchesEnabled === 'boolean' ? parsed.agentPatchesEnabled : DEFAULT_PROFILE.agentPatchesEnabled
      }];

  const activeProfileId = typeof parsed.activeProfileId === 'string' && profiles.some((profile) => profile.id === parsed.activeProfileId)
    ? parsed.activeProfileId
    : profiles[0].id;

  return {
    activeProfileId,
    profiles,
    uiFontSize: typeof parsed.uiFontSize === 'number' ? parsed.uiFontSize : fallbackFontSize,
    chatFontSize: typeof parsed.chatFontSize === 'number' ? parsed.chatFontSize : fallbackFontSize,
    editorFontSize: typeof parsed.editorFontSize === 'number' ? parsed.editorFontSize : fallbackFontSize,
    terminalFontSize: typeof parsed.terminalFontSize === 'number' ? parsed.terminalFontSize : Math.max(11, fallbackFontSize - 1),
    uiFontFamily: typeof parsed.uiFontFamily === 'string' ? parsed.uiFontFamily : DEFAULT_SETTINGS.uiFontFamily,
    chatFontFamily: typeof parsed.chatFontFamily === 'string' ? parsed.chatFontFamily : DEFAULT_SETTINGS.chatFontFamily,
    editorFontFamily: typeof parsed.editorFontFamily === 'string' ? parsed.editorFontFamily : DEFAULT_SETTINGS.editorFontFamily,
    terminalFontFamily: typeof parsed.terminalFontFamily === 'string' ? parsed.terminalFontFamily : DEFAULT_SETTINGS.terminalFontFamily
  };
}

function OpenClawRailIcon({ installed }: { installed: boolean }) {
  if (!installed) {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M12 4.5v9" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
        <path d="M8.75 10.75 12 14l3.25-3.25" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6 18.25h12" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24">
      <path d="M7.5 7.5 4.75 5.5 3.5 8.5l3.25 1.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 7.5 19.25 5.5 20.5 8.5l-3.25 1.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 8.75c0-1.25 1.35-2.25 3-2.25s3 1 3 2.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8.25 10.25c0 3.85 1.65 7.25 3.75 7.25s3.75-3.4 3.75-7.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 11.5h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8.1 12.1 5.6 14.2M15.9 12.1l2.5 2.1M8.85 14.5 6.9 17.1M15.15 14.5l1.95 2.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10.15" cy="9.25" r="0.7" fill="currentColor" />
      <circle cx="13.85" cy="9.25" r="0.7" fill="currentColor" />
    </svg>
  );
}

function App() {
  const [activePage, setActivePage] = useState<PageId>('project');
  const [openProjectRequestKey, setOpenProjectRequestKey] = useState(0);
  const [openClawInstallRequestKey, setOpenClawInstallRequestKey] = useState(0);
  const [openClawSetupRequestKey, setOpenClawSetupRequestKey] = useState(0);
  const [openClawCloseRequestKey, setOpenClawCloseRequestKey] = useState(0);
  const [isInstallerCardOpen, setIsInstallerCardOpen] = useState(false);
  const [workspaceToolsState, setWorkspaceToolsState] = useState({
    workspaceRoot: null as string | null,
    openClawInstalled: false,
    openClawVersion: null as string | null,
    openClawChecking: false,
    openClawDialogOpen: false
  });
  const [openClawInstallerState, setOpenClawInstallerState] = useState<OpenClawInstallerState>({
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
  });
  const [settings, setSettings] = useState<SettingsState>(() => {
    const raw = localStorage.getItem('settings');
    if (raw) {
      try {
        return normalizeSettings(JSON.parse(raw) as Partial<SettingsState> & { fontSize?: number });
      } catch {
        // ignore
      }
    }

    return DEFAULT_SETTINGS;
  });

  const [themeMode, setThemeMode] = useState<'system' | 'dark' | 'light'>(() => {
    const raw = localStorage.getItem('themeMode');
    return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : 'system';
  });

  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0] ?? DEFAULT_PROFILE;
  const isProjectPage = activePage === 'project';
  const activePageLabel = activePage === 'project' ? 'Project' : activePage === 'git' ? 'Git' : 'Settings';

  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(true);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const raw = Number(localStorage.getItem('terminalHeight'));
    const maxHeight = getTerminalMaxHeight(activeProfile.interactionMode);
    const safeDefault = Math.min(220, maxHeight);
    if (!Number.isFinite(raw) || raw < 180) return safeDefault;
    return Math.max(180, Math.min(raw, maxHeight));
  });

  const terminalPanelRef = useRef<TerminalPanelHandle | null>(null);
  const terminalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const installerCardRef = useRef<HTMLDivElement | null>(null);
  const settingsPersistTimerRef = useRef<number | null>(null);
  const pendingSettingsRef = useRef<SettingsState | null>(null);
  const terminalHeightPersistTimerRef = useRef<number | null>(null);
  const pendingTerminalHeightRef = useRef<number | null>(null);

  const clearPersistTimer = useCallback((timerRef: MutableRefObject<number | null>) => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flushSettingsPersist = useCallback(() => {
    const pending = pendingSettingsRef.current;
    if (!pending) return;
    localStorage.setItem('settings', JSON.stringify(pending));
    pendingSettingsRef.current = null;
    clearPersistTimer(settingsPersistTimerRef);
  }, [clearPersistTimer]);

  const scheduleSettingsPersist = useCallback((next: SettingsState) => {
    pendingSettingsRef.current = next;
    clearPersistTimer(settingsPersistTimerRef);
    settingsPersistTimerRef.current = window.setTimeout(() => {
      flushSettingsPersist();
    }, SETTINGS_PERSIST_DEBOUNCE_MS);
  }, [clearPersistTimer, flushSettingsPersist]);

  const flushTerminalHeightPersist = useCallback(() => {
    const pending = pendingTerminalHeightRef.current;
    if (pending === null) return;
    localStorage.setItem('terminalHeight', String(pending));
    pendingTerminalHeightRef.current = null;
    clearPersistTimer(terminalHeightPersistTimerRef);
  }, [clearPersistTimer]);

  const scheduleTerminalHeightPersist = useCallback((next: number) => {
    pendingTerminalHeightRef.current = next;
    clearPersistTimer(terminalHeightPersistTimerRef);
    terminalHeightPersistTimerRef.current = window.setTimeout(() => {
      flushTerminalHeightPersist();
    }, TERMINAL_HEIGHT_PERSIST_DEBOUNCE_MS);
  }, [clearPersistTimer, flushTerminalHeightPersist]);

  useEffect(() => {
    scheduleSettingsPersist(settings);
  }, [scheduleSettingsPersist, settings]);

  useEffect(() => {
    localStorage.setItem('themeMode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    scheduleTerminalHeightPersist(terminalHeight);
  }, [scheduleTerminalHeightPersist, terminalHeight]);

  useEffect(() => {
    function flushPendingStorage() {
      flushSettingsPersist();
      flushTerminalHeightPersist();
    }

    window.addEventListener('pagehide', flushPendingStorage);
    return () => {
      window.removeEventListener('pagehide', flushPendingStorage);
      flushPendingStorage();
    };
  }, [flushSettingsPersist, flushTerminalHeightPersist]);

  useEffect(() => {
    let cancelled = false;

    void fsClient.getOpenClawInstallerState().then((nextState) => {
      if (!cancelled) {
        setOpenClawInstallerState(nextState);
      }
    }).catch(() => {});

    const unsubscribe = fsClient.onOpenClawInstallerEvent((nextState) => {
      setOpenClawInstallerState(nextState);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = fsClient.onAppCommand((event) => {
      if (event.type === 'open-project') {
        setActivePage('project');
        setOpenProjectRequestKey((value) => value + 1);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (openClawInstallerState.status === 'idle') {
      setIsInstallerCardOpen(false);
      return;
    }

    if (openClawInstallerState.status === 'error') {
      setIsInstallerCardOpen(true);
    }
  }, [openClawInstallerState.status]);

  useEffect(() => {
    if (!isInstallerCardOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!installerCardRef.current?.contains(event.target as Node)) {
        setIsInstallerCardOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsInstallerCardOpen(false);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isInstallerCardOpen]);

  const installerPercent = openClawInstallerState.status === 'success'
    ? 100
    : Math.max(10, openClawInstallerState.percent ?? 14);
  const installerStatusText = openClawInstallerState.status === 'running'
    ? openClawInstallerState.percent !== null ? `${Math.round(openClawInstallerState.percent)}%` : 'Working…'
    : openClawInstallerState.status === 'success' ? 'Done' : 'Issue';
  const installerTitle = openClawInstallerState.mode === 'update' ? 'OpenClaw Update' : 'OpenClaw Install';

  useEffect(() => {
    function onPointerMove(ev: PointerEvent) {
      const drag = terminalResizeRef.current;
      if (!drag) return;
      const maxHeight = getTerminalMaxHeight(activeProfile.interactionMode);
      const nextHeight = Math.max(180, Math.min(maxHeight, drag.startHeight + (drag.startY - ev.clientY)));
      setTerminalHeight(nextHeight);
    }

    function onPointerUp() {
      terminalResizeRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [activeProfile.interactionMode]);

  useEffect(() => {
    function clampTerminalHeightOnResize() {
      const maxHeight = getTerminalMaxHeight(activeProfile.interactionMode);
      setTerminalHeight((prev) => Math.max(180, Math.min(prev, maxHeight)));
    }

    window.addEventListener('resize', clampTerminalHeightOnResize);
    return () => window.removeEventListener('resize', clampTerminalHeightOnResize);
  }, [activeProfile.interactionMode]);

  async function runTerminalCommandFromChat(command: string, timeoutMs = 20000): Promise<TerminalCommandResult> {
    setIsTerminalOpen(true);
    const result = await terminalPanelRef.current?.runCommand(command, timeoutMs);
    terminalPanelRef.current?.focusActiveSession();
    if (!result) {
      throw new Error('Terminal session is unavailable');
    }
    return result;
  }

  async function interruptAgentRunFromChat(): Promise<void> {
    setIsTerminalOpen(true);
    await terminalPanelRef.current?.interruptAgentCommand();
    terminalPanelRef.current?.focusActiveSession();
  }

  async function ensureTerminalOpenAndFocused() {
    setIsTerminalOpen(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminalPanelRef.current?.focusActiveSession();
  }

  async function sendCommandToTerminal(command: string): Promise<void> {
    setIsTerminalOpen(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionId = await terminalPanelRef.current?.sendCommand(command);
    if (sessionId === null || sessionId === undefined) {
      throw new Error('Terminal session is unavailable');
    }
    terminalPanelRef.current?.focusActiveSession();
  }

  function toggleChatDrawer() {
    setIsChatDrawerOpen((value) => !value);
  }

  async function sendPromptToClaudeCliFromChat(prompt: string): Promise<void> {
    await ensureTerminalOpenAndFocused();
    await nativeAgentClient.sendPrompt(prompt);
    terminalPanelRef.current?.focusActiveSession();
  }

  async function interruptClaudeCliFromChat(): Promise<void> {
    await ensureTerminalOpenAndFocused();
    await nativeAgentClient.interrupt();
    terminalPanelRef.current?.focusActiveSession();
  }

  const appStyle = {
    '--font-ui': settings.uiFontFamily,
    '--font-chat': settings.chatFontFamily,
    '--font-editor': settings.editorFontFamily,
    '--font-terminal': settings.terminalFontFamily,
    '--font-size-ui': `${settings.uiFontSize}px`,
    '--font-size-chat': `${settings.chatFontSize}px`,
    '--font-size-editor': `${settings.editorFontSize}px`,
    '--font-size-terminal': `${settings.terminalFontSize}px`
  } as CSSProperties;

  return (
    <div className="appShell" data-theme={themeMode === 'system' ? undefined : themeMode} style={appStyle}>
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
      />

      <div className="contentColumn">
        <div className={isProjectPage ? 'contentBody withSideRail' : 'contentBody'}>
          <div className={isProjectPage ? 'main' : 'main scrollable'}>
            {activePage === 'project' ? (
              <ChatPage
                settings={activeProfile}
                profiles={settings.profiles}
                activeProfileId={settings.activeProfileId}
                openProjectRequestKey={openProjectRequestKey}
                openClawInstallRequestKey={openClawInstallRequestKey}
                openClawSetupRequestKey={openClawSetupRequestKey}
                openClawCloseRequestKey={openClawCloseRequestKey}
                onWorkspaceToolsStateChange={setWorkspaceToolsState}
                onSelectProfile={(profileId) => setSettings((prev) => ({ ...prev, activeProfileId: profileId }))}
                onOpenGitPage={() => setActivePage('git')}
                isDrawerOpen={isChatDrawerOpen}
                onToggleDrawer={toggleChatDrawer}
                onRunCommandInTerminal={runTerminalCommandFromChat}
                onSendCommandToTerminal={sendCommandToTerminal}
                onInterruptAgentRun={interruptAgentRunFromChat}
                onSendPromptToClaudeCli={sendPromptToClaudeCliFromChat}
                onFocusClaudeCliTerminal={ensureTerminalOpenAndFocused}
                onInterruptClaudeCli={interruptClaudeCliFromChat}
              />
            ) : activePage === 'git' ? (
              <GitPage onRunCommandInTerminal={runTerminalCommandFromChat} />
            ) : (
              <SettingsPage settings={settings} onChange={setSettings} themeMode={themeMode} onThemeChange={setThemeMode} />
            )}
          </div>

          {isProjectPage ? (
            <aside className="appSideRail" aria-label="Workspace tools">
              <button
                type="button"
                className={isChatDrawerOpen && !workspaceToolsState.openClawDialogOpen ? 'appSideRailItem active' : 'appSideRailItem'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (workspaceToolsState.openClawDialogOpen || !isChatDrawerOpen) {
                    setOpenClawCloseRequestKey((value) => value + 1);
                    setIsChatDrawerOpen(true);
                    return;
                  }
                  toggleChatDrawer();
                }}
                aria-pressed={isChatDrawerOpen && !workspaceToolsState.openClawDialogOpen}
                title={isChatDrawerOpen && !workspaceToolsState.openClawDialogOpen ? 'Hide Inspiration panel' : 'Show Inspiration panel'}
              >
                <span className="appSideRailGlyph" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 3.5 4.5 7.75v8.5L12 20.5l7.5-4.25v-8.5L12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
                    <path d="M9 10.5h6M9 13.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="appSideRailText">Bot</span>
                <span className="appSideRailMeta">{isChatDrawerOpen && !workspaceToolsState.openClawDialogOpen ? 'On' : 'Off'}</span>
              </button>

              <button
                type="button"
                className={workspaceToolsState.openClawDialogOpen ? 'appSideRailItem active' : 'appSideRailItem'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (workspaceToolsState.openClawDialogOpen) {
                    setOpenClawCloseRequestKey((value) => value + 1);
                    return;
                  }
                  setIsChatDrawerOpen(false);
                  setOpenClawInstallRequestKey((value) => value + 1);
                }}
                aria-pressed={workspaceToolsState.openClawDialogOpen}
                title={workspaceToolsState.openClawInstalled
                  ? `Open OpenClaw${workspaceToolsState.openClawVersion ? ` (${workspaceToolsState.openClawVersion})` : ''}`
                  : 'Set up OpenClaw'}
              >
                <span className="appSideRailGlyph" aria-hidden="true">
                  <OpenClawRailIcon installed={workspaceToolsState.openClawInstalled} />
                </span>
                <span className="appSideRailText">OpenClaw</span>
                <span className="appSideRailMeta">
                  {workspaceToolsState.openClawInstalled ? 'On' : workspaceToolsState.openClawChecking ? '...' : 'Off'}
                </span>
              </button>

              <button type="button" className="appSideRailItem placeholder" disabled title="Reserved for future workspace tools">
                <span className="appSideRailGlyph" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M6 12h12M12 6v12" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="appSideRailText">Next Tool</span>
                <span className="appSideRailMeta">Soon</span>
              </button>
            </aside>
          ) : null}
        </div>
        <TerminalPanel
          ref={terminalPanelRef}
          isOpen={isTerminalOpen}
          height={terminalHeight}
          themeMode={themeMode}
          settings={settings}
          onResizeStart={(event) => {
            terminalResizeRef.current = { startY: event.clientY, startHeight: terminalHeight };
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'row-resize';
          }}
        />
      </div>

      <div className="statusBar">
        <div className="statusBarGroup">
          <button className="statusBarItem" type="button">
            Inspiration
          </button>
          <div className="statusBarSep" />
          <button className="statusBarItem" type="button">
            {activePageLabel}
          </button>
        </div>

        <div className="statusBarGroup">
          {openClawInstallerState.status !== 'idle' ? (
            <>
              <div className="statusBarSep" />
              <div ref={installerCardRef} className={`statusBarInstallerDock ${openClawInstallerState.status}`}>
                <button
                  type="button"
                  className={`statusBarInstallerChip ${openClawInstallerState.status}${isInstallerCardOpen ? ' open' : ''}`}
                  title={openClawInstallerState.detail ?? openClawInstallerState.message}
                  onClick={() => setIsInstallerCardOpen((value) => !value)}
                  aria-expanded={isInstallerCardOpen}
                >
                  <span className="statusBarInstallerChipLabel">{installerTitle}</span>
                  <span className="statusBarInstallerChipMeta">{installerStatusText}</span>
                  <span className="statusBarInstallerChipProgress" aria-hidden="true">
                    <span style={{ width: `${installerPercent}%` }} />
                  </span>
                </button>

                {isInstallerCardOpen ? (
                  <div className={`statusBarInstallerPopover ${openClawInstallerState.status}`} role="dialog" aria-label="OpenClaw installer progress">
                    <div className="statusBarInstallerPopoverHeader">
                      <div>
                        <div className="statusBarInstallerPopoverTitle">{installerTitle}</div>
                        <div className="statusBarInstallerPopoverState">{installerStatusText}</div>
                      </div>
                      <button
                        type="button"
                        className="statusBarInstallerGhostButton"
                        onClick={() => setIsInstallerCardOpen(false)}
                        aria-label="Collapse installer card"
                      >
                        Hide
                      </button>
                    </div>
                    <div className="statusBarInstallerMeta">{openClawInstallerState.message}</div>
                    <div className="statusBarInstallerDetail">{openClawInstallerState.detail ?? 'Background OpenClaw installer is running.'}</div>
                    <div className="statusBarInstallerProgress" aria-hidden="true">
                      <span style={{ width: `${installerPercent}%` }} />
                    </div>
                    <div className="statusBarInstallerActions">
                      <button
                        type="button"
                        className="statusBarInstallerButton"
                        onClick={() => {
                          setIsInstallerCardOpen(false);
                          setActivePage('project');
                          setOpenClawSetupRequestKey((value) => value + 1);
                        }}
                      >
                        Open Details
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
          <button
            className="statusBarItem"
            type="button"
            onClick={() => setIsTerminalOpen((v) => !v)}
          >
            {isTerminalOpen ? 'Terminal: On' : 'Terminal: Off'}
          </button>
        </div>
      </div>
    </div>

  );
}

export default App;
