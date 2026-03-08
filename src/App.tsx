import { useEffect, useRef, useState, type CSSProperties } from 'react';
import './App.css';
import { Sidebar, type PageId } from './renderer/components/Sidebar';
import { TerminalPanel, type TerminalPanelHandle } from './renderer/components/TerminalPanel';
import { claudeCodeClient } from './renderer/claudeCodeClient';
import type { TerminalCommandResult } from './renderer/terminalClient';
import { ChatPage } from './renderer/pages/ChatPage';
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

function getTerminalMaxHeight() {
  if (typeof window === 'undefined') return 420;
  return Math.max(180, window.innerHeight - MIN_ASSISTANT_VISIBLE_HEIGHT);
}

function normalizeSettings(parsed: Partial<SettingsState> & {
  fontSize?: number;
  providerId?: ModelProfile['providerId'];
  baseUrl?: string;
  apiKey?: string;
  model?: string;
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
        interactionMode: profile.interactionMode === 'claude_code'
          ? 'claude_code'
          : profile.interactionMode === 'claude_cli'
            ? 'claude_cli'
            : 'standard',
        inlineCompletionsEnabled: typeof profile.inlineCompletionsEnabled === 'boolean' ? profile.inlineCompletionsEnabled : DEFAULT_PROFILE.inlineCompletionsEnabled,
        agentPatchesEnabled: typeof profile.agentPatchesEnabled === 'boolean' ? profile.agentPatchesEnabled : DEFAULT_PROFILE.agentPatchesEnabled
      }))
    : [{
        ...DEFAULT_PROFILE,
        providerId: parsed.providerId ?? DEFAULT_PROFILE.providerId,
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULT_PROFILE.baseUrl,
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_PROFILE.apiKey,
        model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_PROFILE.model,
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

function App() {
  const [activePage, setActivePage] = useState<PageId>('project');
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

  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(true);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const raw = Number(localStorage.getItem('terminalHeight'));
    const maxHeight = getTerminalMaxHeight();
    const safeDefault = Math.min(220, maxHeight);
    if (!Number.isFinite(raw) || raw < 180) return safeDefault;
    return Math.max(180, Math.min(raw, maxHeight));
  });

  const terminalPanelRef = useRef<TerminalPanelHandle | null>(null);
  const terminalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    localStorage.setItem('settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('themeMode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem('terminalHeight', String(terminalHeight));
  }, [terminalHeight]);

  useEffect(() => {
    function onPointerMove(ev: PointerEvent) {
      const drag = terminalResizeRef.current;
      if (!drag) return;
      const maxHeight = getTerminalMaxHeight();
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
  }, []);

  useEffect(() => {
    function clampTerminalHeightOnResize() {
      const maxHeight = getTerminalMaxHeight();
      setTerminalHeight((prev) => Math.max(180, Math.min(prev, maxHeight)));
    }

    window.addEventListener('resize', clampTerminalHeightOnResize);
    return () => window.removeEventListener('resize', clampTerminalHeightOnResize);
  }, []);

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

  async function sendPromptToClaudeCliFromChat(prompt: string): Promise<void> {
    await ensureTerminalOpenAndFocused();
    await claudeCodeClient.sendPrompt(prompt);
    terminalPanelRef.current?.focusActiveSession();
  }

  async function interruptClaudeCliFromChat(): Promise<void> {
    await ensureTerminalOpenAndFocused();
    await claudeCodeClient.interrupt();
    terminalPanelRef.current?.focusActiveSession();
  }

  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0] ?? DEFAULT_PROFILE;

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
        <div className="main">
          {activePage === 'project' ? (
            <ChatPage
              settings={activeProfile}
              profiles={settings.profiles}
              activeProfileId={settings.activeProfileId}
              onSelectProfile={(profileId) => setSettings((prev) => ({ ...prev, activeProfileId: profileId }))}
              isDrawerOpen={isChatDrawerOpen}
              onToggleDrawer={() => setIsChatDrawerOpen((v) => !v)}
              onRunCommandInTerminal={runTerminalCommandFromChat}
              onInterruptAgentRun={interruptAgentRunFromChat}
              onSendPromptToClaudeCli={sendPromptToClaudeCliFromChat}
              onInterruptClaudeCli={interruptClaudeCliFromChat}
            />
          ) : (
            <SettingsPage settings={settings} onChange={setSettings} themeMode={themeMode} onThemeChange={setThemeMode} />
          )}
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
            assistant-desk
          </button>
          <div className="statusBarSep" />
          <button className="statusBarItem" type="button">
            {activePage === 'project' ? 'Project' : 'Settings'}
          </button>
        </div>

        <div className="statusBarGroup">
          <button
            className="statusBarItem"
            type="button"
            onClick={() => setIsChatDrawerOpen((v) => !v)}
          >
            {isChatDrawerOpen ? 'Assistant: On' : 'Assistant: Off'}
          </button>
          <div className="statusBarSep" />
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
