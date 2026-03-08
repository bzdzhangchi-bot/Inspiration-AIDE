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
  if (providerId === 'anthropic') return 'Anthropic';
  return 'Compatible Gateway';
}

function modeLabelFor(mode: InteractionMode) {
  if (mode === 'claude_cli') return 'Claude CLI';
  if (mode === 'claude_code') return 'Native Agent';
  return 'Standard';
}

function profileMetaText(profile: ModelProfile) {
  const modeLabel = modeLabelFor(profile.interactionMode);

  if (profile.interactionMode === 'claude_cli') {
    return `${modeLabel} · Local runtime (provider/model managed by Claude Code)`;
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

  if (nextMode === 'claude_code') {
    const nextProvider: ProviderId = profile.providerId === 'github_copilot' ? 'anthropic' : profile.providerId;
    return {
      ...profile,
      interactionMode: 'claude_code',
      providerId: nextProvider,
      baseUrl: profile.baseUrl.trim() ? profile.baseUrl : 'https://api.anthropic.com',
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

  if (profile.interactionMode === 'claude_code' && profile.providerId === 'github_copilot') {
    issues.push({ severity: 'error', message: 'Native Agent mode does not support Copilot provider. Use Anthropic or Compatible Gateway.' });
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

export function SettingsPage(props: {
  settings: SettingsState;
  onChange: (next: SettingsState) => void;
  themeMode: 'system' | 'dark' | 'light';
  onThemeChange: (next: 'system' | 'dark' | 'light') => void;
}) {
  const { settings, onChange, themeMode, onThemeChange } = props;
  const [tab, setTab] = useState<'model' | 'appearance'>('model');
  const [draft, setDraft] = useState<SettingsState>(settings);
  const [selectedProfileId, setSelectedProfileId] = useState(settings.activeProfileId);

  useEffect(() => {
    setDraft(settings);
    setSelectedProfileId(settings.activeProfileId);
  }, [settings]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(settings);
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
  const isNativeAgentProfile = selectedProfile?.interactionMode === 'claude_code';
  const isClaudeCliProfile = selectedProfile?.interactionMode === 'claude_cli';
  const selectedProfileSummary = useMemo(() => {
    if (!selectedProfile) return '';
    return profileMetaText(selectedProfile);
  }, [selectedProfile]);

  useEffect(() => {
    if (!selectedProfile) return;
    if (selectedProfile.interactionMode !== 'claude_code') return;
    if (selectedProfile.providerId !== 'github_copilot') return;

    setDraft((prev) => ({
      ...prev,
      profiles: prev.profiles.map((profile) => {
        if (profile.id !== selectedProfile.id) return profile;
        return {
          ...profile,
          providerId: 'anthropic',
          baseUrl: profile.baseUrl.trim() ? profile.baseUrl : 'https://api.anthropic.com',
          model: shouldSuggestClaudeModel(profile.model) ? 'claude-sonnet-4-5' : profile.model
        };
      })
    }));
  }, [selectedProfile]);

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

  function duplicateProfile() {
    if (!selectedProfile) return;
    const duplicate: ModelProfile = {
      ...selectedProfile,
      id: makeProfileId(),
      name: `${selectedProfile.name} Copy`
    };
    setDraft((prev) => ({
      ...prev,
      profiles: [...prev.profiles, duplicate]
    }));
    setSelectedProfileId(duplicate.id);
  }

  function removeProfile() {
    if (!selectedProfile || draft.profiles.length <= 1) return;
    const nextProfiles = draft.profiles.filter((profile) => profile.id !== selectedProfile.id);
    const fallbackId = nextProfiles[0]?.id ?? '';
    setDraft((prev) => ({
      ...prev,
      activeProfileId: prev.activeProfileId === selectedProfile.id ? fallbackId : prev.activeProfileId,
      profiles: nextProfiles
    }));
    setSelectedProfileId(fallbackId);
  }

  function renderCommonProfileFields(profile: ModelProfile) {
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
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="radio"
                  checked={draft.activeProfileId === profile.id}
                  onChange={() => setDraft({ ...draft, activeProfileId: profile.id })}
                />
                Use this profile by default
              </label>
            </div>

            <div className="row">
              <div className="label">Profile name</div>
              <input
                value={profile.name}
                onChange={(e) => updateSelectedProfile((current) => ({ ...current, name: e.target.value }))}
                placeholder="Claude Code / GPT-5 / Local Copilot"
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
                <option value="claude_code">Native agent</option>
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
              <div className="settingsReadonlyValue">Handled by Claude Code itself. This GUI does not inject model/provider prompts in this mode.</div>
            </div>

            <div className="row">
              <div className="label">Model settings</div>
              <div className="settingsReadonlyValue">Handled by Claude Code itself. The values in other modes are kept for switching back only.</div>
            </div>
          </div>

          <div className="footerHint">
            Use this mode when you want the application to host the real Claude Code runtime. Skills, session behavior, and approvals should come from Claude Code rather than this app.
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
              <span className="providerCardTitle">Anthropic-Compatible</span>
              <span className="providerCardMeta">Use the official Claude API or any Anthropic-compatible endpoint such as DashScope.</span>
            </button>

            <button
              type="button"
              className={profile.providerId === 'openai_compat' ? 'providerCard active' : 'providerCard'}
              onClick={() => updateSelectedProfile((current) => ({ ...current, providerId: 'openai_compat' }))}
            >
              <span className="providerCardTitle">Compatible Gateway</span>
              <span className="providerCardMeta">Use a proxy or compatible endpoint when your Claude traffic is routed through another service.</span>
            </button>
          </div>

          <div className="settingsMiniNote">
            This form configures the app's own agent runtime. It can mimic a coding workflow, but it is not the Claude Code CLI runtime.
          </div>
        </div>

        <div className="settingsSection">
          <div className="settingsSectionHeader">
            <div className="settingsSectionTitle">Authentication</div>
            <div className="settingsSectionHint">
              {profile.providerId === 'anthropic'
                ? 'Provide an Anthropic-compatible endpoint and token. Leave the endpoint empty to use the official Anthropic API.'
                : 'Provide the gateway URL and credential for your compatible endpoint.'}
            </div>
          </div>

          <div className="form">
            {profile.providerId === 'openai_compat' || profile.providerId === 'anthropic' ? (
              <div className="row">
                <div className="label">{profile.providerId === 'anthropic' ? 'Endpoint URL' : 'Gateway URL'}</div>
                <input
                  value={profile.baseUrl}
                  onChange={(e) => updateSelectedProfile((current) => ({ ...current, baseUrl: e.target.value }))}
                  placeholder={profile.providerId === 'anthropic' ? 'https://api.anthropic.com or https://dashscope.aliyuncs.com/apps/anthropic' : 'https://your-gateway.example.com'}
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
                placeholder={profile.providerId === 'anthropic' ? 'Anthropic-compatible token' : 'Gateway API key'}
              />
            </div>
          </div>

          {profile.providerId === 'anthropic' ? (
            <div className="settingsMiniNote">
              DashScope example: endpoint `https://dashscope.aliyuncs.com/apps/anthropic`, token = your DashScope API key, model = the Anthropic-compatible model name exposed there.
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
                placeholder={profile.providerId === 'anthropic' ? 'claude-sonnet-4-5 / claude-opus-4-1' : 'Compatible Claude-capable model'}
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
          <div className="pageSubtitle">{tab === 'model' ? 'Manage multiple model profiles and chat modes' : 'Theme and typography'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isDirty ? <div className="pill" style={{ opacity: 1 }}>Unsaved</div> : null}
          {totalErrors > 0 ? <div className="pill" style={{ opacity: 1 }}>{totalErrors} error{totalErrors > 1 ? 's' : ''}</div> : null}
          {totalWarnings > 0 ? <div className="pill" style={{ opacity: 1 }}>{totalWarnings} warning{totalWarnings > 1 ? 's' : ''}</div> : null}
          <button type="button" disabled={!canSave} onClick={() => onChange(draft)}>
            Save
          </button>
        </div>
      </div>

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
        </aside>

        {tab === 'model' ? (
          <div className="card settingsCard modelSettingsLayout">
            <div className="profileListPane">
              <div className="profilePaneHeader">
                <div className="cardTitle">Profiles</div>
                <div className="profilePaneMeta">{draft.profiles.length} configured</div>
              </div>
              <div className="profileListScroll">
                <div className="profileList">
                  {draft.profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className={profile.id === selectedProfileId ? 'profileListItem active' : 'profileListItem'}
                      onClick={() => setSelectedProfileId(profile.id)}
                    >
                      <span className="profileListName">{profile.name}</span>
                      <span className="profileListMeta">{profileMetaText(profile)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="profileListActions">
                <button type="button" onClick={addProfile}>Add</button>
                <button type="button" onClick={duplicateProfile} disabled={!selectedProfile}>Duplicate</button>
                <button type="button" onClick={removeProfile} disabled={draft.profiles.length <= 1}>Remove</button>
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
                    {draft.activeProfileId === selectedProfile.id ? <div className="pill" style={{ opacity: 1 }}>Default</div> : null}
                  </div>
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
        ) : (
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
              {renderFontControls('Assistant', 'chatFontSize', 'chatFontFamily')}
              {renderFontControls('Editor', 'editorFontSize', 'editorFontFamily')}
              {renderFontControls('Terminal', 'terminalFontSize', 'terminalFontFamily')}

              <div className="footerHint">Each area can now use its own size and font stack. Mono works best for editor and terminal.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}