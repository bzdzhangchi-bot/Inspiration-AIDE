import { useEffect, useMemo, useState } from 'react';
import type { InteractionMode, ProviderId } from '../../shared/types';

export type ModelProfile = {
  id: string;
  name: string;
  providerId: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  interactionMode: InteractionMode;
  inlineCompletionsEnabled: boolean;
  agentPatchesEnabled: boolean;
};

export type SettingsState = {
  activeProfileId: string;
  profiles: ModelProfile[];
  uiFontSize: number;
  chatFontSize: number;
  editorFontSize: number;
  terminalFontSize: number;
  uiFontFamily: string;
  chatFontFamily: string;
  editorFontFamily: string;
  terminalFontFamily: string;
};

type ValidationIssue = {
  severity: 'error' | 'warning';
  message: string;
};

const FONT_FAMILY_PRESETS = {
  ui: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace',
  serif: 'Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, Times New Roman, serif'
};

function makeProfileId() {
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createEmptyProfile(): ModelProfile {
  return {
    id: makeProfileId(),
    name: 'New Profile',
    providerId: 'github_copilot',
    baseUrl: 'http://127.0.0.1:4141',
    apiKey: '',
    model: 'gpt-5.2',
    interactionMode: 'standard',
    inlineCompletionsEnabled: false,
    agentPatchesEnabled: false
  };
}

function providerLabelFor(providerId: ProviderId) {
  if (providerId === 'github_copilot') return 'Copilot';
  if (providerId === 'anthropic') return 'Anthropic-Compatible';
  return 'OpenAI-Compatible';
}

function modeLabelFor(mode: InteractionMode) {
  if (mode === 'claude_cli') return 'Claude CLI';
  if (mode === 'native_agent') return 'Native Agent';
  return 'Standard';
}

function profileMetaText(profile: ModelProfile) {
  const modeLabel = modeLabelFor(profile.interactionMode);

  if (profile.interactionMode === 'claude_cli') {
    return `${modeLabel} · Local runtime (provider/model managed by the local CLI runtime)`;
  }

  const provider = providerLabelFor(profile.providerId);
  const model = profile.model.trim() || 'No model';
  return `${provider} · ${modeLabel} · ${model}`;
}

function shouldSuggestClaudeModel(model: string) {
  const value = model.trim().toLowerCase();
  if (!value) return true;
  return value.startsWith('gpt-') || value.startsWith('glm-');
}

function normalizeByInteraction(profile: ModelProfile, nextMode: InteractionMode): ModelProfile {
  if (nextMode === 'claude_cli') {
    return {
      ...profile,
      interactionMode: 'claude_cli',
      name: profile.name.trim() ? profile.name : 'Claude CLI'
    };
  }

  if (nextMode === 'native_agent') {
    const keepCopilotDefaults = profile.providerId === 'github_copilot';

    return {
      ...profile,
      interactionMode: 'native_agent',
      baseUrl: profile.baseUrl.trim()
        ? profile.baseUrl
        : keepCopilotDefaults
          ? 'http://127.0.0.1:4141'
          : 'https://api.anthropic.com',
      model: shouldSuggestClaudeModel(profile.model) ? 'claude-sonnet-4-5' : profile.model
    };
  }

  return {
    ...profile,
    interactionMode: 'standard'
  };
}

function baseUrlLabelFor(providerId: ProviderId) {
  if (providerId === 'github_copilot') return 'Gateway URL';
  if (providerId === 'anthropic') return 'Endpoint URL';
  return 'Base URL';
}

function baseUrlPlaceholderFor(providerId: ProviderId) {
  if (providerId === 'github_copilot') return 'http://127.0.0.1:4141';
  if (providerId === 'anthropic') return 'https://api.anthropic.com or compatible endpoint';
  return 'https://your-openai-compatible-endpoint';
}

function validateProfile(profile: ModelProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const name = profile.name.trim();
  const model = profile.model.trim();
  const baseUrl = profile.baseUrl.trim();
  const apiKey = profile.apiKey.trim();

  if (!name) {
    issues.push({ severity: 'warning', message: 'Profile name is empty.' });
  }

  if (profile.interactionMode === 'claude_cli') {
    if (baseUrl || apiKey || model) {
      issues.push({ severity: 'warning', message: 'Claude CLI mode ignores provider/model fields in this form.' });
    }
    return issues;
  }

  if (!model) {
    issues.push({ severity: 'error', message: 'Model is required.' });
  }


  if ((profile.providerId === 'openai_compat' || profile.providerId === 'github_copilot') && !baseUrl) {
    issues.push({ severity: 'error', message: `${baseUrlLabelFor(profile.providerId)} is required.` });
  }

  if (profile.providerId !== 'github_copilot' && !apiKey) {
    issues.push({ severity: 'error', message: 'API key / token is required for this provider.' });
  }

  if (profile.providerId === 'anthropic' && shouldSuggestClaudeModel(model) && model) {
    issues.push({ severity: 'warning', message: 'Model looks non-Claude for Anthropic provider. Confirm this endpoint supports it.' });
  }

  return issues;
}

function areProfilesEqual(left: ModelProfile, right: ModelProfile) {
  return left.id === right.id
    && left.name === right.name
    && left.providerId === right.providerId
    && left.baseUrl === right.baseUrl
    && left.apiKey === right.apiKey
    && left.model === right.model
    && left.interactionMode === right.interactionMode
    && left.inlineCompletionsEnabled === right.inlineCompletionsEnabled
    && left.agentPatchesEnabled === right.agentPatchesEnabled;
}

function areSettingsEqual(left: SettingsState, right: SettingsState) {
  if (left === right) return true;
  if (left.activeProfileId !== right.activeProfileId) return false;
  if (left.uiFontSize !== right.uiFontSize) return false;
  if (left.chatFontSize !== right.chatFontSize) return false;
  if (left.editorFontSize !== right.editorFontSize) return false;
  if (left.terminalFontSize !== right.terminalFontSize) return false;
  if (left.uiFontFamily !== right.uiFontFamily) return false;
  if (left.chatFontFamily !== right.chatFontFamily) return false;
  if (left.editorFontFamily !== right.editorFontFamily) return false;
  if (left.terminalFontFamily !== right.terminalFontFamily) return false;
  if (left.profiles.length !== right.profiles.length) return false;

  for (let index = 0; index < left.profiles.length; index += 1) {
    if (!areProfilesEqual(left.profiles[index], right.profiles[index])) {
      return false;
    }
  }

  return true;
}

function formatBytes(value: number | null | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value ?? 0;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatPublishedAt(value: string | null) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SettingsPage(props: {
  settings: SettingsState;
  onChange: (next: SettingsState) => void;
  themeMode: 'system' | 'dark' | 'light';
  onThemeChange: (next: 'system' | 'dark' | 'light') => void;
}) {
  const { settings, onChange, themeMode, onThemeChange } = props;
  const [tab, setTab] = useState<'model' | 'appearance' | 'app'>('model');
  const [draft, setDraft] = useState<SettingsState>(settings);
  const [selectedProfileId, setSelectedProfileId] = useState(settings.activeProfileId);
  const [isProfilesHelpOpen, setIsProfilesHelpOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateSummary, setUpdateSummary] = useState<AppUpdateSummary | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ fileName: string; percent: number | null; receivedBytes: number; totalBytes: number | null } | null>(null);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
    setSelectedProfileId(settings.activeProfileId);
  }, [settings]);

  useEffect(() => {
    if (!isProfilesHelpOpen) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsProfilesHelpOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isProfilesHelpOpen]);

  useEffect(() => {
    let cancelled = false;

    void window.assistantDesk.getAppInfo().then((info) => {
      if (!cancelled) setAppInfo(info);
    }).catch(() => {
      if (!cancelled) setAppInfo(null);
    });

    const unsubscribe = window.assistantDesk.onAppUpdateEvent((event) => {
      if (event.type === 'download-start') {
        setIsDownloadingUpdate(true);
        setDownloadedUpdatePath(null);
        setUpdateError(null);
        setDownloadProgress({
          fileName: event.fileName,
          percent: 0,
          receivedBytes: 0,
          totalBytes: null
        });
        return;
      }

      if (event.type === 'download-progress') {
        setIsDownloadingUpdate(true);
        setDownloadProgress({
          fileName: event.fileName,
          percent: event.percent,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes
        });
        return;
      }

      setIsDownloadingUpdate(false);
      setDownloadedUpdatePath(event.filePath);
      setDownloadProgress({
        fileName: event.fileName,
        percent: 100,
        receivedBytes: event.totalBytes,
        totalBytes: event.totalBytes
      });
      if (event.openError) {
        setUpdateError(`Installer downloaded, but macOS could not open it automatically: ${event.openError}`);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const isDirty = useMemo(() => !areSettingsEqual(draft, settings), [draft, settings]);
  const selectedProfile = useMemo(() => {
    return draft.profiles.find((profile) => profile.id === selectedProfileId) ?? draft.profiles[0] ?? null;
  }, [draft.profiles, selectedProfileId]);
  const validationByProfile = useMemo(() => {
    const map = new Map<string, ValidationIssue[]>();
    for (const profile of draft.profiles) {
      map.set(profile.id, validateProfile(profile));
    }
    return map;
  }, [draft.profiles]);
  const totalErrors = useMemo(() => {
    let count = 0;
    for (const issues of validationByProfile.values()) {
      count += issues.filter((item) => item.severity === 'error').length;
    }
    return count;
  }, [validationByProfile]);
  const totalWarnings = useMemo(() => {
    let count = 0;
    for (const issues of validationByProfile.values()) {
      count += issues.filter((item) => item.severity === 'warning').length;
    }
    return count;
  }, [validationByProfile]);
  const selectedProfileIssues = useMemo(() => {
    if (!selectedProfile) return [];
    return validationByProfile.get(selectedProfile.id) ?? [];
  }, [selectedProfile, validationByProfile]);
  const canSave = isDirty && totalErrors === 0;
  const pageSubtitle = tab === 'model'
    ? 'Manage multiple model profiles and chat modes'
    : tab === 'appearance'
      ? 'Theme and typography'
      : 'App identity, release channel, and updates';
  const defaultProfile = useMemo(() => {
    return draft.profiles.find((profile) => profile.id === draft.activeProfileId) ?? draft.profiles[0] ?? null;
  }, [draft.activeProfileId, draft.profiles]);
  const savedDefaultProfile = useMemo(() => {
    return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0] ?? null;
  }, [settings.activeProfileId, settings.profiles]);
  const defaultProfileChanged = draft.activeProfileId !== settings.activeProfileId;
  const isNativeAgentProfile = selectedProfile?.interactionMode === 'native_agent';
  const isClaudeCliProfile = selectedProfile?.interactionMode === 'claude_cli';
  const selectedProfileSummary = useMemo(() => {
    if (!selectedProfile) return '';
    return profileMetaText(selectedProfile);
  }, [selectedProfile]);

  async function checkForUpdates() {
    setIsCheckingUpdates(true);
    setUpdateError(null);
    try {
      const summary = await window.assistantDesk.checkForUpdates();
      setUpdateSummary(summary);
      if (!summary.asset) {
        setUpdateError(`Latest release found, but no ${appInfo?.arch ?? 'current'} installer asset was matched.`);
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Failed to check for updates.');
    } finally {
      setIsCheckingUpdates(false);
    }
  }

  async function downloadLatestUpdate() {
    setIsDownloadingUpdate(true);
    setUpdateError(null);
    try {
      const summary = await window.assistantDesk.downloadLatestUpdate();
      setUpdateSummary(summary);
      if (summary.downloadedFilePath) {
        setDownloadedUpdatePath(summary.downloadedFilePath);
      }
      if (summary.openError) {
        setUpdateError(`Installer downloaded, but macOS could not open it automatically: ${summary.openError}`);
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Failed to download update.');
    } finally {
      setIsDownloadingUpdate(false);
    }
  }


  function updateSelectedProfile(updater: (profile: ModelProfile) => ModelProfile) {
    if (!selectedProfile) return;
    setDraft((prev) => ({
      ...prev,
      profiles: prev.profiles.map((profile) => (profile.id === selectedProfile.id ? updater(profile) : profile))
    }));
  }

  function renderFontControls(
    label: string,
    sizeKey: keyof Pick<SettingsState, 'uiFontSize' | 'chatFontSize' | 'editorFontSize' | 'terminalFontSize'>,
    familyKey: keyof Pick<SettingsState, 'uiFontFamily' | 'chatFontFamily' | 'editorFontFamily' | 'terminalFontFamily'>
  ) {
    return (
      <>
        <div className="row">
          <div className="label">{label} size</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="range"
              min={11}
              max={20}
              value={draft[sizeKey]}
              onChange={(e) => setDraft({ ...draft, [sizeKey]: Number(e.target.value) })}
            />
            <div className="pill" style={{ opacity: 1 }}>
              {draft[sizeKey]}px
            </div>
          </div>
        </div>

        <div className="row">
          <div className="label">{label} family</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <select
              value={draft[familyKey]}
              onChange={(e) => setDraft({ ...draft, [familyKey]: e.target.value })}
            >
              <option value={FONT_FAMILY_PRESETS.ui}>System Sans</option>
              <option value={FONT_FAMILY_PRESETS.mono}>Mono</option>
              <option value={FONT_FAMILY_PRESETS.serif}>Serif</option>
            </select>
            <input
              value={draft[familyKey]}
              onChange={(e) => setDraft({ ...draft, [familyKey]: e.target.value })}
              placeholder="Custom font-family stack"
            />
          </div>
        </div>
      </>
    );
  }

  function addProfile() {
    const nextProfile = createEmptyProfile();
    setDraft((prev) => ({
      ...prev,
      activeProfileId: nextProfile.id,
      profiles: [...prev.profiles, nextProfile]
    }));
    setSelectedProfileId(nextProfile.id);
  }

  function duplicateProfile(profileId?: string) {
    const sourceProfile = draft.profiles.find((profile) => profile.id === profileId) ?? selectedProfile;
    if (!sourceProfile) return;
    const duplicate: ModelProfile = {
      ...sourceProfile,
      id: makeProfileId(),
      name: `${sourceProfile.name} Copy`
    };
    setDraft((prev) => ({
      ...prev,
      profiles: [...prev.profiles, duplicate]
    }));
    setSelectedProfileId(duplicate.id);
  }

  function removeProfile(profileId?: string) {
    const targetId = profileId ?? selectedProfile?.id;
    if (!targetId || draft.profiles.length <= 1) return;
    const targetProfile = draft.profiles.find((profile) => profile.id === targetId);
    const confirmed = window.confirm(`Remove profile "${targetProfile?.name ?? 'this profile'}"?\n\nThis only changes your local saved profiles and can be undone only before you save.`);
    if (!confirmed) return;
    const nextProfiles = draft.profiles.filter((profile) => profile.id !== targetId);
    const fallbackId = nextProfiles[0]?.id ?? '';
    const nextSelectedId = selectedProfileId === targetId ? fallbackId : selectedProfileId;
    setDraft((prev) => ({
      ...prev,
      activeProfileId: prev.activeProfileId === targetId ? fallbackId : prev.activeProfileId,
      profiles: nextProfiles
    }));
    setSelectedProfileId(nextSelectedId);
  }

  function renderCommonProfileFields(profile: ModelProfile) {
    const isDefaultProfile = draft.activeProfileId === profile.id;

    return (
      <>
        <div className="settingsSection">
          <div className="settingsSectionHeader">
            <div className="settingsSectionTitle">Profile</div>
            <div className="settingsSectionHint">Choose how this profile appears in chat and which workflow it uses.</div>
          </div>

          <div className="form">
            <div className="row">
              <div className="label">Active in chat</div>
              <div className="profileDefaultRow">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="radio"
                    checked={isDefaultProfile}
                    onChange={() => setDraft({ ...draft, activeProfileId: profile.id })}
                  />
                  Use this profile by default
                </label>
                <button
                  type="button"
                  className={isDefaultProfile ? 'secondaryButton is-active' : 'secondaryButton'}
                  onClick={() => setDraft({ ...draft, activeProfileId: profile.id })}
                  disabled={isDefaultProfile}
                >
                  {isDefaultProfile ? 'Default profile' : 'Set as default'}
                </button>
              </div>
            </div>

            <div className="row">
              <div className="label">Profile name</div>
              <input
                value={profile.name}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, name: e.target.value }))}
                placeholder="Coding model / GPT-5 / Local gateway"
              />
            </div>

            <div className="row">
              <div className="label">Interaction</div>
              <select
                value={profile.interactionMode}
                onChange={(e) => updateSelectedProfile((current) => normalizeByInteraction(current, e.target.value as InteractionMode))}
              >
                <option value="standard">Standard chat</option>
                <option value="claude_cli">Claude CLI</option>
                <option value="native_agent">Native agent</option>
              </select>
            </div>
          </div>
        </div>
      </>
    );
  }

  function renderClaudeCliForm(profile: ModelProfile) {
    return (
      <>
        {renderCommonProfileFields(profile)}

        <div className="settingsSection">
          <div className="settingsSectionHeader">
            <div className="settingsSectionTitle">Claude CLI Runtime</div>
            <div className="settingsSectionHint">This mode launches the real Claude Code CLI from your local PATH and lets the GUI act as its shell.</div>
          </div>

          <div className="form">
            <div className="row">
              <div className="label">Runtime source</div>
              <div className="settingsReadonlyValue">Local `claude` executable from PATH</div>
            </div>

            <div className="row">
              <div className="label">Provider settings</div>
              <div className="settingsReadonlyValue">Handled by the local CLI runtime. This GUI does not inject model/provider prompts in this mode.</div>
            </div>

            <div className="row">
              <div className="label">Model settings</div>
              <div className="settingsReadonlyValue">Handled by the local CLI runtime. The values in other modes are kept for switching back only.</div>
            </div>
          </div>

          <div className="footerHint">
            Use this mode when you want the application to host the real local CLI runtime. Skills, session behavior, and approvals should come from the CLI runtime rather than this app.
          </div>
        </div>
      </>
    );
  }

  function renderClaudeCodeForm(profile: ModelProfile) {
    return (
      <>
        {renderCommonProfileFields(profile)}

        <div className="settingsSection">
          <div className="settingsSectionHeader">
            <div className="settingsSectionTitle">Native Agent Access</div>
            <div className="settingsSectionHint">This is the app's self-hosted coding agent mode. Configure the provider, credential, and model it should use.</div>
          </div>

          <div className="providerCardGrid">
            <button
              type="button"
              className={profile.providerId === 'anthropic' ? 'providerCard active' : 'providerCard'}
              onClick={() => updateSelectedProfile((current) => ({ ...current, providerId: 'anthropic' }))}
            >
              <span className="providerCardTitle">Anthropic-Compatible (Claude Messages API)</span>
              <span className="providerCardMeta">Use this when the endpoint speaks Anthropic's `/v1/messages` format, such as Anthropic itself or Anthropic-compatible services like DashScope.</span>
            </button>

            <button
              type="button"
              className={profile.providerId === 'openai_compat' ? 'providerCard active' : 'providerCard'}
              onClick={() => updateSelectedProfile((current) => ({ ...current, providerId: 'openai_compat' }))}
            >
              <span className="providerCardTitle">OpenAI-Compatible (Chat Completions / Responses)</span>
              <span className="providerCardMeta">Use this for OpenAI-style APIs with a custom Base URL and API key, including OpenAI, OpenRouter, local gateways, or other OpenAI-compatible proxies.</span>
            </button>

            <button
              type="button"
              className={profile.providerId === 'github_copilot' ? 'providerCard active' : 'providerCard'}
              onClick={() => updateSelectedProfile((current) => ({ ...current, providerId: 'github_copilot', baseUrl: current.baseUrl.trim() ? current.baseUrl : 'http://127.0.0.1:4141' }))}
            >
              <span className="providerCardTitle">Copilot (local gateway)</span>
              <span className="providerCardMeta">Use the local gateway at http://127.0.0.1:4141 (POST /v1/messages?beta=true).</span>
            </button>
          </div>

          <div className="settingsMiniNote">
            This form configures the app's own agent runtime. It can mimic a coding workflow, but it is not the local CLI runtime.
          </div>
        </div>

        <div className="settingsSection">
          <div className="settingsSectionHeader">
            <div className="settingsSectionTitle">Authentication</div>
            <div className="settingsSectionHint">
              {profile.providerId === 'anthropic'
                ? 'Provide an Anthropic-compatible endpoint and token. Choose this when your service expects Anthropic Claude Messages API requests.'
                : profile.providerId === 'github_copilot'
                  ? 'Provide the local gateway URL. Token is optional if your gateway does not require it.'
                  : 'Provide the Base URL and credential for an OpenAI-compatible API. Choose this when your service expects OpenAI-style requests.'}
            </div>
          </div>

          <div className="form">
            {profile.providerId === 'openai_compat' || profile.providerId === 'anthropic' || profile.providerId === 'github_copilot' ? (
              <div className="row">
                <div className="label">{profile.providerId === 'anthropic' ? 'Endpoint URL' : profile.providerId === 'github_copilot' ? 'Gateway URL' : 'Gateway URL'}</div>
                <input
                  value={profile.baseUrl}
                  onChange={(e) => updateSelectedProfile((current) => ({ ...current, baseUrl: e.target.value }))}
                  placeholder={
                    profile.providerId === 'anthropic'
                      ? 'https://api.anthropic.com or https://dashscope.aliyuncs.com/apps/anthropic'
                      : profile.providerId === 'github_copilot'
                        ? 'http://127.0.0.1:4141'
                        : 'https://your-gateway.example.com'
                  }
                />
              </div>
            ) : (
              <div className="row">
                <div className="label">Endpoint</div>
                <div className="settingsReadonlyValue">Official Anthropic endpoint</div>
              </div>
            )}

            <div className="row">
              <div className="label">API token</div>
              <input
                value={profile.apiKey}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, apiKey: e.target.value }))}
                placeholder={
                  profile.providerId === 'anthropic'
                    ? 'Anthropic-compatible token'
                    : profile.providerId === 'github_copilot'
                      ? 'Optional for local Copilot gateway'
                      : 'Gateway API key'
                }
              />
            </div>
          </div>

          {profile.providerId === 'anthropic' ? (
            <div className="settingsMiniNote">
              Example: DashScope Anthropic gateway. Endpoint = `https://dashscope.aliyuncs.com/apps/anthropic`, token = your DashScope API key, model = the Anthropic-compatible model name exposed there.
            </div>
          ) : profile.providerId === 'openai_compat' ? (
            <div className="settingsMiniNote">
              Example: OpenAI-compatible endpoint. Base URL = your provider's OpenAI-style API root, token = your provider API key, model = the model id exposed by that service.
            </div>
          ) : null}
        </div>

        <div className="settingsSection">
          <div className="settingsSectionHeader">
            <div className="settingsSectionTitle">Model And Session</div>
            <div className="settingsSectionHint">This profile keeps its own persistent coding conversation and uses a stronger execution-oriented system prompt.</div>
          </div>

          <div className="form">
            <div className="row">
              <div className="label">Model</div>
              <input
                value={profile.model}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, model: e.target.value }))}
                placeholder={profile.providerId === 'anthropic' ? 'claude-sonnet-4-5 / claude-opus-4-1' : 'gpt-5 / gpt-4.1 / provider-specific model id'}
              />
            </div>

            <div className="row">
              <div className="label">Capabilities</div>
              <div className="settingsToggleGroup">
                <label className="settingsToggleCard">
                  <input
                    type="checkbox"
                    checked={profile.inlineCompletionsEnabled}
                    onChange={(e) => updateSelectedProfile((current) => ({ ...current, inlineCompletionsEnabled: e.target.checked }))}
                  />
                  <span>
                    <strong>Inline completions</strong>
                    <small>Use the same profile for editor completion requests.</small>
                  </span>
                </label>

                <label className="settingsToggleCard">
                  <input
                    type="checkbox"
                    checked={profile.agentPatchesEnabled}
                    onChange={(e) => updateSelectedProfile((current) => ({ ...current, agentPatchesEnabled: e.target.checked }))}
                  />
                  <span>
                    <strong>Agent patches</strong>
                    <small>Allow this profile to generate workspace patch proposals.</small>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div className="footerHint">
            Native agent profiles keep their own persistent conversation and execution policy inside this app.
          </div>
        </div>
      </>
    );
  }

  function renderStandardForm(profile: ModelProfile) {
    return (
      <>
        {renderCommonProfileFields(profile)}

        <div className="settingsSection">
          <div className="settingsSectionHeader">
            <div className="settingsSectionTitle">Provider And Model</div>
            <div className="settingsSectionHint">Standard chat mode uses the provider and model configured below.</div>
          </div>

          <div className="form">
            <div className="row">
              <div className="label">Provider</div>
              <select
                value={profile.providerId}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, providerId: e.target.value as ProviderId }))}
              >
                <option value="openai_compat">OpenAI compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="github_copilot">Copilot (local gateway)</option>
              </select>
            </div>

            <div className="row">
              <div className="label">{baseUrlLabelFor(profile.providerId)}</div>
              <input
                value={profile.baseUrl}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, baseUrl: e.target.value }))}
                placeholder={baseUrlPlaceholderFor(profile.providerId)}
              />
            </div>

            <div className="row">
              <div className="label">API key / token</div>
              <input
                value={profile.apiKey}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, apiKey: e.target.value }))}
                placeholder={profile.providerId === 'github_copilot' ? 'Optional for local Copilot gateway' : 'Provider API key'}
              />
            </div>

            <div className="row">
              <div className="label">Model</div>
              <input
                value={profile.model}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, model: e.target.value }))}
                placeholder="gpt-5.2 / claude-sonnet / claude-opus"
              />
            </div>

            <div className="row">
              <div className="label">Capabilities</div>
              <div className="settingsToggleGroup">
                <label className="settingsToggleCard">
                  <input
                    type="checkbox"
                    checked={profile.inlineCompletionsEnabled}
                    onChange={(e) => updateSelectedProfile((current) => ({ ...current, inlineCompletionsEnabled: e.target.checked }))}
                  />
                  <span>
                    <strong>Inline completions</strong>
                    <small>Use this profile for editor completion requests.</small>
                  </span>
                </label>

                <label className="settingsToggleCard">
                  <input
                    type="checkbox"
                    checked={profile.agentPatchesEnabled}
                    onChange={(e) => updateSelectedProfile((current) => ({ ...current, agentPatchesEnabled: e.target.checked }))}
                  />
                  <span>
                    <strong>Agent patches</strong>
                    <small>Allow this profile to propose workspace patches.</small>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div className="footerHint">
            For Claude Code CLI behavior, switch Interaction to `Claude CLI`; provider/model fields here are only for app-managed chat requests.
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <div>
          <div className="pageTitle">Settings</div>
          <div className="pageSubtitle">{pageSubtitle}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isDirty ? <div className="pill" style={{ opacity: 1 }}>Unsaved</div> : null}
          {defaultProfileChanged ? <div className="pill" style={{ opacity: 1 }}>Default profile changed</div> : null}
          {totalErrors > 0 ? <div className="pill" style={{ opacity: 1 }}>{totalErrors} error{totalErrors > 1 ? 's' : ''}</div> : null}
          {totalWarnings > 0 ? <div className="pill" style={{ opacity: 1 }}>{totalWarnings} warning{totalWarnings > 1 ? 's' : ''}</div> : null}
          <button type="button" disabled={!canSave} onClick={() => onChange(draft)}>
            Save
          </button>
        </div>
      </div>

      {isProfilesHelpOpen ? (
        <div className="settingsHelpOverlay" role="presentation" onClick={() => setIsProfilesHelpOpen(false)}>
          <div className="settingsHelpDialog" role="dialog" aria-modal="true" aria-label="Profiles help" onClick={(e) => e.stopPropagation()}>
            <div className="settingsHelpDialogHeader">
              <div className="settingsHelpDialogTitle">Profiles help</div>
              <button type="button" className="settingsHelpCloseButton" aria-label="Close" onClick={() => setIsProfilesHelpOpen(false)}>
                &times;
              </button>
            </div>
            <div className="settingsHelpDialogBody">
              <h2>中文</h2>
              <p>
                <strong>Profile（配置档）</strong> 是一组可复用的助手配置，包含 provider、gateway / endpoint、token、model，以及
                <strong>Interaction（交互模式）</strong>。你可以创建多个 profile，在设置页编辑它们，并在聊天页随时切换。
              </p>

              <h3>Profiles 现在能做什么</h3>
              <ul>
                <li>创建多个 profile，并在左侧列表里直接复制或删除单个 profile。</li>
                <li>为每个 profile 单独保存 provider、base URL、token、model、interaction mode 和能力开关。</li>
                <li>用 <strong>Active in chat</strong> 把某个 profile 设为默认 profile。</li>
                <li>在聊天页顶部直接切换 profile；每个 profile 都维护自己的聊天线程和历史摘要。</li>
                <li>把同一个 provider 配成不同用途，例如一个 profile 做标准聊天，另一个 profile 做 Native Agent。</li>
              </ul>

              <h3>有两个“选中”概念</h3>
              <ul>
                <li><strong>左侧高亮的 profile</strong>：表示你当前正在编辑哪一个 profile。</li>
                <li><strong>Active in chat / Default</strong>：表示应用默认会用哪一个 profile 进入聊天。</li>
                <li>聊天页顶部切换 profile 后，当前聊天使用的 profile 也会随之更新，并保存为新的默认选项。</li>
                <li>如果你改了默认 profile，但还没保存，页面顶部和右侧编辑区都会显示待保存提示。</li>
              </ul>

              <h3>Interaction modes（交互模式）</h3>

              <h4>Standard（标准聊天）</h4>
              <ul>
                <li>使用本应用内置的流式聊天请求（streaming tokens）。</li>
                <li>provider / endpoint / token / model 这些字段都会用于实际 API 请求。</li>
                <li>适合先验证 endpoint、model 和 token 是否可用。</li>
                <li>适合普通问答、代码解释、轻量修改建议。</li>
              </ul>

              <h4>Native Agent（应用内置 Agent）</h4>
              <ul>
                <li>使用本应用自带的 coding-agent 工作流（工具调用、workspace 上下文、计划/执行过程等）。</li>
                <li>
                  需要已打开的 workspace root；如果当前没有 workspace，将会<strong>回退到 Standard</strong> 聊天路径。
                </li>
                <li>该模式现在可以使用 Copilot（local gateway）、Anthropic-Compatible（Claude Messages API）或 OpenAI-Compatible，前提是对应 provider 本身可连通。</li>
                <li>
                  注意：这里的 “Native Agent” 指的是<strong>本应用内置的 agent 实现</strong>，不是 local CLI 本体。
                </li>
                <li>该模式会使用 workspace context、工具调用和更偏执行型的系统提示词，并可在聊天页查看 Inspector / progress 信息。</li>
                <li>更适合“继续做这个重构”“先看看工程再改”“读文件后给出 patch”这类任务。</li>
              </ul>

              <h4>Claude CLI（claude_cli，CLI 模式）</h4>
              <ul>
                <li>将提示词转发给本机的 local CLI 运行时来执行。</li>
                <li>
                  在该模式下，本页的 provider/model 等设置对实际运行<strong>不生效</strong>：认证、provider 与 model 选择由 CLI 自己管理。
                </li>
                <li>适合你希望 GUI 只是“托管/承载”真实 Claude Code 运行时及其审批体验时使用。</li>
              </ul>

              <h3>Provider（服务商/网关）是什么意思？</h3>
              <ul>
                <li><strong>Anthropic-Compatible（Claude Messages API）</strong>：使用 Anthropic 风格的接口与 token，例如官方 Claude API 或兼容 Anthropic Messages API 的端点。</li>
                <li><strong>OpenAI-Compatible</strong>：使用 OpenAI 风格的 Base URL + API key，例如 OpenAI、自建代理、OpenRouter 或其他兼容 OpenAI API 的网关。</li>
                <li><strong>Copilot</strong>：走本地 gateway，默认地址通常是 `http://127.0.0.1:4141`。现在既可用于 Standard，也可用于 Native Agent。</li>
                <li>如果一个服务给的是 Anthropic `/v1/messages` 风格地址，例如 `https://dashscope.aliyuncs.com/apps/anthropic`，应选择 <strong>Anthropic-Compatible</strong>。</li>
                <li>如果一个服务给的是 OpenAI 风格 Base URL + Bearer key，应选择 <strong>OpenAI-Compatible</strong>。</li>
              </ul>

              <h3>Capabilities（能力开关）</h3>
              <ul>
                <li><strong>Inline completions</strong>：允许该 profile 被编辑器补全请求使用。</li>
                <li><strong>Agent patches</strong>：允许该 profile 生成工作区 patch 提案。</li>
                <li>这两个开关是按 profile 单独保存的，不同 profile 可以有不同策略。</li>
              </ul>

              <h3>连接检查会做什么？</h3>
              <ul>
                <li>保存前不强制联网，但聊天页会根据当前 profile 自动做 provider 连通性检查。</li>
                <li>Anthropic-Compatible 会优先验证 Anthropic 风格接口；OpenAI-Compatible 会验证 OpenAI 风格接口。</li>
                <li>如果服务端返回了更具体的错误信息，应用会尽量直接显示原始错误，而不是只显示泛化状态码文案。</li>
              </ul>

              <h3>常见问题（FAQ）</h3>
              <ul>
                <li>
                  <strong>我选了 Native Agent，但看起来还是 Standard。</strong> 请先确认已打开 workspace；没有 workspace 时，应用会自动回退到标准聊天路径。
                </li>
                <li>
                  <strong>为什么 Claude CLI 模式不读取这里的 API key？</strong> 因为该模式由本机 CLI 管理认证与 provider/model，本 GUI 不会注入这些字段。
                </li>
                <li>
                  <strong>为什么我在设置页点了某个 profile，但聊天还不是它？</strong> 因为“左侧选中”只是进入编辑；要让它成为默认聊天 profile，需要打开该 profile 的 <strong>Active in chat</strong>。
                </li>
                <li>
                  <strong>切换聊天页顶部 profile 会不会丢历史？</strong> 不会。每个 profile 都有自己的线程和摘要，切换后会显示该 profile 对应的聊天内容。
                </li>
                <li>
                  <strong>为什么模型明明存在，却提示 not found / not supported？</strong> 常见原因是 provider 协议选错了。例如 Anthropic-Compatible 和 OpenAI-Compatible 对同一个服务可能对应不同的模型集合和请求格式。
                </li>
              </ul>

              <hr />

              <h2>English</h2>
              <p>
                A <strong>profile</strong> is a reusable assistant configuration. It stores provider settings, endpoint / gateway information,
                credentials, model name, and an <strong>Interaction</strong> mode. You can edit multiple profiles here and switch between them in chat.
              </p>

              <h3>What Profiles Can Do</h3>
              <ul>
                <li>Create multiple profiles, and duplicate or remove each profile directly from the left list.</li>
                <li>Store provider, base URL, token, model, interaction mode, and capability flags per profile.</li>
                <li>Mark one profile as the default with <strong>Active in chat</strong>.</li>
                <li>Switch profiles directly from the chat header; each profile keeps its own thread and history summary.</li>
                <li>Use different profiles for different workflows, for example Standard chat vs Native Agent.</li>
              </ul>

              <h3>Two Different “Selections”</h3>
              <ul>
                <li><strong>The highlighted item in the left list</strong> is the profile you are currently editing.</li>
                <li><strong>Active in chat / Default</strong> is the profile the app will use by default in chat.</li>
                <li>Switching the profile from the chat header updates the current chat profile and persists that choice.</li>
                <li>If you change the default profile but have not saved yet, the page header and editor panel will show a pending-change notice.</li>
              </ul>

              <h3>Interaction modes</h3>

              <h4>Standard</h4>
              <ul>
                <li>Uses this app&apos;s built-in streaming chat runtime.</li>
                <li>Provider / endpoint / token / model are taken from this form and used for API requests.</li>
                <li>Best for quickly validating whether an endpoint, model, and credential are usable.</li>
                <li>Best for normal Q&amp;A, code explanation, and lightweight assistance.</li>
              </ul>

              <h4>Native Agent (built-in agent)</h4>
              <ul>
                <li>Uses this app&apos;s built-in coding-agent workflow, including tool use, workspace-aware context, and execution planning.</li>
                <li>
                  Requires an opened workspace root. If no workspace is available, the app <strong>falls back to Standard</strong> chat behavior.
                </li>
                <li>This mode now works with Copilot (local gateway), Anthropic-Compatible (Claude Messages API), or OpenAI-Compatible providers, as long as the connection is valid.</li>
                <li>
                  Note: this "Native Agent" is implemented in this app. It is <strong>not</strong> the local CLI runtime.
                </li>
                <li>This mode uses workspace context, tool calls, and a more execution-oriented system prompt, and you can inspect progress / runtime context from chat.</li>
                <li>Best for tasks like exploring a repo, reading files first, and then producing patches or stepwise changes.</li>
              </ul>

              <h4>Claude CLI (claude_cli)</h4>
              <ul>
                <li>Routes prompts to your local local CLI runtime.</li>
                <li>
                  In this mode, provider/model settings in this GUI are <strong>ignored</strong> for the actual run (the CLI manages them).
                </li>
                <li>Use this when you want the GUI to behave like a shell around the real Claude Code runtime and approvals.</li>
              </ul>

              <h3>What does Provider mean?</h3>
              <ul>
                <li><strong>Anthropic-Compatible (Claude Messages API)</strong>: use an Anthropic-style endpoint + token, such as the official Claude API or another Anthropic-compatible service.</li>
                <li><strong>OpenAI-Compatible</strong>: use an OpenAI-style Base URL + API key, such as OpenAI, OpenRouter, or another OpenAI-compatible gateway/proxy.</li>
                <li><strong>Copilot</strong>: uses a local gateway, typically `http://127.0.0.1:4141`. It can now be used for both Standard chat and Native Agent mode.</li>
                <li>If a service gives you an Anthropic `/v1/messages` style endpoint such as `https://dashscope.aliyuncs.com/apps/anthropic`, choose <strong>Anthropic-Compatible</strong>.</li>
                <li>If a service gives you an OpenAI-style Base URL plus a Bearer key, choose <strong>OpenAI-Compatible</strong>.</li>
              </ul>

              <h3>Capabilities</h3>
              <ul>
                <li><strong>Inline completions</strong>: allows this profile to serve editor completion requests.</li>
                <li><strong>Agent patches</strong>: allows this profile to generate workspace patch proposals.</li>
                <li>These switches are stored per profile, so different profiles can have different execution policies.</li>
              </ul>

              <h3>What Does The Connection Check Do?</h3>
              <ul>
                <li>Saving does not require a live network check, but the chat page will automatically probe the current provider configuration.</li>
                <li>Anthropic-Compatible checks Anthropic-style endpoints; OpenAI-Compatible checks OpenAI-style endpoints.</li>
                <li>When the provider returns a concrete error message, the app tries to surface that original message instead of only showing a generic HTTP status.</li>
              </ul>

              <h3>Common questions</h3>
              <ul>
                <li>
                  <strong>I selected Native Agent but it still looks like Standard.</strong> Make sure a workspace is opened; otherwise the agent
                  workflow will not start and the app will fall back.
                </li>
                <li>
                  <strong>Why doesn&apos;t Claude CLI mode use the API key from this page?</strong> Because the local CLI manages authentication and
                  provider/model selection.
                </li>
                <li>
                  <strong>Why did I click a profile in Settings but chat still uses another one?</strong> Because selecting a profile in the left list only opens it for editing. Use <strong>Active in chat</strong> to make it the default chat profile.
                </li>
                <li>
                  <strong>Will I lose history when switching profiles in chat?</strong> No. Each profile keeps its own thread and summary, and chat switches between those stored threads.
                </li>
                <li>
                  <strong>Why does a model say not found / not supported even though it exists?</strong> A common cause is a provider mismatch. The same service can expose different model sets and request formats through Anthropic-Compatible vs OpenAI-Compatible endpoints.
                </li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      <div className="settingsWorkspace">
        <aside className="card settingsPrimaryNav" aria-label="Settings sections">
          <button type="button" className={tab === 'model' ? 'settingsPrimaryNavItem active' : 'settingsPrimaryNavItem'} onClick={() => setTab('model')}>
            <span className="settingsPrimaryNavLabel">Model</span>
            <span className="settingsPrimaryNavMeta">Profiles, providers, runtimes</span>
          </button>
          <button type="button" className={tab === 'appearance' ? 'settingsPrimaryNavItem active' : 'settingsPrimaryNavItem'} onClick={() => setTab('appearance')}>
            <span className="settingsPrimaryNavLabel">Appearance</span>
            <span className="settingsPrimaryNavMeta">Theme, UI, assistant, editor, terminal</span>
          </button>
          <button type="button" className={tab === 'app' ? 'settingsPrimaryNavItem active' : 'settingsPrimaryNavItem'} onClick={() => setTab('app')}>
            <span className="settingsPrimaryNavLabel">App</span>
            <span className="settingsPrimaryNavMeta">Branding, versions, update delivery</span>
          </button>
        </aside>

        {tab === 'model' ? (
          <div className="card settingsCard modelSettingsLayout">
            <div className="profileListPane">
              <div className="profilePaneHeader">
                <div className="cardTitle">Profiles</div>
                <div className="profilePaneHeaderActions">
                  <div className="profilePaneMeta">{draft.profiles.length} configured</div>
                  <div className="profileActionGroup" aria-label="Profile actions">
                    <button type="button" className="profileActionButton" onClick={addProfile} aria-label="Add profile" title="Add profile">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    className="settingsHelpIconButton"
                    aria-label="Profiles help"
                    title="Profiles help"
                    onClick={() => setIsProfilesHelpOpen(true)}
                  >
                    ?
                  </button>
                </div>
              </div>
              <div className="profileListScroll">
                <div className="profileList">
                  {draft.profiles.map((profile) => (
                    <div
                      key={profile.id}
                      className={profile.id === selectedProfileId ? 'profileListEntry active' : 'profileListEntry'}
                    >
                      <button
                        type="button"
                        className="profileListItem"
                        onClick={() => setSelectedProfileId(profile.id)}
                      >
                        <span className="profileListNameRow">
                          <span className="profileListName">{profile.name}</span>
                          {draft.activeProfileId === profile.id ? <span className="profileListBadge">Default</span> : null}
                        </span>
                        <span className="profileListMeta">{profileMetaText(profile)}</span>
                      </button>
                      <div className="profileListItemActions">
                        <button
                          type="button"
                          className="profileActionButton profileActionButtonInline"
                          aria-label={`Duplicate ${profile.name}`}
                          title="Duplicate profile"
                          onClick={(event) => {
                            event.stopPropagation();
                            duplicateProfile(profile.id);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M9 9.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 17 20.5H9A1.5 1.5 0 0 1 7.5 19v-8A1.5 1.5 0 0 1 9 9.5Z" />
                            <path d="M6 14.5H5A1.5 1.5 0 0 1 3.5 13V5A1.5 1.5 0 0 1 5 3.5h8A1.5 1.5 0 0 1 14.5 5v1" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="profileActionButton profileActionButtonInline danger"
                          aria-label={`Remove ${profile.name}`}
                          title="Remove profile"
                          disabled={draft.profiles.length <= 1}
                          onClick={(event) => {
                            event.stopPropagation();
                            removeProfile(profile.id);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 7.5h14" />
                            <path d="M9.5 7.5V5.75A1.25 1.25 0 0 1 10.75 4.5h2.5a1.25 1.25 0 0 1 1.25 1.25V7.5" />
                            <path d="M8 7.5l.7 10.03A1.5 1.5 0 0 0 10.2 19h3.6a1.5 1.5 0 0 0 1.5-1.47L16 7.5" />
                            <path d="M10 10.5v5M14 10.5v5" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="profileListHint" role="note">
                Duplicate and remove are attached to each profile card. Remove stays disabled when only one profile remains.
              </div>
            </div>

            <div className="profileEditorPane">
              {selectedProfile ? (
                <>
                  <div className="profileEditorSummary">
                    <div>
                      <div className="profileEditorSummaryTitle">{selectedProfile.name}</div>
                      <div className="profileEditorSummaryMeta">{selectedProfileSummary}</div>
                    </div>
                    <div className="profileEditorSummaryActions">
                      {draft.activeProfileId === selectedProfile.id ? <div className="pill" style={{ opacity: 1 }}>Default</div> : null}
                      {draft.activeProfileId !== selectedProfile.id ? (
                        <button type="button" className="secondaryButton" onClick={() => setDraft((prev) => ({ ...prev, activeProfileId: selectedProfile.id }))}>
                          Set as default
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {defaultProfileChanged ? (
                    <div className="settingsDefaultProfileNotice">
                      <div className="settingsDefaultProfileNoticeTitle">Default chat profile will change on save</div>
                      <div className="settingsDefaultProfileNoticeText">
                        Next default: <strong>{defaultProfile?.name ?? 'Unknown profile'}</strong>
                        {savedDefaultProfile ? ` · current saved default: ${savedDefaultProfile.name}` : ''}
                      </div>
                    </div>
                  ) : null}
                  {selectedProfileIssues.length ? (
                    <div className="settingsValidationPanel">
                      {selectedProfileIssues.map((issue, index) => (
                        <div key={`${issue.severity}-${index}-${issue.message}`} className={`settingsValidationItem ${issue.severity}`}>
                          <span className="settingsValidationBadge">{issue.severity === 'error' ? 'Error' : 'Warning'}</span>
                          <span>{issue.message}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="settingsValidationPanel ok">
                      <div className="settingsValidationItem ok">
                        <span className="settingsValidationBadge">OK</span>
                        <span>This profile looks ready to use.</span>
                      </div>
                    </div>
                  )}
                  {isClaudeCliProfile
                    ? renderClaudeCliForm(selectedProfile)
                    : isNativeAgentProfile
                      ? renderClaudeCodeForm(selectedProfile)
                      : renderStandardForm(selectedProfile)}
                </>
              ) : null}
            </div>
          </div>
        ) : tab === 'appearance' ? (
          <div className="card settingsScrollCard settingsContentCard">
            <div className="form">
              <div className="settingsSection">
                <div className="settingsSectionHeader">
                  <div className="settingsSectionTitle">Theme</div>
                  <div className="settingsSectionHint">Choose how the application chrome and panels are rendered.</div>
                </div>

                <div className="settingsThemeOptions">
                  <button type="button" className={themeMode === 'system' ? 'settingsThemeOption active' : 'settingsThemeOption'} onClick={() => onThemeChange('system')}>
                    <span className="settingsThemeOptionTitle">System</span>
                    <span className="settingsThemeOptionMeta">Follow the macOS appearance setting.</span>
                  </button>
                  <button type="button" className={themeMode === 'dark' ? 'settingsThemeOption active' : 'settingsThemeOption'} onClick={() => onThemeChange('dark')}>
                    <span className="settingsThemeOptionTitle">Dark</span>
                    <span className="settingsThemeOptionMeta">Use the dark interface all the time.</span>
                  </button>
                  <button type="button" className={themeMode === 'light' ? 'settingsThemeOption active' : 'settingsThemeOption'} onClick={() => onThemeChange('light')}>
                    <span className="settingsThemeOptionTitle">Light</span>
                    <span className="settingsThemeOptionMeta">Use the light interface all the time.</span>
                  </button>
                </div>
              </div>

              {renderFontControls('UI', 'uiFontSize', 'uiFontFamily')}
              {renderFontControls('Inspiration chat', 'chatFontSize', 'chatFontFamily')}
              {renderFontControls('Editor', 'editorFontSize', 'editorFontFamily')}
              {renderFontControls('Terminal', 'terminalFontSize', 'terminalFontFamily')}

              <div className="footerHint">Each area can now use its own size and font stack. Mono works best for editor and terminal.</div>
            </div>
          </div>
        ) : (
          <div className="card settingsScrollCard settingsContentCard">
            <div className="form">
              <div className="settingsSection">
                <div className="settingsSectionHeader">
                  <div className="settingsSectionTitle">About Inspiration</div>
                  <div className="settingsSectionHint">User-facing branding now ships as Inspiration. Local storage paths remain unchanged so existing workspaces, settings, and chat state continue to load.</div>
                </div>

                <div className="settingsAppMetaGrid">
                  <div className="settingsAppMetaCard">
                    <span className="settingsAppMetaLabel">App name</span>
                    <strong>Inspiration</strong>
                  </div>
                  <div className="settingsAppMetaCard">
                    <span className="settingsAppMetaLabel">Current build</span>
                    <strong>{appInfo ? `v${appInfo.displayVersion}` : 'Loading...'}</strong>
                  </div>
                  <div className="settingsAppMetaCard">
                    <span className="settingsAppMetaLabel">Platform</span>
                    <strong>{appInfo ? `${appInfo.platform} / ${appInfo.arch}` : 'Loading...'}</strong>
                  </div>
                  <div className="settingsAppMetaCard">
                    <span className="settingsAppMetaLabel">Release track</span>
                    <strong>{appInfo ? (appInfo.isPackaged ? `Published release v${appInfo.releaseVersion}` : `Local development build from v${appInfo.releaseVersion}`) : 'Loading...'}</strong>
                  </div>
                  <div className="settingsAppMetaCard">
                    <span className="settingsAppMetaLabel">Installer download folder</span>
                    <strong>{appInfo?.downloadsPath ?? 'Loading...'}</strong>
                  </div>
                </div>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionHeader">
                  <div className="settingsSectionTitle">In-App Updates</div>
                  <div className="settingsSectionHint">The app checks the latest GitHub release, matches the current Mac architecture, downloads the installer into Downloads, and opens it for you. This avoids sending users back to GitHub for every upgrade.</div>
                </div>

                <div className="settingsUpdateActions">
                  <button type="button" onClick={() => void checkForUpdates()} disabled={isCheckingUpdates || isDownloadingUpdate}>
                    {isCheckingUpdates ? 'Checking...' : 'Check for updates'}
                  </button>
                  <button
                    type="button"
                    className="secondaryButton"
                    onClick={() => void downloadLatestUpdate()}
                    disabled={isCheckingUpdates || isDownloadingUpdate || updateSummary?.status !== 'available' || !updateSummary?.asset}
                  >
                    {isDownloadingUpdate ? 'Downloading...' : 'Download latest installer'}
                  </button>
                  {updateSummary?.htmlUrl ? (
                    <a className="secondaryButton settingsLinkButton" href={updateSummary.htmlUrl} target="_blank" rel="noreferrer">
                      Open release page
                    </a>
                  ) : null}
                </div>

                <div className={updateSummary?.status === 'available' ? 'settingsUpdateStatus available' : 'settingsUpdateStatus'}>
                  <div className="settingsUpdateStatusTitle">
                    {updateSummary
                      ? updateSummary.status === 'available'
                        ? `Update available: ${updateSummary.latestTag}`
                        : updateSummary.status === 'current'
                          ? 'You are on the latest release'
                          : 'This build is newer than the latest public release'
                      : 'No release check has been run yet'}
                  </div>
                  <div className="settingsUpdateStatusMeta">
                    {updateSummary
                      ? `${updateSummary.releaseName} · published ${formatPublishedAt(updateSummary.publishedAt)}`
                      : 'Run a check to read the latest GitHub release metadata.'}
                  </div>
                  {updateSummary?.asset ? (
                    <div className="settingsMiniNote">
                      Matched installer: `{updateSummary.asset.name}` ({formatBytes(updateSummary.asset.size)})
                    </div>
                  ) : null}
                  {downloadProgress ? (
                    <div className="settingsDownloadProgress">
                      <div className="settingsDownloadProgressRow">
                        <strong>{downloadProgress.fileName}</strong>
                        <span>{downloadProgress.percent === null ? 'Preparing download...' : `${downloadProgress.percent.toFixed(1)}%`}</span>
                      </div>
                      <div className="settingsDownloadProgressBar" aria-hidden="true">
                        <span style={{ width: `${downloadProgress.percent ?? 8}%` }} />
                      </div>
                      <div className="settingsUpdateStatusMeta">
                        {formatBytes(downloadProgress.receivedBytes)} / {formatBytes(downloadProgress.totalBytes)}
                      </div>
                    </div>
                  ) : null}
                  {downloadedUpdatePath ? (
                    <div className="settingsMiniNote">
                      Latest download saved to `{downloadedUpdatePath}`.
                    </div>
                  ) : null}
                  {updateError ? (
                    <div className="settingsUpdateError">{updateError}</div>
                  ) : null}
                </div>
              </div>

              <div className="footerHint">This first version is intentionally installer-based instead of silent self-replacement, which keeps the upgrade flow reliable for unsigned or non-notarized local builds.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
