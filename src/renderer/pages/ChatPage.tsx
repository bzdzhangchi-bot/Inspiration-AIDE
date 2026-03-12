import DOMPurify from 'dompurify';
import { Children, isValidElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { AgentSessionMessage, ChatMessage, ChatRequest } from '../../shared/types';
import { nativeAgentClient, type NativeAgentRuntimeState } from '../nativeAgentClient';
import { checkProviderConnection, openAgentSessionStream, openChatStream } from '../wsClient';
import { fsClient, type AgentMemorySnapshot, type GitRepositorySnapshot, type OpenClawInstallerState } from '../fsClient';
import { terminalClient, type TerminalCommandResult, type TerminalEvent } from '../terminalClient';
import { WorkspacePanel, type OpenClawInstallState, type WorkspacePanelContext, type WorkspacePanelHandle } from '../workspace/WorkspacePanel';
import type { ModelProfile } from './SettingsPage';

type Msg = {
  role: 'user' | 'assistant';
  content: string;
  openClawUsage?: OpenClawUsageMeta;
};

type OpenClawUsageMeta = {
  skillName?: string;
  agentId?: string;
  responseMode?: 'text' | 'json';
  forceSkill?: boolean;
};

type MarkdownParagraphProps = ComponentPropsWithoutRef<'p'>;

function MarkdownParagraph({ children, ...props }: MarkdownParagraphProps) {
  const nodes = Children.toArray(children).filter((child) => {
    if (typeof child !== 'string') return true;
    return child.trim().length > 0;
  });
  if (
    nodes.length === 1
    && isValidElement(nodes[0])
    && typeof nodes[0].type === 'string'
    && nodes[0].type === 'code'
  ) {
    return <span {...props}>{children}</span>;
  }
  return (
    <p {...props}>{children}</p>
  );
}

const MessageList = memo(function MessageList({ messages }: { messages: Msg[] }) {
  return (
    <div>
      {messages.map((message, index) => (
        <div key={index} className={`msg ${message.role === 'user' ? 'user' : 'assistant'}`}>
          <div className="meta">
            <div>{message.role}</div>
            {message.role === 'assistant' && message.openClawUsage ? (
              <div className="messageCapabilityBadge openclaw" title={message.openClawUsage.skillName ? `Delegated via OpenClaw skill ${message.openClawUsage.skillName}` : 'Delegated via OpenClaw'}>
                <span>OpenClaw</span>
                {message.openClawUsage.skillName ? <span>{message.openClawUsage.skillName}</span> : null}
                {message.openClawUsage.forceSkill ? <span>forced</span> : null}
                {message.openClawUsage.responseMode === 'json' ? <span>json</span> : null}
              </div>
            ) : null}
          </div>
          <div className="bubble"><ChatBubbleContent content={message.content} renderMarkdown={message.role === 'assistant'} /></div>
        </div>
      ))}
    </div>
  );
});

type ThreadMap = Record<string, Msg[]>;
type ThreadUpdatedAtMap = Record<string, number>;
type ThreadSummary = {
  messageCount: number;
  lastUserText: string;
  lastAssistantText: string;
};
type ThreadSummaryMap = Record<string, ThreadSummary>;
type ThreadStore = {
  threadsByProfile: ThreadMap;
  threadUpdatedAtByProfile: ThreadUpdatedAtMap;
  threadSummaryByProfile: ThreadSummaryMap;
};
type ConnectionState = {
  key: string;
  status: 'ok' | 'error';
  message: string;
};

type PatchReplacement = {
  oldText: string;
  newText: string;
};

type AgentChoiceOption = {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

type AgentRunStatus = 'idle' | 'planning' | 'running_command' | 'awaiting_input' | 'cancelling';

type PendingAgentQuestion = {
  kind: 'question' | 'plan';
  prompt: string;
  options: AgentChoiceOption[];
  multiSelect: boolean;
  allowFreeform: boolean;
  selectedValues: string[];
};

type RuntimeSkillItem = {
  key: string;
  name: string;
  source: 'workspace' | 'runtime' | 'openclaw';
  meta?: string;
  path?: string;
  preview?: string;
  openClawSkillName?: string;
};

type OpenClawSkillSummary = {
  name: string;
  description?: string;
  emoji?: string;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
  source?: string;
  bundled?: boolean;
  homepage?: string;
  filePath?: string;
};

type OpenClawSkillListResponse = {
  workspaceDir?: string;
  managedSkillsDir?: string;
  skills?: OpenClawSkillSummary[];
};

type OpenClawSkillInfo = OpenClawSkillSummary & {
  baseDir?: string;
  skillKey?: string;
  always?: boolean;
  primaryEnv?: string;
  requirements?: Record<string, unknown>;
  missing?: Record<string, unknown>;
  configChecks?: unknown[];
  install?: unknown[];
};

type SessionHistoryItem = {
  profileId: string;
  profileName: string;
  updatedAt: number;
  messageCount: number;
  lastUserText: string;
  lastAssistantText: string;
};

type AgentMemoryGroup = {
  key: string;
  title: string;
  items: AgentMemorySnapshot['instructionFiles'];
  emptyText: string;
};

type InspectorSection = 'overview' | 'memory' | 'skills' | 'model-input' | 'tooling';
type InspectorMemoryFile = AgentMemorySnapshot['instructionFiles'][number];
type InspectorTimelineItem = {
  id: string;
  label: string;
  meta: string;
  updatedAt: number;
};
type NativeAgentToolEvent = {
  id: string;
  tool: string;
  phase: 'request' | 'result';
  summary: string;
  detail: string;
  rawDetail?: string;
  occurredAt?: number;
  isError?: boolean;
};
type NativeAgentInspectorSnapshot = {
  startedAt?: number;
  updatedAt: number;
  requestMode: 'structured' | 'legacy';
  outgoingText: string;
  workspaceSummary: string;
  memoryContext: string;
  systemPrompt: string;
  payload: string;
  lastResponse: string;
  progressLines: string[];
  toolEvents: NativeAgentToolEvent[];
};
type ExecutionTraceItem = {
  id: string;
  actor: 'user' | 'agent' | 'tools';
  target: 'agent' | 'tools' | 'user';
  title: string;
  meta?: string[];
  detail?: string;
  rawDetail?: string;
  tone?: 'success' | 'error';
  occurredAt?: number;
  elapsedMs?: number;
  durationMs?: number;
};

type OpenClawGatewayStatusSnapshot = {
  service?: {
    runtime?: { status?: string };
    configAudit?: { issues?: Array<{ code?: string; level?: string; message?: string; detail?: string }> };
  };
  rpc?: { ok?: boolean; url?: string };
  gateway?: { probeUrl?: string; probeNote?: string; bindHost?: string; port?: number | string; bindMode?: string };
  port?: { status?: string; hints?: string[] };
};

type OpenClawGatewayHealthSnapshot = {
  ok?: boolean;
  defaultAgentId?: string;
  ts?: number | string;
  sessions?: { count?: number };
  agents?: Array<unknown>;
};

export type ChatSettings = Pick<ModelProfile, 'id' | 'name' | 'providerId' | 'baseUrl' | 'apiKey' | 'model' | 'interactionMode' | 'inlineCompletionsEnabled' | 'agentPatchesEnabled'>;

const EMPTY_THREAD: Msg[] = [];
const THREAD_PERSIST_DEBOUNCE_MS = 240;
const MAX_NATIVE_MEMORY_ITEMS = 10;
const MAX_NATIVE_MEMORY_PREVIEW_CHARS = 420;
const MAX_NATIVE_MEMORY_QUERY_TERMS = 18;
const DEFAULT_ASSISTANT_DRAWER_WIDTH = 560;
const MIN_ASSISTANT_DRAWER_WIDTH = 560;
const OPENCLAW_GATEWAY_STATUS_COMMAND = 'openclaw gateway status --json';
const OPENCLAW_GATEWAY_HEALTH_COMMAND = 'openclaw gateway health --json';
const OPENCLAW_DASHBOARD_URL_COMMAND = 'openclaw dashboard --no-open';
const OPENCLAW_ELIGIBLE_SKILLS_COMMAND = 'openclaw skills list --eligible --json';

const INITIAL_CLAUDE_RUNTIME_STATE: NativeAgentRuntimeState = {
  sessionId: null,
  workspaceRoot: null,
  connected: false,
  running: false,
  rawTail: '',
  debugLogPath: null,
  debugLogTail: '',
  pendingQuestion: null,
  pendingApproval: null,
  lastPlan: [],
  diffDetected: false,
  events: [],
  resumeInfo: {
    restoredFromStorage: false,
    restoredAt: null,
    snapshotSavedAt: null,
    snapshotSessionId: null
  },
  capabilities: {
    interactiveStructuredOutput: false,
    printStructuredOutput: true,
    source: 'PTY stream + workspace --debug-file diagnostics (stream-json only with --print)'
  }
};

function looksLikeHtml(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function ChatBubbleContent({ content, renderMarkdown = false }: { content: string; renderMarkdown?: boolean }) {
  const sanitizedHtml = useMemo(() => {
    if (!looksLikeHtml(content)) return null;
    return DOMPurify.sanitize(content, {
      USE_PROFILES: { html: true }
    });
  }, [content]);

  if (sanitizedHtml !== null) {
    return <div className="bubbleRichContent" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
  }

  if (renderMarkdown) {
    return (
      <div className="bubbleRichContent bubbleMarkdownContent">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            p: MarkdownParagraph,
            a({ href, children, ...props }) {
              const external = typeof href === 'string' && /^(https?:)?\/\//.test(href);
              return (
                <a
                  href={href}
                  target={external ? '_blank' : undefined}
                  rel={external ? 'noreferrer noopener' : undefined}
                  {...props}
                >
                  {children}
                </a>
              );
            }
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  return <div className="bubblePlainText">{content}</div>;
}

function providerLabelFor(providerId: ModelProfile['providerId']) {
  if (providerId === 'github_copilot') return 'Copilot';
  if (providerId === 'anthropic') return 'Anthropic';
  return 'Compatible Gateway';
}

function modeLabelFor(mode: ModelProfile['interactionMode']) {
  if (mode === 'claude_cli') return 'Claude CLI';
  if (mode === 'native_agent') return 'Native Agent';
  return 'Standard';
}

type AgentTurnResult = {
  text: string;
  toolUses: Array<{
    id: string;
    name: Extract<AgentAction, { type: 'action' }>['tool'];
    input: Record<string, unknown>;
  }>;
  stopReason?: string;
};

type AgentAction =
  | { type: 'action'; tool: 'list_dir'; args: { path?: string } }
  | { type: 'action'; tool: 'read_file'; args: { path: string } }
  | { type: 'action'; tool: 'read_file_range'; args: { path: string; startLine: number; endLine: number } }
  | { type: 'action'; tool: 'search_text'; args: { query: string; path?: string; isRegexp?: boolean; maxResults?: number } }
  | { type: 'action'; tool: 'openclaw_skill_list'; args: { eligibleOnly?: boolean } }
  | { type: 'action'; tool: 'openclaw_skill_info'; args: { name: string } }
  | { type: 'action'; tool: 'openclaw_agent'; args: { prompt: string; skillName?: string; agentId?: string; timeoutMs?: number; responseMode?: 'text' | 'json'; forceSkill?: boolean } }
  | { type: 'action'; tool: 'apply_patch'; args: { path: string; replacements?: PatchReplacement[]; oldText?: string; newText?: string } }
  | { type: 'action'; tool: 'write_file'; args: { path: string; content: string } }
  | { type: 'action'; tool: 'create_file'; args: { path: string; content?: string } }
  | { type: 'action'; tool: 'create_dir'; args: { path: string } }
  | { type: 'action'; tool: 'delete_entry'; args: { path: string } }
  | { type: 'action'; tool: 'git_status'; args: { workspaceRoot?: string } }
  | { type: 'action'; tool: 'git_diff'; args: { path: string; workspaceRoot?: string; staged?: boolean } }
  | { type: 'action'; tool: 'run_command'; args: { command: string; timeoutMs?: number } }
  | { type: 'action'; tool: 'ask_user'; args: { prompt: string; options?: Array<string | AgentChoiceOption>; multiSelect?: boolean; allowFreeform?: boolean; kind?: 'question' | 'plan' } }
  | { type: 'final'; message: string };

function storageKey(profileId: string) {
  return `chat-thread:${profileId}`;
}

function historyMetaKey(profileId: string) {
  return `chat-thread-meta:${profileId}`;
}

function previewText(value: string, max = 120) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function loadHistoryUpdatedAt(profileId: string) {
  try {
    const raw = localStorage.getItem(historyMetaKey(profileId));
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { updatedAt?: number };
    return typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;
  } catch {
    return 0;
  }
}

function loadStoredThread(profileId: string): Msg[] {
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Msg[];
    return Array.isArray(parsed) ? parsed.filter((msg) => msg && (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string') : [];
  } catch {
    return [];
  }
}

function loadStoredThreadState(profiles: ModelProfile[]) {
  const threadsByProfile: ThreadMap = {};
  const threadUpdatedAtByProfile: ThreadUpdatedAtMap = {};
  const threadSummaryByProfile: ThreadSummaryMap = {};

  for (const profile of profiles) {
    const thread = loadStoredThread(profile.id);
    threadsByProfile[profile.id] = thread;
    threadSummaryByProfile[profile.id] = buildThreadSummary(thread);
    const updatedAt = loadHistoryUpdatedAt(profile.id);
    if (updatedAt > 0) {
      threadUpdatedAtByProfile[profile.id] = updatedAt;
    }
  }

  return { threadsByProfile, threadUpdatedAtByProfile, threadSummaryByProfile };
}

function findLastMessageContent(thread: Msg[], role: Msg['role']) {
  for (let index = thread.length - 1; index >= 0; index -= 1) {
    const item = thread[index];
    if (item.role === role) {
      return item.content;
    }
  }
  return '';
}

function buildThreadSummary(thread: Msg[]): ThreadSummary {
  return {
    messageCount: thread.length,
    lastUserText: previewText(findLastMessageContent(thread, 'user'), 90),
    lastAssistantText: previewText(findLastMessageContent(thread, 'assistant'), 120)
  };
}

function truncateInspectorText(value: string, maxChars: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n...[truncated]`;
}

function extractSearchTerms(value: string) {
  const matches = value.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [];
  const unique = new Set<string>();
  for (const item of matches) {
    unique.add(item);
    if (unique.size >= MAX_NATIVE_MEMORY_QUERY_TERMS) break;
  }
  return [...unique];
}

function scoreNativeMemoryItem(item: AgentMemorySnapshot['instructionFiles'][number], searchTerms: string[]) {
  const haystack = `${item.relativePath}\n${item.displayPath}\n${item.preview}`.toLowerCase();
  let score = item.updatedAt / 1e12;

  for (const term of searchTerms) {
    if (haystack.includes(term)) {
      score += term.includes('/') || term.includes('.') ? 3.2 : 1.4;
    }
    if (item.relativePath.toLowerCase().includes(term)) {
      score += 2.6;
    }
  }

  if (item.scope === 'project') score += 0.8;
  if (item.kind === 'memory') score += 0.4;
  return score;
}

function buildNativeAgentMemoryContext(snapshot: AgentMemorySnapshot | null, focusText: string, workspaceSummary: string) {
  if (!snapshot) return '';

  const searchTerms = extractSearchTerms(`${focusText}\n${workspaceSummary}`);
  const sections = [
    'Workspace memory snapshot for this project.',
    `Workspace root: ${snapshot.workspaceRoot}`,
    `Instruction files: ${snapshot.instructionFiles.length}`,
    `Auto memory files: ${snapshot.autoMemoryFiles.length}`,
    `Auto memory: ${snapshot.autoMemoryEnabled ? 'enabled' : 'disabled'}`
  ];

  if (snapshot.notices.length) {
    sections.push(`Notices: ${snapshot.notices.join(' | ')}`);
  }

  const memoryItems = [...snapshot.instructionFiles, ...snapshot.autoMemoryFiles]
    .map((item) => ({ item, score: scoreNativeMemoryItem(item, searchTerms) }))
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
    .slice(0, MAX_NATIVE_MEMORY_ITEMS);

  if (memoryItems.length) {
    sections.push(`Relevant memory excerpts${searchTerms.length ? ` for: ${searchTerms.join(', ')}` : ''}:`);
    for (const { item, score } of memoryItems) {
      const preview = item.preview ? truncateInspectorText(item.preview, MAX_NATIVE_MEMORY_PREVIEW_CHARS) : '(empty)';
      sections.push(`[${item.scope}/${item.kind}] ${item.relativePath} · score ${score.toFixed(2)}\n${preview}`);
    }
  }

  const hiddenCount = snapshot.instructionFiles.length + snapshot.autoMemoryFiles.length - memoryItems.length;
  if (hiddenCount > 0) {
    sections.push(`Additional memory files omitted from prompt for brevity: ${hiddenCount}`);
  }

  return sections.join('\n\n');
}

function parseOpenClawSkillList(value: string) {
  const parsed = JSON.parse(value) as OpenClawSkillListResponse | OpenClawSkillSummary[];
  const skills = Array.isArray(parsed) ? parsed : Array.isArray(parsed.skills) ? parsed.skills : [];
  return skills.filter((item): item is OpenClawSkillSummary => Boolean(item) && typeof item.name === 'string');
}

function formatOpenClawSkillInfo(info: OpenClawSkillInfo) {
  const lines = [
    `name: ${info.name}`,
    `source: ${info.source ?? 'unknown'}`,
    `eligible: ${info.eligible ? 'yes' : 'no'}`,
    `bundled: ${info.bundled ? 'yes' : 'no'}`,
    `disabled: ${info.disabled ? 'yes' : 'no'}`,
    `blockedByAllowlist: ${info.blockedByAllowlist ? 'yes' : 'no'}`
  ];
  if (info.description) lines.push(`description: ${info.description}`);
  if (info.filePath) lines.push(`filePath: ${info.filePath}`);
  if (info.baseDir) lines.push(`baseDir: ${info.baseDir}`);
  if (info.skillKey) lines.push(`skillKey: ${info.skillKey}`);
  if (info.primaryEnv) lines.push(`primaryEnv: ${info.primaryEnv}`);
  if (info.homepage) lines.push(`homepage: ${info.homepage}`);
  if (info.requirements) lines.push(`requirements: ${JSON.stringify(info.requirements, null, 2)}`);
  if (info.missing) lines.push(`missing: ${JSON.stringify(info.missing, null, 2)}`);
  if (Array.isArray(info.configChecks) && info.configChecks.length) lines.push(`configChecks: ${JSON.stringify(info.configChecks, null, 2)}`);
  if (Array.isArray(info.install) && info.install.length) lines.push(`install: ${JSON.stringify(info.install, null, 2)}`);
  return lines.join('\n\n');
}

function buildOpenClawSkillsContext(skills: RuntimeSkillItem[], focusText: string, workspaceSummary: string) {
  const openClawSkills = skills.filter((item) => item.source === 'openclaw');
  if (!openClawSkills.length) return '';

  const searchTerms = extractSearchTerms(`${focusText}\n${workspaceSummary}`);
  const ranked = openClawSkills
    .map((item) => {
      const haystack = `${item.name}\n${item.meta ?? ''}\n${item.preview ?? ''}`.toLowerCase();
      let score = 0;
      for (const term of searchTerms) {
        if (haystack.includes(term)) score += term.includes('/') || term.includes('.') ? 3 : 1.4;
        if (item.name.toLowerCase().includes(term)) score += 2.2;
      }
      return { item, score };
    })
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name))
    .slice(0, 8);

  const sections = [
    'OpenClaw skills available in the current environment.',
    `Eligible skills discovered: ${openClawSkills.length}`,
    'When the task overlaps one of these skill domains, inspect the matching skill with openclaw_skill_info and then delegate with openclaw_agent instead of improvising the whole workflow yourself.'
  ];

  for (const { item } of ranked) {
    sections.push(`[openclaw] ${item.name}\n${item.meta ?? ''}${item.preview ? `\n${truncateInspectorText(item.preview, 320)}` : ''}`.trim());
  }

  return sections.join('\n\n');
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return trimmed;
}

function normalizeAgentChoiceOptions(value: unknown): AgentChoiceOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: AgentChoiceOption[] = [];

  for (const item of value) {
    if (typeof item === 'string') {
      options.push({ value: item, label: item });
      continue;
    }

    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const valueText = typeof record.value === 'string'
      ? record.value
      : typeof record.label === 'string'
        ? record.label
        : null;
    if (!valueText) continue;
    options.push({
      value: valueText,
      label: typeof record.label === 'string' ? record.label : valueText,
      description: typeof record.description === 'string' ? record.description : undefined,
      recommended: typeof record.recommended === 'boolean' ? record.recommended : undefined
    });
  }

  return options;
}

const AGENT_TOOL_NAMES = [
  'list_dir',
  'read_file',
  'read_file_range',
  'search_text',
  'openclaw_skill_list',
  'openclaw_skill_info',
  'openclaw_agent',
  'apply_patch',
  'write_file',
  'create_file',
  'create_dir',
  'delete_entry',
  'git_status',
  'git_diff',
  'run_command',
  'ask_user'
] as const;

function isAgentToolName(value: unknown): value is Extract<AgentAction, { type: 'action' }>['tool'] {
  return typeof value === 'string' && AGENT_TOOL_NAMES.includes(value as (typeof AGENT_TOOL_NAMES)[number]);
}

function normalizeAgentActionCandidate(value: unknown): AgentAction | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : null;
  const tool = typeof record.tool === 'string' ? record.tool : null;
  const name = typeof record.name === 'string' ? record.name : null;
  const args = record.args && typeof record.args === 'object' ? (record.args as Record<string, unknown>) : null;

  if (type === 'final' && typeof record.message === 'string') {
    return { type: 'final', message: record.message };
  }
  if ((type === 'final' || type === 'answer') && typeof record.content === 'string') {
    return { type: 'final', message: record.content };
  }
  if (type === 'action' && isAgentToolName(tool) && args) {
    return { type: 'action', tool, args } as AgentAction;
  }

  const directTool = [type, tool, name].find((candidate) => isAgentToolName(candidate));
  if (!directTool) return null;
  if (args) {
    return { type: 'action', tool: directTool, args } as AgentAction;
  }
  if (directTool === 'list_dir') {
    return { type: 'action', tool: 'list_dir', args: { path: typeof record.path === 'string' ? record.path : undefined } };
  }
  if (directTool === 'read_file') {
    if (typeof record.path !== 'string') return null;
    return { type: 'action', tool: 'read_file', args: { path: record.path } };
  }
  if (directTool === 'read_file_range') {
    if (typeof record.path !== 'string' || typeof record.startLine !== 'number' || typeof record.endLine !== 'number') return null;
    return { type: 'action', tool: 'read_file_range', args: { path: record.path, startLine: record.startLine, endLine: record.endLine } };
  }
  if (directTool === 'search_text') {
    if (typeof record.query !== 'string') return null;
    return {
      type: 'action',
      tool: 'search_text',
      args: {
        query: record.query,
        path: typeof record.path === 'string' ? record.path : undefined,
        isRegexp: typeof record.isRegexp === 'boolean' ? record.isRegexp : undefined,
        maxResults: typeof record.maxResults === 'number' ? record.maxResults : undefined
      }
    };
  }
  if (directTool === 'openclaw_skill_list') {
    return {
      type: 'action',
      tool: 'openclaw_skill_list',
      args: {
        eligibleOnly: typeof record.eligibleOnly === 'boolean' ? record.eligibleOnly : undefined
      }
    };
  }
  if (directTool === 'openclaw_skill_info') {
    if (typeof record.name !== 'string') return null;
    return { type: 'action', tool: 'openclaw_skill_info', args: { name: record.name } };
  }
  if (directTool === 'openclaw_agent') {
    if (typeof record.prompt !== 'string') return null;
    return {
      type: 'action',
      tool: 'openclaw_agent',
      args: {
        prompt: record.prompt,
        skillName: typeof record.skillName === 'string' ? record.skillName : undefined,
        agentId: typeof record.agentId === 'string' ? record.agentId : undefined,
        timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined,
        responseMode: record.responseMode === 'json' || record.responseMode === 'text' ? record.responseMode : undefined,
        forceSkill: typeof record.forceSkill === 'boolean' ? record.forceSkill : undefined
      }
    };
  }
  if (directTool === 'apply_patch') {
    if (typeof record.path !== 'string') return null;
    return {
      type: 'action',
      tool: 'apply_patch',
      args: {
        path: record.path,
        replacements: Array.isArray(record.replacements) ? (record.replacements as PatchReplacement[]) : undefined,
        oldText: typeof record.oldText === 'string' ? record.oldText : undefined,
        newText: typeof record.newText === 'string' ? record.newText : undefined
      }
    };
  }
  if (directTool === 'write_file') {
    if (typeof record.path !== 'string' || typeof record.content !== 'string') return null;
    return { type: 'action', tool: 'write_file', args: { path: record.path, content: record.content } };
  }
  if (directTool === 'create_file') {
    if (typeof record.path !== 'string') return null;
    return {
      type: 'action',
      tool: 'create_file',
      args: { path: record.path, content: typeof record.content === 'string' ? record.content : undefined }
    };
  }
  if (directTool === 'create_dir') {
    if (typeof record.path !== 'string') return null;
    return { type: 'action', tool: 'create_dir', args: { path: record.path } };
  }
  if (directTool === 'delete_entry') {
    if (typeof record.path !== 'string') return null;
    return { type: 'action', tool: 'delete_entry', args: { path: record.path } };
  }
  if (directTool === 'git_status') {
    return {
      type: 'action',
      tool: 'git_status',
      args: { workspaceRoot: typeof record.workspaceRoot === 'string' ? record.workspaceRoot : undefined }
    };
  }
  if (directTool === 'git_diff') {
    if (typeof record.path !== 'string') return null;
    return {
      type: 'action',
      tool: 'git_diff',
      args: {
        path: record.path,
        workspaceRoot: typeof record.workspaceRoot === 'string' ? record.workspaceRoot : undefined,
        staged: typeof record.staged === 'boolean' ? record.staged : undefined
      }
    };
  }
  if (directTool === 'run_command') {
    if (typeof record.command !== 'string') return null;
    return { type: 'action', tool: 'run_command', args: { command: record.command, timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined } };
  }
  if (directTool === 'ask_user') {
    if (typeof record.prompt !== 'string') return null;
    return {
      type: 'action',
      tool: 'ask_user',
      args: {
        prompt: record.prompt,
        options: normalizeAgentChoiceOptions(record.options),
        multiSelect: typeof record.multiSelect === 'boolean' ? record.multiSelect : undefined,
        allowFreeform: typeof record.allowFreeform === 'boolean' ? record.allowFreeform : undefined,
        kind: record.kind === 'plan' || record.kind === 'question' ? record.kind : undefined
      }
    };
  }
  return null;
}

function tryParseAgentActionCandidate(value: string): AgentAction | null {
  try {
    return normalizeAgentActionCandidate(JSON.parse(value));
  } catch {
    return null;
  }
}

function extractBalancedJsonObjects(value: string) {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaping) escaping = false;
      else if (char === '\\') escaping = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start !== -1) {
        results.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return results;
}

function parseAgentAction(raw: string): AgentAction | null {
  const candidates = [raw.trim(), stripJsonFence(raw)];
  for (const candidate of candidates) {
    const parsed = tryParseAgentActionCandidate(candidate);
    if (parsed) return parsed;
  }
  for (const candidate of candidates) {
    for (const object of extractBalancedJsonObjects(candidate)) {
      const parsed = tryParseAgentActionCandidate(object);
      if (parsed) return parsed;
    }
  }
  return null;
}

function summarizeCommandResult(result: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; cwd: string }) {
  const parts = [`cwd: ${result.cwd}`, `exitCode: ${result.exitCode ?? 'null'}`, `signal: ${result.signal ?? 'null'}`];
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr}`);
  return parts.join('\n\n');
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function normalizePatchReplacements(args?: { replacements?: PatchReplacement[]; oldText?: string; newText?: string }) {
  if (!args) return [];
  if (Array.isArray(args.replacements) && args.replacements.length > 0) {
    return args.replacements.filter((item) => typeof item?.oldText === 'string' && typeof item?.newText === 'string');
  }
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  return [];
}

function summarizeAgentAction(action: Extract<AgentAction, { type: 'action' }>) {
  if (action.tool === 'run_command') return `run_command ${action.args.command}`;
  if (action.tool === 'ask_user') return `ask_user ${action.args.prompt}`;
  if (action.tool === 'search_text') return `search_text ${previewText(action.args.query, 64)}`;
  if (action.tool === 'openclaw_skill_list') return `openclaw_skill_list ${action.args.eligibleOnly === false ? 'all' : 'eligible'}`;
  if (action.tool === 'openclaw_skill_info') return `openclaw_skill_info ${action.args.name}`;
  if (action.tool === 'openclaw_agent') return `openclaw_agent ${action.args.skillName ?? 'delegate'} ${action.args.responseMode === 'json' ? '[json] ' : ''}${previewText(action.args.prompt, 64)}`;
  if (action.tool === 'read_file_range') return `read_file_range ${action.args.path}:${action.args.startLine}-${action.args.endLine}`;
  if (action.tool === 'apply_patch') return `apply_patch ${action.args.path}`;
  if (action.tool === 'write_file') return `write_file ${action.args.path}`;
  if (action.tool === 'create_file') return `create_file ${action.args.path}`;
  if (action.tool === 'create_dir') return `create_dir ${action.args.path}`;
  if (action.tool === 'delete_entry') return `delete_entry ${action.args.path}`;
  if (action.tool === 'git_status') return `git_status ${action.args.workspaceRoot ?? '(current workspace)'}`;
  if (action.tool === 'git_diff') return `git_diff ${action.args.path}${action.args.staged ? ' --staged' : ''}`;
  return 'path' in action.args && typeof action.args.path === 'string' ? `${action.tool} ${action.args.path}` : action.tool;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildOpenClawAgentPrompt(prompt: string, options?: { skillName?: string; responseMode?: 'text' | 'json'; forceSkill?: boolean }) {
  const trimmedPrompt = prompt.trim();
  const lines: string[] = [];
  if (options?.skillName) {
    lines.push(`Use the OpenClaw skill \"${options.skillName}\" for this task.`);
    if (options.forceSkill) {
      lines.push('Do not silently fall back to a different skill. If the named skill cannot satisfy the request, explain that explicitly.');
    } else {
      lines.push('If the named skill is not applicable or unavailable, use the best matching built-in OpenClaw capability instead of refusing immediately.');
    }
  }
  if (options?.responseMode === 'json') {
    lines.push('Return strict JSON only with no surrounding prose.');
  }
  lines.push('Task:');
  lines.push(trimmedPrompt);
  return lines.join('\n');
}

function formatOpenClawAgentResult(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return '(empty response)';
  try {
    const parsed = JSON.parse(trimmed) as {
      payloads?: Array<{ text?: string | null }>;
      meta?: { durationMs?: number; agentMeta?: { agentId?: string; sessionId?: string; provider?: string; model?: string } };
    };
    const payloadText = Array.isArray(parsed.payloads)
      ? parsed.payloads.map((item) => typeof item?.text === 'string' ? item.text.trim() : '').filter(Boolean).join('\n\n')
      : '';
    const lines = [payloadText || trimmed];
    if (parsed.meta?.agentMeta?.agentId) lines.push(`agentId: ${parsed.meta.agentMeta.agentId}`);
    if (parsed.meta?.agentMeta?.sessionId) lines.push(`sessionId: ${parsed.meta.agentMeta.sessionId}`);
    if (parsed.meta?.agentMeta?.provider) lines.push(`provider: ${parsed.meta.agentMeta.provider}`);
    if (parsed.meta?.agentMeta?.model) lines.push(`model: ${parsed.meta.agentMeta.model}`);
    if (typeof parsed.meta?.durationMs === 'number') lines.push(`durationMs: ${parsed.meta.durationMs}`);
    return lines.join('\n');
  } catch {
    return trimmed;
  }
}

function formatLineRange(contents: string, requestedStartLine: number, requestedEndLine: number) {
  const normalized = contents.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const totalLines = lines.length;
  const startLine = Math.min(totalLines, Math.max(1, Math.floor(requestedStartLine)));
  const endLine = Math.min(totalLines, Math.max(startLine, Math.floor(requestedEndLine)));
  return {
    totalLines,
    startLine,
    endLine,
    contents: lines.slice(startLine - 1, endLine).join('\n')
  };
}

function summarizeGitStatus(snapshot: GitRepositorySnapshot) {
  const header = [
    `workspaceRoot: ${snapshot.workspaceRoot}`,
    `gitRoot: ${snapshot.gitRoot ?? '(none)'}`,
    `branch: ${snapshot.branch ?? '(detached)'}`,
    `upstream: ${snapshot.upstream ?? '(none)'}`,
    `ahead: ${snapshot.ahead}`,
    `behind: ${snapshot.behind}`,
    `changedFiles: ${snapshot.changedFiles}`,
    `stagedFiles: ${snapshot.stagedFiles}`,
    `unstagedFiles: ${snapshot.unstagedFiles}`,
    `untrackedFiles: ${snapshot.untrackedFiles}`,
    `clean: ${snapshot.isClean ? 'yes' : 'no'}`
  ];
  const entries = snapshot.statusEntries.slice(0, 80).map((entry: GitRepositorySnapshot['statusEntries'][number]) => `${entry.kind}\t${entry.path}\tstaged=${entry.staged}\tunstaged=${entry.unstaged}`);
  return `${header.join('\n')}\n${entries.length ? `entries:\n${entries.join('\n')}` : 'entries:\n(clean)'}`;
}

function stripAnsiSequences(value: string) {
  const escapeChar = String.fromCharCode(27);
  return value
    .replace(new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${escapeChar}\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${escapeChar}\\\\)`, 'g'), '');
}

function applyBackspaces(value: string) {
  let output = '';
  for (const char of value) {
    if (char === '\b') {
      output = output.slice(0, -1);
      continue;
    }
    output += char;
  }
  return output;
}

const CLI_NOISE_LINE_PATTERNS = [
  /^\[debug\]/i,
  /^user prompt sent:/i,
  /^interrupt requested/i,
  /^claude(?:\s|$)/i,
  /^\$\s?/,
  /^>\s?$/,
  /^\.{3,}$/,
  /^\[process exited/i,
  /^\d+%\|/,
  /^[|\\/-]{2,}$/,
  /^\s*thinking\s*$/i,
  /^press (enter|return|y|n)/i,
  /^use arrow keys/i,
  /^\(y\/n\)/i,
  /^\[[A-Z0-9_;?]+\]$/
];

const CLI_VISUAL_NOISE_CHARS = /[·•●◦○✳✶✻✽✢…⋯⠁-⣿]/g;

function isCliVisualNoiseLine(value: string) {
  const line = value.trim();
  if (!line) return false;
  const compact = line.replace(/\s+/g, '');
  if (!compact) return false;
  if (/^[·•●◦○✳✶✻✽✢…⋯⠁-⣿]+$/u.test(compact)) return true;
  const symbolMatches = compact.match(CLI_VISUAL_NOISE_CHARS) ?? [];
  if (symbolMatches.length === 0) return false;
  const withoutNoiseChars = compact.replace(CLI_VISUAL_NOISE_CHARS, '');
  if (!withoutNoiseChars) return true;
  const asciiLetters = withoutNoiseChars.match(/[a-z]/gi) ?? [];
  const digits = withoutNoiseChars.match(/\d/g) ?? [];
  const cjkChars = withoutNoiseChars.match(/[\u3400-\u9fff]/g) ?? [];
  const punctuationOnly = withoutNoiseChars.replace(/[._,;:!?()[\]{}'"`~-]/g, '');
  if (cjkChars.length > 0) return false;
  return symbolMatches.length >= 2 && asciiLetters.length <= 4 && digits.length === 0 && punctuationOnly.length <= 4;
}

function sanitizeCliText(value: string) {
  const withoutControlChars = [...applyBackspaces(stripAnsiSequences(value))]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 || char === '\n' || char === '\r' || char === '\t';
    })
    .join('');
  return withoutControlChars.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeCliLines(value: string) {
  return sanitizeCliText(value)
    .split('\n')
    .map((line) => line.replace(/\t/g, '  ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isCliVisualNoiseLine(line))
    .filter((line) => !CLI_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}

function extractOpenClawDashboardUrl(value: string) {
  const match = value.match(/https?:\/\/[^\s]+/i);
  return match ? match[0].trim() : null;
}

function OpenClawLogo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className="openClawLogoGlyph">
      <path d="M16 38c-4.2 0-7.5 3.2-7.5 7.2S11.8 52 16 52s7.5-3.2 7.5-6.8S20.2 38 16 38Zm32 0c-4.2 0-7.5 3.2-7.5 7.2S43.8 52 48 52s7.5-3.2 7.5-6.8S52.2 38 48 38ZM25 18c-6.5 0-12 5.1-12.6 11.6-.3 3.4 1.1 6.6 3.7 8.7l3.2-3.6c-1.5-1.3-2.3-3.2-2.1-5.2.3-3.8 3.6-6.7 7.5-6.7 2.4 0 4.6 1.1 6 3 1.4-1.9 3.6-3 6-3 3.9 0 7.2 2.9 7.5 6.7.2 2-.6 3.9-2.1 5.2l3.2 3.6c2.6-2.1 4-5.4 3.7-8.7C51 23.1 45.5 18 39 18c-3.3 0-6.3 1.3-8.5 3.4C31.3 19.3 28.3 18 25 18Zm-6.7 20.3 5.5 5.5c2.2 2.2 5.2 3.4 8.2 3.4s6-1.2 8.2-3.4l5.5-5.5-3.5-3.5-5.5 5.5a6.12 6.12 0 0 1-8.5 0l-5.5-5.5-3.5 3.5Z" fill="currentColor" />
    </svg>
  );
}

function buildExecutionTrace(snapshot: NativeAgentInspectorSnapshot | null): ExecutionTraceItem[] {
  if (!snapshot) return [];
  const items: ExecutionTraceItem[] = [
    {
      id: 'user-request',
      actor: 'user',
      target: 'agent',
      title: previewText(snapshot.outgoingText, 180),
      meta: [snapshot.requestMode === 'structured' ? 'Structured' : 'Legacy'],
      detail: snapshot.outgoingText,
      rawDetail: snapshot.outgoingText,
      occurredAt: snapshot.startedAt
    }
  ];

  const firstEventAt = snapshot.toolEvents[0]?.occurredAt ?? snapshot.startedAt ?? snapshot.updatedAt;
  for (const event of snapshot.toolEvents) {
    items.push({
      id: event.id,
      actor: event.phase === 'request' ? 'agent' : 'tools',
      target: event.phase === 'request' ? 'tools' : 'agent',
      title: event.summary,
      meta: [event.tool, event.phase],
      detail: event.detail,
      rawDetail: event.rawDetail ?? event.detail,
      occurredAt: event.occurredAt,
      elapsedMs: event.occurredAt !== undefined ? Math.max(0, event.occurredAt - firstEventAt) : undefined,
      tone: event.isError ? 'error' : event.phase === 'result' ? 'success' : undefined
    });
  }

  if (snapshot.lastResponse) {
    items.push({
      id: 'agent-response',
      actor: 'agent',
      target: 'user',
      title: previewText(snapshot.lastResponse, 180),
      detail: snapshot.lastResponse,
      rawDetail: snapshot.lastResponse,
      occurredAt: snapshot.updatedAt,
      elapsedMs: snapshot.startedAt !== undefined ? Math.max(0, snapshot.updatedAt - snapshot.startedAt) : undefined,
      tone: 'success'
    });
  }

  return items;
}

function isPathInside(basePath: string | null, targetPath: string) {
  if (!basePath) return false;
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`) || targetPath.startsWith(`${basePath}\\`);
}

function buildReadableTerminalSnippet(value: string) {
  const cleaned = normalizeCliLines(value);

  if (!cleaned.length) return '';

  return cleaned.slice(-5).join('\n');
}

function formatAgentActivityLine(line: string) {
  if (line === 'Agent: planning…') return '正在分析当前请求';
  if (line === 'Cancellation requested…') return '已请求中断当前执行';
  if (line.startsWith('Agent asks: ')) return `等待你的输入: ${line.slice('Agent asks: '.length)}`;
  if (line.startsWith('Agent session: ')) return `结构化会话: ${line.slice('Agent session: '.length)}`;
  if (line.startsWith('Agent stop reason: ')) return `模型停止原因: ${line.slice('Agent stop reason: '.length)}`;
  if (line.startsWith('Agent note: ')) return `模型说明: ${line.slice('Agent note: '.length)}`;
  if (line.startsWith('Agent tool_use ')) return `工具调用事件: ${line.slice('Agent tool_use '.length)}`;
  if (line.startsWith('Agent tool_result ')) return `工具结果事件: ${line.slice('Agent tool_result '.length)}`;
  if (line.startsWith('Agent tool: run_command ')) return `准备执行命令: ${line.slice('Agent tool: run_command '.length)}`;
  if (line.startsWith('Agent tool: read_file ')) return `正在读取文件: ${line.slice('Agent tool: read_file '.length)}`;
  if (line.startsWith('Agent tool: read_file_range ')) return `正在读取文件片段: ${line.slice('Agent tool: read_file_range '.length)}`;
  if (line.startsWith('Agent tool: search_text ')) return `正在搜索文本: ${line.slice('Agent tool: search_text '.length)}`;
  if (line.startsWith('Agent tool: openclaw_skill_list ')) return `正在读取 OpenClaw 技能列表: ${line.slice('Agent tool: openclaw_skill_list '.length)}`;
  if (line.startsWith('Agent tool: openclaw_skill_info ')) return `正在读取 OpenClaw 技能详情: ${line.slice('Agent tool: openclaw_skill_info '.length)}`;
  if (line.startsWith('Agent tool: openclaw_agent ')) return `正在委托 OpenClaw Agent: ${line.slice('Agent tool: openclaw_agent '.length)}`;
  if (line.startsWith('Agent tool: list_dir ')) return `正在查看目录: ${line.slice('Agent tool: list_dir '.length)}`;
  if (line.startsWith('Agent tool: apply_patch ')) return `准备修改文件: ${line.slice('Agent tool: apply_patch '.length)}`;
  if (line.startsWith('Agent tool: write_file ')) return `准备写入文件: ${line.slice('Agent tool: write_file '.length)}`;
  if (line.startsWith('Agent tool: create_file ')) return `准备创建文件: ${line.slice('Agent tool: create_file '.length)}`;
  if (line.startsWith('Agent tool: create_dir ')) return `准备创建目录: ${line.slice('Agent tool: create_dir '.length)}`;
  if (line.startsWith('Agent tool: delete_entry ')) return `准备删除条目: ${line.slice('Agent tool: delete_entry '.length)}`;
  if (line.startsWith('Agent tool: git_status ')) return `正在读取 Git 状态: ${line.slice('Agent tool: git_status '.length)}`;
  if (line.startsWith('Agent tool: git_diff ')) return `正在读取 Git diff: ${line.slice('Agent tool: git_diff '.length)}`;
  if (line.startsWith('Running in terminal: ')) return `命令执行中: ${line.slice('Running in terminal: '.length)}`;
  if (line.startsWith('TOOL_RESULT run_command')) return '命令执行完成，正在读取结果';
  if (line.startsWith('TOOL_RESULT read_file')) return '文件内容已读取';
  if (line.startsWith('TOOL_RESULT read_file_range')) return '文件片段已读取';
  if (line.startsWith('TOOL_RESULT search_text')) return '文本搜索已完成';
  if (line.startsWith('TOOL_RESULT openclaw_skill_list')) return 'OpenClaw 技能列表已获取';
  if (line.startsWith('TOOL_RESULT openclaw_skill_info')) return 'OpenClaw 技能详情已获取';
  if (line.startsWith('TOOL_RESULT openclaw_agent')) return 'OpenClaw Agent 已返回结果';
  if (line.startsWith('TOOL_RESULT list_dir')) return '目录内容已获取';
  if (line.startsWith('TOOL_RESULT apply_patch')) return '补丁已应用';
  if (line.startsWith('TOOL_RESULT write_file')) return '文件已写入';
  if (line.startsWith('TOOL_RESULT create_file')) return '文件已创建';
  if (line.startsWith('TOOL_RESULT create_dir')) return '目录已创建';
  if (line.startsWith('TOOL_RESULT delete_entry')) return '条目已删除';
  if (line.startsWith('TOOL_RESULT git_status')) return 'Git 状态已获取';
  if (line.startsWith('TOOL_RESULT git_diff')) return 'Git diff 已读取';
  return line;
}

function extractRuntimeSkillHints(debugLogTail: string): RuntimeSkillItem[] {
  if (!debugLogTail.trim()) return [];

  const lines = debugLogTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const hints: RuntimeSkillItem[] = [];

  for (const line of lines) {
    const sendingMatch = /Sending\s+(\d+)\s+skills\s+via\s+attachment/i.exec(line);
    if (sendingMatch) {
      hints.push({
        key: `runtime-attached-${sendingMatch[1]}`,
        name: `Attached skills (${sendingMatch[1]})`,
        source: 'runtime',
        meta: 'Detected from runtime debug log'
      });
      continue;
    }

    const returningMatch = /getSkills returning:\s*(.+)$/i.exec(line);
    if (returningMatch) {
      hints.push({
        key: `runtime-returning-${returningMatch[1]}`,
        name: 'Skill inventory summary',
        source: 'runtime',
        meta: returningMatch[1]
      });
      continue;
    }

    const loadingMatch = /Loading skills from:\s*(.+)$/i.exec(line);
    if (loadingMatch) {
      hints.push({
        key: `runtime-loading-${loadingMatch[1]}`,
        name: 'Skill search paths',
        source: 'runtime',
        meta: loadingMatch[1]
      });
    }
  }

  const map = new Map<string, RuntimeSkillItem>();
  for (const item of hints) {
    map.set(item.key, item);
  }

  return [...map.values()].slice(-4);
}

function formatTimestamp(value: number) {
  return new Date(value).toLocaleString();
}

function formatDuration(value: number | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) < 0) return null;
  const ms = value ?? 0;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

function looksLikeAgentInternalText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => (
    /^Agent: /i.test(line)
    || /^Agent tool:/i.test(line)
    || /^Agent tool_use /i.test(line)
    || /^Agent tool_result /i.test(line)
    || /^TOOL_RESULT\b/i.test(line)
    || /^Agent stop reason:/i.test(line)
    || /^Result:/i.test(line)
    || /^status:\s+/i.test(line)
    || /^path:\s+/i.test(line)
    || /^bytes:\s+/i.test(line)
  ));
}

function extractUserFacingAgentText(value: string) {
  const lines = value.split('\n');
  const kept = lines.filter((rawLine) => {
    const line = rawLine.trim();
    if (!line) return true;
    return !(
      /^Agent: /i.test(line)
      || /^Agent tool:/i.test(line)
      || /^Agent tool_use /i.test(line)
      || /^Agent tool_result /i.test(line)
      || /^TOOL_RESULT\b/i.test(line)
      || /^Agent stop reason:/i.test(line)
      || /^Result:/i.test(line)
      || /^status:\s+/i.test(line)
      || /^path:\s+/i.test(line)
      || /^bytes:\s+/i.test(line)
    );
  }).join('\n').trim();

  if (!kept) return '';
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

function taskRequiresMoreThanOpening(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;
  const followThroughPatterns = [
    /总结|汇总|提取|读取|抓取|分析|列出|榜单|热榜|热搜|排行|内容|结果|告诉我|返回|统计|查看详情/,
    /summari[sz]e|extract|read|fetch|analy[sz]e|list|rank|top\s*\d+|hot\s*list|headline|result|return|report|compare|what\b|which\b/
  ];
  return followThroughPatterns.some((pattern) => pattern.test(normalized));
}

function responseOnlyConfirmsOpening(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  const patterns = [
    /^已(?:经)?(?:用\s*openclaw)?在浏览器中打开/,
    /^已打开/,
    /^浏览器已(?:打开|唤起)/,
    /^opened?\b.*\b(browser|page|url)/,
    /^i (?:have )?opened\b/,
    /^the page is open\b/
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function shouldForceBrowserFollowThrough(prompt: string, candidateResponse: string) {
  return taskRequiresMoreThanOpening(prompt) && responseOnlyConfirmsOpening(candidateResponse);
}

export function ChatPage(props: {
  settings: ChatSettings;
  profiles: ModelProfile[];
  activeProfileId: string;
  openProjectRequestKey: number;
  openClawInstallRequestKey: number;
  openClawSetupRequestKey: number;
  openClawCloseRequestKey: number;
  onWorkspaceToolsStateChange?: (state: {
    workspaceRoot: string | null;
    openClawInstalled: boolean;
    openClawVersion: string | null;
    openClawChecking: boolean;
    openClawDialogOpen: boolean;
  }) => void;
  onSelectProfile: (profileId: string) => void;
  onOpenGitPage: () => void;
  isDrawerOpen: boolean;
  onToggleDrawer: () => void;
  onRunCommandInTerminal: (command: string, timeoutMs?: number) => Promise<TerminalCommandResult>;
  onSendCommandToTerminal: (command: string) => Promise<void>;
  onInterruptAgentRun: () => Promise<void>;
  onSendPromptToClaudeCli: (prompt: string) => Promise<void>;
  onFocusClaudeCliTerminal: () => Promise<void>;
  onInterruptClaudeCli: () => Promise<void>;
}) {
  const { settings, profiles, activeProfileId, openProjectRequestKey, openClawInstallRequestKey, openClawSetupRequestKey, openClawCloseRequestKey, onWorkspaceToolsStateChange, onOpenGitPage, onSelectProfile, isDrawerOpen, onToggleDrawer, onRunCommandInTerminal, onSendCommandToTerminal, onInterruptAgentRun, onSendPromptToClaudeCli, onFocusClaudeCliTerminal, onInterruptClaudeCli } = props;

  const workspacePanelRef = useRef<WorkspacePanelHandle | null>(null);
  const handledOpenProjectRequestRef = useRef(openProjectRequestKey);
  const handledOpenClawRequestRef = useRef(openClawInstallRequestKey);
  const handledOpenClawSetupRequestRef = useRef(openClawSetupRequestKey);
  const openClawInstallerStatusRef = useRef<OpenClawInstallerState['status']>('idle');
  const lastStableOpenClawRef = useRef<{ installed: boolean; version: string | null }>({
    installed: false,
    version: null
  });
  const drawerWidthRef = useRef(DEFAULT_ASSISTANT_DRAWER_WIDTH);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const drawerWidthFrameRef = useRef<number | null>(null);
  const [input, setInput] = useState('');
  const [threadStore, setThreadStore] = useState<ThreadStore>(() => loadStoredThreadState(profiles));
  const [isStreaming, setIsStreaming] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_ASSISTANT_DRAWER_WIDTH);
  const [suppressDrawerTransition, setSuppressDrawerTransition] = useState(true);
  const [isDrawerResizing, setIsDrawerResizing] = useState(false);
  const [immersiveChatOpen, setImmersiveChatOpen] = useState(false);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspacePanelContext>({
    workspaceRoot: null,
    workspaceScopePath: null,
    activePath: null,
    selectedPath: null,
    selectedEntryKind: null,
    activeText: '',
    activeFileName: null,
    topLevelEntries: [],
    pendingPatchCount: 0,
    agentStatus: '',
    dirty: false,
    openClaw: {
      installed: false,
      version: null,
      checking: false,
      dialogOpen: false
    },
    javaProject: {
      enabled: false,
      buildTool: null,
      hasWrapper: false,
      packageName: null,
      typeName: null,
      hasMainMethod: false,
      hasTestMethods: false
    }
  });

  const [connectionState, setConnectionState] = useState<ConnectionState | null>(null);
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatus>('idle');
  const [agentProgressLines, setAgentProgressLines] = useState<string[]>([]);
  const [agentTerminalText, setAgentTerminalText] = useState('');
  const [agentActiveCommand, setAgentActiveCommand] = useState<string | null>(null);
  const [cliRuntimeState, setClaudeRuntimeState] = useState<NativeAgentRuntimeState>(INITIAL_CLAUDE_RUNTIME_STATE);
  const [cliHandoffNotice, setClaudeCliHandoffNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [cliMinimalMode, setClaudeCliMinimalMode] = useState(true);
  const [showClaudeCliDetails, setShowClaudeCliDetails] = useState(false);
  const [workspaceSkills, setWorkspaceSkills] = useState<RuntimeSkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [openClawSkills, setOpenClawSkills] = useState<RuntimeSkillItem[]>([]);
  const [openClawSkillsLoading, setOpenClawSkillsLoading] = useState(false);
  const [openClawSkillsError, setOpenClawSkillsError] = useState<string | null>(null);
  const [skillsRefreshTick, setSkillsRefreshTick] = useState(0);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [inspectorSection, setInspectorSection] = useState<InspectorSection>('overview');
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [openClawDrawerOpen, setOpenClawDrawerOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [openClawGatewayLoading, setOpenClawGatewayLoading] = useState(false);
  const [openClawGatewayError, setOpenClawGatewayError] = useState<string | null>(null);
  const [openClawGatewayStatus, setOpenClawGatewayStatus] = useState<OpenClawGatewayStatusSnapshot | null>(null);
  const [openClawGatewayHealth, setOpenClawGatewayHealth] = useState<OpenClawGatewayHealthSnapshot | null>(null);
  const [openClawDashboardUrl, setOpenClawDashboardUrl] = useState<string | null>(null);
  const [openClawInstallSnapshot, setOpenClawInstallSnapshot] = useState<OpenClawInstallState | null>(null);
  const [, setOpenClawInstallerState] = useState<OpenClawInstallerState>({
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
  const [openClawActionBusy, setOpenClawActionBusy] = useState<'refresh' | 'update' | 'onboarding' | null>(null);
  const [openClawActionNotice, setOpenClawActionNotice] = useState<string | null>(null);
  const [memorySnapshot, setMemorySnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryRefreshTick, setMemoryRefreshTick] = useState(0);
  const [selectedInspectorFile, setSelectedInspectorFile] = useState<InspectorMemoryFile | null>(null);
  const [selectedInspectorFileContent, setSelectedInspectorFileContent] = useState('');
  const [selectedInspectorFileLoading, setSelectedInspectorFileLoading] = useState(false);
  const [selectedInspectorFileError, setSelectedInspectorFileError] = useState<string | null>(null);
  const [selectedInspectorSkill, setSelectedInspectorSkill] = useState<RuntimeSkillItem | null>(null);
  const [selectedInspectorSkillContent, setSelectedInspectorSkillContent] = useState('');
  const [selectedInspectorSkillLoading, setSelectedInspectorSkillLoading] = useState(false);
  const [selectedInspectorSkillError, setSelectedInspectorSkillError] = useState<string | null>(null);
  const [nativeAgentInspectorSnapshot, setNativeAgentInspectorSnapshot] = useState<NativeAgentInspectorSnapshot | null>(null);
  const [pendingAgentQuestion, setPendingAgentQuestion] = useState<PendingAgentQuestion | null>(null);
  const [profileSwitchNotice, setProfileSwitchNotice] = useState<string | null>(null);
  const activeStreamRef = useRef<{ close: () => void } | null>(null);
  const latestOpenClawRawOutputRef = useRef<string | null>(null);
  const latestOpenClawUsageRef = useRef<OpenClawUsageMeta | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      setSuppressDrawerTransition(false);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const drag = dragStateRef.current;
      if (!drag || immersiveChatOpen) return;
      const maxWidth = Math.max(MIN_ASSISTANT_DRAWER_WIDTH, window.innerWidth - 220);
      const nextWidth = Math.max(MIN_ASSISTANT_DRAWER_WIDTH, Math.min(maxWidth, drag.startWidth + (drag.startX - event.clientX)));
      drawerWidthRef.current = nextWidth;
      if (drawerWidthFrameRef.current !== null) return;
      drawerWidthFrameRef.current = window.requestAnimationFrame(() => {
        drawerWidthFrameRef.current = null;
        setDrawerWidth(drawerWidthRef.current);
      });
    }

    function handlePointerUp() {
      dragStateRef.current = null;
      setIsDrawerResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      if (drawerWidthFrameRef.current !== null) {
        window.cancelAnimationFrame(drawerWidthFrameRef.current);
        drawerWidthFrameRef.current = null;
      }
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [immersiveChatOpen]);

  useEffect(() => {
    if (!immersiveChatOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setImmersiveChatOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [immersiveChatOpen]);

  useEffect(() => {
    const detectedVersion = openClawInstallSnapshot?.openclawVersion ?? workspaceContext.openClaw.version;
    const detectedInstalled = workspaceContext.openClaw.installed || !!detectedVersion;

    if (detectedInstalled || detectedVersion) {
      lastStableOpenClawRef.current = {
        installed: true,
        version: detectedVersion ?? lastStableOpenClawRef.current.version
      };
    } else if (!workspaceContext.openClaw.checking) {
      lastStableOpenClawRef.current = {
        installed: false,
        version: null
      };
    }

    const openClawVersion = detectedVersion ?? (workspaceContext.openClaw.checking ? lastStableOpenClawRef.current.version : null);
    const openClawInstalled = detectedInstalled || (workspaceContext.openClaw.checking && lastStableOpenClawRef.current.installed);

    onWorkspaceToolsStateChange?.({
      workspaceRoot: workspaceContext.workspaceRoot,
      openClawInstalled,
      openClawVersion,
      openClawChecking: workspaceContext.openClaw.checking,
      openClawDialogOpen: workspaceContext.openClaw.dialogOpen || openClawDrawerOpen
    });
  }, [onWorkspaceToolsStateChange, openClawDrawerOpen, openClawInstallSnapshot?.openclawVersion, workspaceContext.openClaw.checking, workspaceContext.openClaw.dialogOpen, workspaceContext.openClaw.installed, workspaceContext.openClaw.version, workspaceContext.workspaceRoot]);
  const profileSwitchNoticeTimerRef = useRef<number | null>(null);
  const agentCancelRequestedRef = useRef(false);
  const agentProgressRef = useRef<string[]>([]);
  const agentRunActiveRef = useRef(false);
  const pendingAgentQuestionResolveRef = useRef<((answer: string) => void) | null>(null);
  const pendingAgentQuestionRejectRef = useRef<((error: Error) => void) | null>(null);
  const threadPersistTimerRef = useRef<number | null>(null);
  const pendingThreadPersistRef = useRef<{ profileId: string; messages: Msg[]; updatedAt: number } | null>(null);
  const isComposingRef = useRef(false);
  const { threadsByProfile, threadUpdatedAtByProfile, threadSummaryByProfile } = threadStore;

  function clearThreadPersistTimer() {
    if (threadPersistTimerRef.current === null) return;
    window.clearTimeout(threadPersistTimerRef.current);
    threadPersistTimerRef.current = null;
  }

  function flushPendingThreadPersist() {
    const pending = pendingThreadPersistRef.current;
    if (!pending) return;

    const threadKey = storageKey(pending.profileId);
    const metaKey = historyMetaKey(pending.profileId);

    if (pending.messages.length === 0) {
      localStorage.removeItem(threadKey);
      localStorage.removeItem(metaKey);
    } else {
      localStorage.setItem(threadKey, JSON.stringify(pending.messages));
      localStorage.setItem(metaKey, JSON.stringify({ updatedAt: pending.updatedAt }));
    }

    pendingThreadPersistRef.current = null;
    clearThreadPersistTimer();
  }

  function scheduleThreadPersist(profileId: string, messages: Msg[], updatedAt: number) {
    const pending = pendingThreadPersistRef.current;
    if (pending && pending.profileId !== profileId) {
      flushPendingThreadPersist();
    }

    pendingThreadPersistRef.current = {
      profileId,
      messages,
      updatedAt
    };
    clearThreadPersistTimer();
    threadPersistTimerRef.current = window.setTimeout(() => {
      flushPendingThreadPersist();
    }, THREAD_PERSIST_DEBOUNCE_MS);
  }

  function dropPendingThreadPersist(profileId: string) {
    const pending = pendingThreadPersistRef.current;
    if (!pending || pending.profileId !== profileId) return;
    pendingThreadPersistRef.current = null;
    clearThreadPersistTimer();
  }

  function clearProfileSwitchNoticeTimer() {
    if (profileSwitchNoticeTimerRef.current === null) return;
    window.clearTimeout(profileSwitchNoticeTimerRef.current);
    profileSwitchNoticeTimerRef.current = null;
  }

  function showProfileSwitchNotice(profileId: string) {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    clearProfileSwitchNoticeTimer();
    setProfileSwitchNotice(`Switched to ${profile.name} · ${modeLabelFor(profile.interactionMode)} · ${providerLabelFor(profile.providerId)}`);
    profileSwitchNoticeTimerRef.current = window.setTimeout(() => {
      setProfileSwitchNotice(null);
      profileSwitchNoticeTimerRef.current = null;
    }, 2600);
  }

  function handleProfileSelection(profileId: string) {
    if (profileId === activeProfileId) return;
    onSelectProfile(profileId);
    showProfileSwitchNotice(profileId);
  }

  useEffect(() => {
    return () => {
      clearProfileSwitchNoticeTimer();
    };
  }, []);

  useEffect(() => {
    setThreadStore((prev) => {
      const nextThreads: ThreadMap = {};
      const nextUpdatedAt: ThreadUpdatedAtMap = {};
      const nextSummaries: ThreadSummaryMap = {};
      let changed = false;

      for (const profile of profiles) {
        if (profile.id in prev.threadsByProfile) {
          nextThreads[profile.id] = prev.threadsByProfile[profile.id];
          nextSummaries[profile.id] = prev.threadSummaryByProfile[profile.id] ?? buildThreadSummary(prev.threadsByProfile[profile.id]);
        } else {
          const thread = loadStoredThread(profile.id);
          nextThreads[profile.id] = thread;
          nextSummaries[profile.id] = buildThreadSummary(thread);
          changed = true;
        }

        if (profile.id in prev.threadUpdatedAtByProfile) {
          nextUpdatedAt[profile.id] = prev.threadUpdatedAtByProfile[profile.id];
        } else {
          const updatedAt = loadHistoryUpdatedAt(profile.id);
          if (updatedAt > 0) {
            nextUpdatedAt[profile.id] = updatedAt;
          }
          changed = true;
        }
      }

      if (!changed) {
        const prevThreadKeys = Object.keys(prev.threadsByProfile);
        const prevUpdatedKeys = Object.keys(prev.threadUpdatedAtByProfile);
        const prevSummaryKeys = Object.keys(prev.threadSummaryByProfile);
        if (prevThreadKeys.length !== profiles.length || prevUpdatedKeys.length !== Object.keys(nextUpdatedAt).length || prevSummaryKeys.length !== profiles.length) {
          changed = true;
        }
      }

      return changed
        ? {
            threadsByProfile: nextThreads,
            threadUpdatedAtByProfile: nextUpdatedAt,
            threadSummaryByProfile: nextSummaries
          }
        : prev;
    });
  }, [profiles]);

  const messages = threadsByProfile[activeProfileId] ?? EMPTY_THREAD;
  const activeThreadUpdatedAt = threadUpdatedAtByProfile[activeProfileId] ?? 0;
  const isClaudeCliMode = settings.interactionMode === 'claude_cli';
  const isNativeAgentMode = settings.interactionMode === 'native_agent';

  function setCurrentMessages(updater: Msg[] | ((prev: Msg[]) => Msg[])) {
    setThreadStore((prev) => {
      const current = prev.threadsByProfile[activeProfileId] ?? EMPTY_THREAD;
      const nextMessages = typeof updater === 'function' ? updater(current) : updater;
      const nextThreads = {
        ...prev.threadsByProfile,
        [activeProfileId]: nextMessages
      };
      const nextSummaries = {
        ...prev.threadSummaryByProfile,
        [activeProfileId]: buildThreadSummary(nextMessages)
      };

      if (nextMessages.length === 0) {
        if (!(activeProfileId in prev.threadUpdatedAtByProfile)) {
          const restSummaries = { ...nextSummaries };
          delete restSummaries[activeProfileId];
          return {
            threadsByProfile: nextThreads,
            threadUpdatedAtByProfile: prev.threadUpdatedAtByProfile,
            threadSummaryByProfile: restSummaries
          };
        }

        const restUpdatedAt = { ...prev.threadUpdatedAtByProfile };
        delete restUpdatedAt[activeProfileId];
        const restSummaries = { ...nextSummaries };
        delete restSummaries[activeProfileId];
        return {
          threadsByProfile: nextThreads,
          threadUpdatedAtByProfile: restUpdatedAt,
          threadSummaryByProfile: restSummaries
        };
      }

      return {
        threadsByProfile: nextThreads,
        threadUpdatedAtByProfile: {
          ...prev.threadUpdatedAtByProfile,
          [activeProfileId]: Date.now()
        },
        threadSummaryByProfile: nextSummaries
      };
    });
  }

  function appendAgentProgress(line: string) {
    const next = [...agentProgressRef.current, line];
    agentProgressRef.current = next;
    setAgentProgressLines(next);
  }

  function resetAgentRunState() {
    agentRunActiveRef.current = false;
    agentCancelRequestedRef.current = false;
    agentProgressRef.current = [];
    setAgentRunStatus('idle');
    setAgentProgressLines([]);
    setAgentTerminalText('');
    setAgentActiveCommand(null);
    setPendingAgentQuestion(null);
    pendingAgentQuestionResolveRef.current = null;
    pendingAgentQuestionRejectRef.current = null;
  }

  function rejectPendingAgentQuestion(message: string) {
    pendingAgentQuestionRejectRef.current?.(new Error(message));
    pendingAgentQuestionResolveRef.current = null;
    pendingAgentQuestionRejectRef.current = null;
    setPendingAgentQuestion(null);
  }

  function buildFallbackAgentQuestionOptions(kind: 'question' | 'plan'): AgentChoiceOption[] {
    if (kind === 'plan') {
      return [
        { value: 'proceed_with_recommended_plan', label: 'Proceed with recommended plan', description: 'Let the agent continue with its best judgment.', recommended: true },
        { value: 'pause_and_explain_options', label: 'Pause and explain options', description: 'Stop and ask the agent to restate the tradeoffs more clearly.' }
      ];
    }

    return [
      { value: 'continue', label: 'Continue', description: 'Let the agent continue with its best judgment.', recommended: true },
      { value: 'pause_and_explain', label: 'Pause and explain', description: 'Stop and ask the agent to clarify the question first.' }
    ];
  }

  async function promptAgentQuestion(args: { prompt: string; options?: Array<string | AgentChoiceOption>; multiSelect?: boolean; allowFreeform?: boolean; kind?: 'question' | 'plan' }) {
    appendAgentProgress(`Agent asks: ${args.prompt}`);
    setAgentRunStatus('awaiting_input');

    const kind = args.kind ?? 'question';
    const normalizedOptions = normalizeAgentChoiceOptions(args.options);
    const options = normalizedOptions?.length ? normalizedOptions : buildFallbackAgentQuestionOptions(kind);
    const multiSelect = args.multiSelect === true;

    return await new Promise<string>((resolve, reject) => {
      pendingAgentQuestionResolveRef.current = (answer: string) => {
        pendingAgentQuestionResolveRef.current = null;
        pendingAgentQuestionRejectRef.current = null;
        setPendingAgentQuestion(null);
        if (!agentCancelRequestedRef.current) {
          setAgentRunStatus('planning');
        }
        resolve(answer);
      };
      pendingAgentQuestionRejectRef.current = (error: Error) => {
        pendingAgentQuestionResolveRef.current = null;
        pendingAgentQuestionRejectRef.current = null;
        setPendingAgentQuestion(null);
        reject(error);
      };
      setPendingAgentQuestion({
        kind,
        prompt: args.prompt,
        options,
        multiSelect,
        allowFreeform: false,
        selectedValues: []
      });
    });
  }

  function togglePendingAgentQuestionOption(optionValue: string) {
    setPendingAgentQuestion((current) => {
      if (!current) return current;
      if (current.multiSelect) {
        const selectedValues = current.selectedValues.includes(optionValue)
          ? current.selectedValues.filter((value) => value !== optionValue)
          : [...current.selectedValues, optionValue];
        return { ...current, selectedValues };
      }
      return {
        ...current,
        selectedValues: current.selectedValues[0] === optionValue ? [] : [optionValue]
      };
    });
  }

  function buildPendingAgentAnswer(question: PendingAgentQuestion) {
    if (question.multiSelect) {
      return JSON.stringify(question.selectedValues);
    }
    return question.selectedValues[0] ?? '';
  }

  function submitPendingAgentAnswer(answer: string) {
    const trimmed = answer.trim();
    if (!trimmed) return;
    appendAgentProgress(`Agent answer: ${trimmed}`);
    pendingAgentQuestionResolveRef.current?.(trimmed);
  }

  function submitPendingAgentSelection() {
    if (!pendingAgentQuestion) return;
    submitPendingAgentAnswer(buildPendingAgentAnswer(pendingAgentQuestion));
  }

  function updateAgentPlaceholder(userText: string, statusText: string) {
    setCurrentMessages([...messages, { role: 'user', content: userText }, { role: 'assistant', content: statusText }]);
  }

  function isAgentCancelledError(error: unknown) {
    return error instanceof Error && /cancelled/i.test(error.message);
  }

  function assertAgentNotCancelled() {
    if (agentCancelRequestedRef.current) {
      throw new Error('Agent run cancelled');
    }
  }

  async function cancelActiveAgentRun() {
    if (agentRunStatus === 'cancelling') return;
    agentCancelRequestedRef.current = true;
    setAgentRunStatus('cancelling');
    rejectPendingAgentQuestion('Agent run cancelled');
    await onInterruptAgentRun();
  }

  async function streamNativeAgentFinal(outgoingText: string, finalContent: string, options?: { openClawUsage?: Msg['openClawUsage'] }) {
    setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: finalContent, openClawUsage: options?.openClawUsage }]);
  }

  const connectionHint = useMemo(() => {
    const modeLabel = settings.interactionMode === 'claude_cli'
      ? 'Claude CLI runtime'
      : settings.interactionMode === 'native_agent'
        ? 'Native agent runtime'
        : 'Standard chat';
    if (settings.interactionMode === 'claude_cli') {
      return `${settings.name} · ${modeLabel} · uses local 'claude' executable from PATH`;
    }
    if (settings.providerId === 'github_copilot') {
      const url = settings.baseUrl.trim() || 'http://127.0.0.1:4141';
      const model = settings.model.trim() || '(missing model)';
      return `${settings.name} · ${modeLabel} · gateway: ${url} · model: ${model}`;
    }
    if (settings.providerId === 'openai_compat') {
      return `${settings.name} · ${modeLabel} · OpenAI-compatible: ${settings.baseUrl.trim() || '(missing baseUrl)'} · model: ${settings.model.trim() || '(missing model)'}`;
    }
    return `${settings.name} · ${modeLabel} · Anthropic-compatible: ${settings.baseUrl.trim() || 'https://api.anthropic.com'} · model: ${settings.model.trim() || '(missing model)'}`;
  }, [settings]);

  const currentProfileSummary = useMemo(() => {
    return `${settings.name} · ${modeLabelFor(settings.interactionMode)} · ${providerLabelFor(settings.providerId)}`;
  }, [settings]);

  const currentProfileDetail = useMemo(() => {
    if (settings.interactionMode === 'claude_cli') {
      return 'Runtime source: local Claude CLI from PATH. Provider and model are managed by the CLI runtime.';
    }

    if (settings.providerId === 'github_copilot') {
      return `Gateway ${settings.baseUrl.trim() || 'http://127.0.0.1:4141'} · model ${settings.model.trim() || '(missing model)'}`;
    }

    if (settings.providerId === 'openai_compat') {
      return `Gateway ${settings.baseUrl.trim() || '(missing baseUrl)'} · model ${settings.model.trim() || '(missing model)'}`;
    }

    return `Endpoint ${settings.baseUrl.trim() || 'https://api.anthropic.com'} · model ${settings.model.trim() || '(missing model)'}`;
  }, [settings]);

  const connectionKey = useMemo(
    () => [settings.interactionMode, settings.providerId, settings.baseUrl.trim(), settings.apiKey.trim(), settings.model.trim()].join('|'),
    [settings.apiKey, settings.baseUrl, settings.interactionMode, settings.model, settings.providerId]
  );
  const [connectionRefreshTick, setConnectionRefreshTick] = useState(0);

  useEffect(() => {
    function refreshConnectionOnResume() {
      if (document.visibilityState === 'hidden') return;
      setConnectionRefreshTick((value) => value + 1);
    }

    window.addEventListener('focus', refreshConnectionOnResume);
    window.addEventListener('pageshow', refreshConnectionOnResume);
    document.addEventListener('visibilitychange', refreshConnectionOnResume);

    return () => {
      window.removeEventListener('focus', refreshConnectionOnResume);
      window.removeEventListener('pageshow', refreshConnectionOnResume);
      document.removeEventListener('visibilitychange', refreshConnectionOnResume);
    };
  }, []);

  useEffect(() => {
    scheduleThreadPersist(activeProfileId, messages, activeThreadUpdatedAt);
  }, [activeProfileId, activeThreadUpdatedAt, messages]);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el || !shouldStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    return () => {
      flushPendingThreadPersist();
      activeStreamRef.current?.close();
      activeStreamRef.current = null;
      agentRunActiveRef.current = false;
      agentCancelRequestedRef.current = true;
      pendingAgentQuestionRejectRef.current?.(new Error('Agent run cancelled'));
    };
  }, []);

  useEffect(() => {
    agentRunActiveRef.current = false;
    agentCancelRequestedRef.current = false;
    agentProgressRef.current = [];
    setAgentRunStatus('idle');
    setAgentProgressLines([]);
    setAgentTerminalText('');
    setAgentActiveCommand(null);
    setPendingAgentQuestion(null);
    pendingAgentQuestionResolveRef.current = null;
    pendingAgentQuestionRejectRef.current = null;
    setClaudeCliHandoffNotice(null);
    setInspectorDrawerOpen(false);
    setInspectorSection('overview');
    setHistoryDrawerOpen(false);
    setHistoryQuery('');
    setSelectedInspectorFile(null);
    setSelectedInspectorFileContent('');
    setSelectedInspectorFileError(null);
    setSelectedInspectorFileLoading(false);
    setSelectedInspectorSkill(null);
    setSelectedInspectorSkillContent('');
    setSelectedInspectorSkillError(null);
    setSelectedInspectorSkillLoading(false);
  }, [activeProfileId]);

  useEffect(() => {
    const off = terminalClient.onEvent((event: TerminalEvent) => {
      if (!agentRunActiveRef.current) return;
      if (event.type === 'data') {
        setAgentTerminalText((prev) => `${prev}${event.data}`.slice(-8000));
        return;
      }
      if (event.type === 'exit') {
        const line = `\n[process exited${event.signal ? `: ${event.signal}` : `: ${event.exitCode ?? 0}`}]\n`;
        setAgentTerminalText((prev) => `${prev}${line}`.slice(-8000));
      }
    });
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli') {
      setClaudeRuntimeState(INITIAL_CLAUDE_RUNTIME_STATE);
      return;
    }

    const off = nativeAgentClient.subscribe(setClaudeRuntimeState);
    return () => {
      off();
    };
  }, [settings.interactionMode]);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli' && settings.interactionMode !== 'native_agent') {
      setMemorySnapshot(null);
      setMemoryLoading(false);
      setMemoryError(null);
      return;
    }

    const workspaceRoot = cliRuntimeState.workspaceRoot || workspaceContext.workspaceRoot;
    if (!workspaceRoot) {
      setMemorySnapshot(null);
      setMemoryLoading(false);
      setMemoryError('No workspace selected');
      return;
    }

    let cancelled = false;
    setMemoryLoading(true);
    setMemoryError(null);

    void fsClient.getAgentMemorySnapshot(workspaceRoot)
      .then((snapshot) => {
        if (cancelled) return;
        setMemorySnapshot(snapshot);
        setMemoryLoading(false);
        setMemoryError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setMemorySnapshot(null);
        setMemoryLoading(false);
        setMemoryError(error instanceof Error ? error.message : 'Unable to inspect workspace memory');
      });

    return () => {
      cancelled = true;
    };
  }, [cliRuntimeState.workspaceRoot, memoryRefreshTick, settings.interactionMode, workspaceContext.workspaceRoot]);

  useEffect(() => {
    let cancelled = false;

    if (settings.interactionMode === 'claude_cli') {
      setConnectionState({
        key: connectionKey,
        status: 'ok',
        message: "Using local Claude CLI from PATH. Provider settings are handled by Claude Code itself."
      });
      return () => {
        cancelled = true;
      };
    }

    void checkProviderConnection({
      providerId: settings.providerId,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model
    })
      .then((result) => {
        if (cancelled) return;
        setConnectionState({
          key: connectionKey,
          status: result.ok ? 'ok' : 'error',
          message: result.message
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setConnectionState({
          key: connectionKey,
          status: 'error',
          message: error instanceof Error ? error.message : 'Connection check failed'
        });
      });

    return () => {
      cancelled = true;
    };
  }, [connectionKey, connectionRefreshTick, settings.apiKey, settings.baseUrl, settings.interactionMode, settings.model, settings.providerId]);

  useEffect(() => {
    if (!workspaceContext.workspaceRoot) {
      setWorkspaceSkills([]);
      setSkillsLoading(false);
      setSkillsError(null);
      return;
    }

    setSkillsLoading(true);
    setSkillsError(null);

    const instructionFiles = memorySnapshot?.instructionFiles ?? [];
    const normalized: RuntimeSkillItem[] = instructionFiles
      .filter((item) => /(^|\/)(skill\.md|skill\.prompt\.md|skill\.instructions\.md|.*\.skill\.md)$/i.test(item.relativePath) || /skill/i.test(item.name))
      .map((item) => ({
        key: item.id,
        name: item.name,
        source: item.scope === 'project' ? 'workspace' : 'runtime',
        meta: item.relativePath,
        path: item.path
      }));

    setWorkspaceSkills(normalized);
    setSkillsLoading(false);
    setSkillsError(null);
  }, [memorySnapshot, skillsRefreshTick, workspaceContext.workspaceRoot]);

  useEffect(() => {
    if (!workspaceContext.openClaw.installed) {
      setOpenClawSkills([]);
      setOpenClawSkillsLoading(false);
      setOpenClawSkillsError(null);
      return;
    }

    let cancelled = false;
    setOpenClawSkillsLoading(true);
    setOpenClawSkillsError(null);

    void fsClient.runWorkspaceCommand(OPENCLAW_ELIGIBLE_SKILLS_COMMAND, 20000)
      .then((result) => {
        if (cancelled) return;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || 'Unable to read OpenClaw skills');
        }

        const skills = parseOpenClawSkillList(result.stdout).map((skill) => ({
          key: `openclaw:${skill.name}`,
          name: skill.name,
          source: 'openclaw' as const,
          meta: skill.description,
          preview: skill.description,
          openClawSkillName: skill.name
        }));

        setOpenClawSkills(skills);
        setOpenClawSkillsLoading(false);
        setOpenClawSkillsError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setOpenClawSkills([]);
        setOpenClawSkillsLoading(false);
        setOpenClawSkillsError(error instanceof Error ? error.message : 'Unable to read OpenClaw skills');
      });

    return () => {
      cancelled = true;
    };
  }, [skillsRefreshTick, workspaceContext.openClaw.installed]);

  const currentConnectionState = connectionState?.key === connectionKey ? connectionState : null;

  const canSend = useMemo(() => {
    if (settings.interactionMode === 'claude_cli') {
      if (!input.trim()) return false;
      return !isStreaming;
    }
    if (settings.providerId !== 'github_copilot' && !settings.apiKey.trim()) return false;
    if ((settings.providerId === 'openai_compat' || settings.providerId === 'github_copilot') && !settings.baseUrl.trim()) return false;
    if (!settings.model.trim()) return false;
    if (!input.trim()) return false;
    return !isStreaming;
  }, [input, isStreaming, settings.apiKey, settings.baseUrl, settings.interactionMode, settings.model, settings.providerId]);

  const workspaceSummary = useMemo(() => {
    if (!workspaceContext.workspaceRoot) return 'No workspace selected';
    const entryNames = workspaceContext.topLevelEntries.slice(0, 8).map((entry) => `${entry.kind === 'dir' ? '[dir]' : '[file]'} ${entry.name}`);
    const focusPath = workspaceContext.selectedPath ?? workspaceContext.activePath;
    const focusLabel = workspaceContext.selectedEntryKind === 'dir' ? 'Selected folder' : 'Open file';
    const lines = [
      `Workspace root: ${workspaceContext.workspaceRoot}`,
      `Workspace scope: ${workspaceContext.workspaceScopePath ?? workspaceContext.workspaceRoot}`,
      `${focusLabel}: ${focusPath ?? 'None'}`,
      `Unsaved edits: ${workspaceContext.dirty ? 'yes' : 'no'}`,
      `Top-level entries: ${entryNames.length ? entryNames.join(', ') : '(empty)'}`,
      `Interaction mode: ${settings.interactionMode === 'claude_cli' ? 'Claude CLI runtime session' : settings.interactionMode === 'native_agent' ? 'Native agent persistent coding session' : 'Standard chat session'}`
    ];
    if (workspaceContext.javaProject.enabled) {
      lines.push(`Java project: ${workspaceContext.javaProject.buildTool ?? 'plain'}${workspaceContext.javaProject.hasWrapper ? ' (wrapper)' : ''}`);
      lines.push(`Java active type: ${workspaceContext.javaProject.typeName ?? 'None'}`);
      lines.push(`Java package: ${workspaceContext.javaProject.packageName ?? 'None'}`);
      lines.push(`Java main(): ${workspaceContext.javaProject.hasMainMethod ? 'yes' : 'no'}`);
      lines.push(`Java tests: ${workspaceContext.javaProject.hasTestMethods ? 'yes' : 'no'}`);
    }
    if (workspaceContext.activePath) {
      lines.push('Active file content:');
      lines.push(workspaceContext.activeText || '(empty file)');
    }
    return lines.join('\n');
  }, [settings.interactionMode, workspaceContext]);

  function captureNativeAgentInspectorSnapshot(options: {
    startedAt: number;
    requestMode: 'structured' | 'legacy';
    outgoingText: string;
    memoryContext: string;
    systemPrompt: string;
    payload: unknown;
    progressLines: string[];
    toolEvents: NativeAgentToolEvent[];
    lastResponse?: string;
  }) {
    setNativeAgentInspectorSnapshot({
      startedAt: options.startedAt,
      updatedAt: Date.now(),
      requestMode: options.requestMode,
      outgoingText: options.outgoingText,
      workspaceSummary,
      memoryContext: options.memoryContext,
      systemPrompt: options.systemPrompt,
      payload: JSON.stringify(options.payload, null, 2),
      lastResponse: options.lastResponse?.trim() ?? '',
      progressLines: [...options.progressLines],
      toolEvents: [...options.toolEvents]
    });
  }

  function buildChatMessages(nextMessages: Msg[], nativeMemoryContext = ''): ChatMessage[] {
    const modeInstruction = settings.interactionMode === 'native_agent'
      ? 'Operate like a persistent coding agent in an ongoing workspace session. Maintain continuity across turns, continue prior plans without restating everything, prefer concrete next actions, and stay focused on editing, running, and validating project work.'
      : 'You are operating inside a desktop workspace editor. Use the provided workspace context to reason about the current project. When proposing file changes, reference concrete file paths and explain the intended edits clearly.';

    const contextPrefix: ChatMessage[] = [{ role: 'system', content: modeInstruction }];

    if (settings.interactionMode === 'native_agent' && nativeMemoryContext) {
      contextPrefix.push({ role: 'system', content: nativeMemoryContext });
    }

    if (workspaceContext.workspaceRoot) {
      contextPrefix.push({ role: 'system', content: workspaceSummary });
    }

    return [
      ...contextPrefix,
      ...nextMessages
        .filter((m) => m.role !== 'assistant' || m.content.length > 0)
        .map((m) => ({ role: m.role, content: m.content }))
    ];
  }

  function buildAgentSystemPrompt(nativeMemoryContext = '') {
    const sections = [
      'You are an autonomous coding agent for this workspace.',
      'Maintain continuity across turns and keep working until the task is complete or genuinely blocked.',
      'Use the provided tools for filesystem and terminal access instead of describing tool calls in plain text or JSON.',
      'Do not rely on a built-in browser-opening tool. When browser-backed work is needed, prefer OpenClaw delegation or another readable content path.',
      'Opening a page is only a step, not the finish line. If the user asked you to read, extract, summarize, rank, analyze, or report on page contents, continue until that content task is actually completed.',
      'When OpenClaw skills are available and the task matches one of those domains, inspect them with openclaw_skill_list or openclaw_skill_info, then delegate to openclaw_agent instead of explaining the limitation yourself.',
      'Use openclaw_agent responseMode=json when the user wants structured output, and forceSkill=true when a specific OpenClaw skill must be used rather than auto-fallback.',
      'For non-trivial requests with multiple valid approaches, ask the user to choose a plan before executing. Use ask_user kind=plan with 2 to 4 clickable options and short tradeoffs.',
      'When there is an actual decision to make or multiple valid paths, use ask_user with concise clickable choices instead of guessing. Do not request freeform typing.',
      'Prefer inspecting the workspace before editing, prefer read_file_range over full-file reads for large files, prefer targeted patches over full rewrites, and run validation commands when they are relevant.',
      'When the task is complete, answer the user directly in normal prose.',
      workspaceSummary
    ];

    if (nativeMemoryContext) {
      sections.push(nativeMemoryContext);
    }

    return sections.join('\n\n');
  }

  function buildAgentSessionMessages(nextMessages: Msg[]): AgentSessionMessage[] {
    return nextMessages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: message.content }]
    }));
  }

  function buildAgentMessages(baseMessages: Msg[], nativeMemoryContext = ''): ChatMessage[] {
    const toolInstruction: ChatMessage = {
      role: 'system',
      content: [
        'You are an autonomous coding agent for this workspace.',
        'Respond with JSON only and choose exactly one next step.',
        'Do not add explanatory text before or after the JSON object.',
        'Valid responses:',
        '{"type":"action","tool":"list_dir","args":{"path":"relative/or/absolute/path"}}',
        '{"type":"action","tool":"read_file","args":{"path":"relative/or/absolute/path"}}',
        '{"type":"action","tool":"read_file_range","args":{"path":"relative/or/absolute/path","startLine":1,"endLine":120}}',
        '{"type":"action","tool":"search_text","args":{"query":"symbolName","path":"relative/or/absolute/path","isRegexp":false,"maxResults":40}}',
        '{"type":"action","tool":"apply_patch","args":{"path":"relative/or/absolute/path","replacements":[{"oldText":"exact existing text","newText":"replacement text"}]}}',
        '{"type":"action","tool":"write_file","args":{"path":"relative/or/absolute/path","content":"full file content"}}',
        '{"type":"action","tool":"create_file","args":{"path":"relative/or/absolute/path","content":"optional new file content"}}',
        '{"type":"action","tool":"create_dir","args":{"path":"relative/or/absolute/path"}}',
        '{"type":"action","tool":"delete_entry","args":{"path":"relative/or/absolute/path"}}',
        '{"type":"action","tool":"git_status","args":{"workspaceRoot":"optional workspace root"}}',
        '{"type":"action","tool":"git_diff","args":{"path":"relative/or/absolute/path","staged":false}}',
        '{"type":"action","tool":"openclaw_skill_list","args":{"eligibleOnly":true}}',
        '{"type":"action","tool":"openclaw_skill_info","args":{"name":"coding-agent"}}',
        '{"type":"action","tool":"openclaw_agent","args":{"prompt":"Use the weather skill to get Beijing weather and return concise JSON.","skillName":"weather","responseMode":"json","forceSkill":true}}',
        '{"type":"action","tool":"run_command","args":{"command":"shell command","timeoutMs":20000}}',
        '{"type":"action","tool":"ask_user","args":{"prompt":"question for the user","options":["choice A","choice B"]}}',
        '{"type":"action","tool":"ask_user","args":{"kind":"plan","prompt":"Choose an implementation plan","options":[{"value":"safe","label":"Minimal patch","description":"Smallest possible change, low risk","recommended":true},{"value":"deeper","label":"Refactor the flow","description":"Cleaner long-term structure, larger change"}]}}',
        '{"type":"action","tool":"ask_user","args":{"prompt":"Which outputs should I include?","multiSelect":true,"options":[{"value":"summary","label":"Summary"},{"value":"risks","label":"Risks"},{"value":"next_steps","label":"Next steps"}]}}',
        '{"type":"final","message":"user-facing answer"}',
        'Rules:',
        '- Use one tool at a time.',
        '- Keep the action wrapper. Prefer {"type":"action","tool":"read_file","args":...} over shorthand forms like {"type":"read_file",...}.',
        '- For larger or ambiguous tasks, prefer ask_user kind=plan before taking irreversible steps.',
        '- Use ask_user when there is a real user choice or ambiguity that should not be guessed.',
        '- ask_user should use clickable options, not freeform typing. Supply 2 to 4 options when possible, and use multiSelect=true when multiple choices should be allowed.',
        '- Prefer list_dir/search_text/read_file_range before editing files when possible.',
        '- Do not invent a browser-opening tool call. For browser-backed tasks, prefer OpenClaw delegation or another readable content path.',
        '- Prefer apply_patch for targeted edits to existing files.',
        '- apply_patch may include multiple exact replacements in one call when they belong to the same file change.',
        '- Prefer create_file/create_dir when creating new paths and delete_entry when removing them.',
        '- Prefer git_status/git_diff over raw shell Git commands for repository inspection.',
        '- Use openclaw_skill_list to discover eligible OpenClaw skills, openclaw_skill_info to inspect one, and openclaw_agent to actually delegate the matching workflow.',
        '- openclaw_agent supports responseMode=json for structured replies and forceSkill=true when you must require the named OpenClaw skill.',
        '- When the user asks for browser-backed search, web lookup, dashboards, GitHub operations, weather, or other OpenClaw-covered workflows, prefer OpenClaw delegation over saying the capability is unavailable.',
        '- Use write_file only for new files or full rewrites when patching is not practical.',
        '- Use run_command for build/test/inspection commands when needed.',
        '- After a tool result is returned, continue with another JSON response.',
        '- If the task is complete, return type=final.'
      ].join('\n')
    };

    return [toolInstruction, ...buildChatMessages(baseMessages, nativeMemoryContext)];
  }

  async function requestAgentTurn(
    reqMessages: AgentSessionMessage[],
    systemPrompt: string,
    hooks?: {
      onText?: (text: string) => void;
      onToolUse?: (toolName: string) => void;
    }
  ) {
    return await new Promise<AgentTurnResult>((resolve, reject) => {
      let text = '';
      let stopReason: string | undefined;
      const toolUses: AgentTurnResult['toolUses'] = [];
      let settled = false;
      const stream = openAgentSessionStream({
        kind: 'agent_session',
        providerId: settings.providerId,
        baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
        apiKey: settings.apiKey,
        model: settings.model,
        system: systemPrompt,
        messages: reqMessages,
        temperature: 0.1,
        maxTokens: 4096
      });

      activeStreamRef.current = stream;

      const finishResolve = (value: AgentTurnResult) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const off = stream.onEvent((ev) => {
        if (ev.kind !== 'agent_session') return;
        if (ev.type === 'text') {
          text += ev.text;
          hooks?.onText?.(text);
          return;
        }
        if (ev.type === 'tool_use') {
          toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
          hooks?.onToolUse?.(ev.name);
          return;
        }
        if (ev.type === 'error') {
          off();
          stream.close();
          if (activeStreamRef.current === stream) {
            activeStreamRef.current = null;
          }
          finishReject(new Error(ev.message));
          return;
        }
        if (ev.type === 'done') {
          stopReason = ev.stopReason;
          off();
          stream.close();
          if (activeStreamRef.current === stream) {
            activeStreamRef.current = null;
          }
          finishResolve({ text, toolUses, stopReason });
        }
      });

      stream.onError((message) => {
        finishReject(new Error(message));
      });

      stream.onClose(() => {
        if (activeStreamRef.current === stream) {
          activeStreamRef.current = null;
        }
        if (!settled) {
          finishReject(new Error(agentCancelRequestedRef.current ? 'Agent run cancelled' : 'Agent session closed before completion'));
        }
      });
    });
  }

  async function requestModelText(reqMessages: ChatMessage[], hooks?: { onToken?: (text: string) => void }) {
    return await new Promise<string>((resolve, reject) => {
      let text = '';
      let settled = false;
      const req: ChatRequest = {
        providerId: settings.providerId,
        baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
        apiKey: settings.apiKey,
        model: settings.model,
        interactionMode: settings.interactionMode,
        messages: reqMessages,
        temperature: settings.interactionMode === 'native_agent' ? 0.1 : 0.2
      };

      const stream = openChatStream(req);
      activeStreamRef.current = stream;
      const finishResolve = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const off = stream.onEvent((ev) => {
        if (ev.kind !== 'chat') return;
        if (ev.type === 'token') {
          text += ev.text;
          hooks?.onToken?.(text);
          return;
        }
        if (ev.type === 'error') {
          off();
          stream.close();
          if (activeStreamRef.current === stream) {
            activeStreamRef.current = null;
          }
          finishReject(new Error(ev.message));
          return;
        }
        if (ev.type === 'done') {
          off();
          stream.close();
          if (activeStreamRef.current === stream) {
            activeStreamRef.current = null;
          }
          finishResolve(text);
        }
      });

      stream.onError((message) => {
        finishReject(new Error(message));
      });

      stream.onClose(() => {
        if (activeStreamRef.current === stream) {
          activeStreamRef.current = null;
        }
        if (!settled) {
          finishReject(new Error(agentCancelRequestedRef.current ? 'Agent run cancelled' : 'Stream closed before completion'));
        }
      });
    });
  }

  async function executeAgentTool(action: Extract<AgentAction, { type: 'action' }>) {
    if (action.tool === 'list_dir') {
      const path = action.args.path?.trim() || workspaceContext.workspaceRoot || '.';
      const entries = await fsClient.listWorkspaceDir(path);
      const lines = entries.map((entry) => `${entry.kind}\t${entry.path}`);
      return `TOOL_RESULT list_dir\npath: ${path}\n${lines.join('\n') || '(empty)'}`;
    }

    if (action.tool === 'read_file') {
      const file = await fsClient.readWorkspaceFile(action.args.path);
      if (file.kind === 'binary') {
        return `TOOL_RESULT read_file\npath: ${action.args.path}\n(binary file, size=${file.size})`;
      }
      return `TOOL_RESULT read_file\npath: ${action.args.path}\n${file.contents ?? ''}`;
    }

    if (action.tool === 'read_file_range') {
      if (!Number.isFinite(action.args.startLine) || !Number.isFinite(action.args.endLine)) {
        return `TOOL_RESULT read_file_range\npath: ${action.args.path}\nstatus: failed\nreason: invalid line range`;
      }
      const contents = await fsClient.readWorkspaceTextFile(action.args.path);
      const range = formatLineRange(contents, action.args.startLine, action.args.endLine);
      return `TOOL_RESULT read_file_range\npath: ${action.args.path}\nstartLine: ${range.startLine}\nendLine: ${range.endLine}\ntotalLines: ${range.totalLines}\n${range.contents}`;
    }

    if (action.tool === 'search_text') {
      const scopePath = action.args.path?.trim() || workspaceContext.workspaceRoot || '.';
      const query = action.args.query.trim();
      if (!query) {
        return 'TOOL_RESULT search_text\nstatus: failed\nreason: empty query';
      }
      const maxResults = Math.min(200, Math.max(1, Math.floor(action.args.maxResults ?? 40)));
      const flags = [
        'command -v rg >/dev/null 2>&1 || { echo "rg not available"; exit 127; }',
        `rg --line-number --no-heading --color never --smart-case ${action.args.isRegexp ? '' : '--fixed-strings '}-- ${quoteShellArg(query)} ${quoteShellArg(scopePath)} | head -n ${maxResults}`
      ].join(' && ');
      const result = await fsClient.runWorkspaceCommand(flags, 20000);
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return `TOOL_RESULT search_text\nquery: ${query}\npath: ${scopePath}\nstatus: failed\n${summarizeCommandResult(result)}`;
      }
      return `TOOL_RESULT search_text\nquery: ${query}\npath: ${scopePath}\nmaxResults: ${maxResults}\n${result.stdout.trim() || '(no matches)'}`;
    }

    if (action.tool === 'apply_patch') {
      const file = await fsClient.readWorkspaceFile(action.args.path);
      if (file.kind === 'binary') {
        return `TOOL_RESULT apply_patch\npath: ${action.args.path}\nstatus: failed\nreason: binary file`;
      }

      const replacements = normalizePatchReplacements(action.args);
      if (replacements.length === 0) {
        return `TOOL_RESULT apply_patch\npath: ${action.args.path}\nstatus: failed\nreason: no valid replacements supplied`;
      }

      let next = file.contents ?? '';
      for (let index = 0; index < replacements.length; index += 1) {
        const replacement = replacements[index];
        const matches = countOccurrences(next, replacement.oldText);
        if (matches !== 1) {
          return `TOOL_RESULT apply_patch\npath: ${action.args.path}\nstatus: failed\nreason: replacement ${index + 1} expected exactly 1 match, found ${matches}`;
        }
        next = next.replace(replacement.oldText, replacement.newText);
      }

      await fsClient.writeWorkspaceTextFile(action.args.path, next);
      await workspacePanelRef.current?.syncExternalWrite(action.args.path, next);
      return `TOOL_RESULT apply_patch\npath: ${action.args.path}\nstatus: ok\nreplacements: ${replacements.length}`;
    }

    if (action.tool === 'write_file') {
      await fsClient.writeWorkspaceTextFile(action.args.path, action.args.content);
      await workspacePanelRef.current?.syncExternalWrite(action.args.path, action.args.content);
      return `TOOL_RESULT write_file\npath: ${action.args.path}\nstatus: ok\nbytes: ${action.args.content.length}`;
    }

    if (action.tool === 'create_file') {
      const contents = action.args.content ?? '';
      await fsClient.createWorkspaceFile(action.args.path, contents);
      await workspacePanelRef.current?.syncExternalWrite(action.args.path, contents);
      return `TOOL_RESULT create_file\npath: ${action.args.path}\nstatus: ok\nbytes: ${contents.length}`;
    }

    if (action.tool === 'create_dir') {
      await fsClient.createWorkspaceDir(action.args.path);
      return `TOOL_RESULT create_dir\npath: ${action.args.path}\nstatus: ok`;
    }

    if (action.tool === 'delete_entry') {
      await fsClient.deleteWorkspaceEntry(action.args.path);
      return `TOOL_RESULT delete_entry\npath: ${action.args.path}\nstatus: ok`;
    }

    if (action.tool === 'git_status') {
      const workspaceRoot = action.args.workspaceRoot?.trim() || workspaceContext.workspaceRoot;
      if (!workspaceRoot) {
        return 'TOOL_RESULT git_status\nstatus: failed\nreason: no workspace root selected';
      }
      const snapshot = await fsClient.getGitRepository(workspaceRoot);
      return `TOOL_RESULT git_status\n${summarizeGitStatus(snapshot)}`;
    }

    if (action.tool === 'git_diff') {
      const workspaceRoot = action.args.workspaceRoot?.trim() || workspaceContext.workspaceRoot;
      if (!workspaceRoot) {
        return `TOOL_RESULT git_diff\npath: ${action.args.path}\nstatus: failed\nreason: no workspace root selected`;
      }
      const snapshot = await fsClient.getGitDiff(workspaceRoot, action.args.path, action.args.staged ?? false);
      return `TOOL_RESULT git_diff\nworkspaceRoot: ${snapshot.workspaceRoot}\npath: ${snapshot.path}\nstaged: ${snapshot.staged ? 'yes' : 'no'}\n${snapshot.diff || '(no diff)'}`;
    }

    if (action.tool === 'openclaw_skill_list') {
      const command = action.args.eligibleOnly === false
        ? 'openclaw skills list --json'
        : 'openclaw skills list --eligible --json';
      const result = await fsClient.runWorkspaceCommand(command, 20000);
      if (result.exitCode !== 0) {
        return `TOOL_RESULT openclaw_skill_list\nstatus: failed\n${summarizeCommandResult(result)}`;
      }
      const skills = parseOpenClawSkillList(result.stdout);
      const lines = skills.map((skill) => {
        const parts = [skill.name];
        if (skill.description) parts.push(skill.description);
        parts.push(`eligible=${skill.eligible ? 'yes' : 'no'}`);
        if (skill.source) parts.push(`source=${skill.source}`);
        return `- ${parts.join(' | ')}`;
      });
      return `TOOL_RESULT openclaw_skill_list\neligibleOnly: ${action.args.eligibleOnly === false ? 'no' : 'yes'}\ncount: ${skills.length}\n${lines.join('\n') || '(no skills found)'}`;
    }

    if (action.tool === 'openclaw_skill_info') {
      const name = action.args.name?.trim();
      if (!name) {
        return 'TOOL_RESULT openclaw_skill_info\nstatus: failed\nreason: missing skill name';
      }
      const result = await fsClient.runWorkspaceCommand(`openclaw skills info ${quoteShellArg(name)} --json`, 20000);
      if (result.exitCode !== 0) {
        return `TOOL_RESULT openclaw_skill_info\nname: ${name}\nstatus: failed\n${summarizeCommandResult(result)}`;
      }
      const info = JSON.parse(result.stdout) as OpenClawSkillInfo;
      return `TOOL_RESULT openclaw_skill_info\nname: ${name}\n${formatOpenClawSkillInfo(info)}`;
    }

    if (action.tool === 'openclaw_agent') {
      const prompt = action.args.prompt?.trim();
      if (!prompt) {
        return 'TOOL_RESULT openclaw_agent\nstatus: failed\nreason: missing prompt';
      }
      latestOpenClawRawOutputRef.current = null;
      latestOpenClawUsageRef.current = null;
      const healthResult = await fsClient.runWorkspaceCommand('openclaw health --json', 15000);
      let agentId = action.args.agentId?.trim() || 'main';
      if (healthResult.exitCode === 0) {
        try {
          const health = JSON.parse(healthResult.stdout) as { defaultAgentId?: string };
          if (typeof health.defaultAgentId === 'string' && health.defaultAgentId.trim()) {
            agentId = health.defaultAgentId.trim();
          }
        } catch {
          // ignore health parse failures and fall back to main
        }
      }
      const delegatedPrompt = buildOpenClawAgentPrompt(prompt, {
        skillName: action.args.skillName?.trim(),
        responseMode: action.args.responseMode,
        forceSkill: action.args.forceSkill
      });
      const command = [
        'openclaw agent',
        `--agent ${quoteShellArg(agentId)}`,
        '--local',
        '--json',
        `--message ${quoteShellArg(delegatedPrompt)}`
      ].join(' ');
      const result = await fsClient.runWorkspaceCommand(command, action.args.timeoutMs ?? 60000);
      if (result.exitCode !== 0) {
        return `TOOL_RESULT openclaw_agent\nagentId: ${agentId}\nskillName: ${action.args.skillName ?? '(auto)'}\nstatus: failed\n${summarizeCommandResult(result)}`;
      }
      latestOpenClawRawOutputRef.current = result.stdout;
      latestOpenClawUsageRef.current = {
        skillName: action.args.skillName?.trim() || undefined,
        agentId,
        responseMode: action.args.responseMode ?? 'text',
        forceSkill: action.args.forceSkill === true
      };
      return `TOOL_RESULT openclaw_agent\nagentId: ${agentId}\nskillName: ${action.args.skillName ?? '(auto)'}\nstatus: ok\n${formatOpenClawAgentResult(result.stdout)}`;
    }

    if (action.tool === 'ask_user') {
      const answer = await promptAgentQuestion(action.args);
      return `TOOL_RESULT ask_user\nprompt: ${action.args.prompt}\nanswer: ${answer}`;
    }

    setAgentRunStatus('running_command');
    setAgentActiveCommand(action.args.command);
    appendAgentProgress(`Running in terminal: ${action.args.command}`);
    try {
      const result = await onRunCommandInTerminal(action.args.command, action.args.timeoutMs ?? 20000);
      return `TOOL_RESULT run_command\ncommand: ${action.args.command}\n${summarizeCommandResult(result)}`;
    } finally {
      setAgentActiveCommand(null);
      if (!agentCancelRequestedRef.current) {
        setAgentRunStatus('planning');
      }
    }
  }

  function shouldFallbackToLegacyAgent(error: unknown) {
    if (!(error instanceof Error)) return false;
    return /does not support agent session/i.test(error.message);
  }

  async function runStructuredClaudeCodeAgent(outgoingText: string) {
    agentRunActiveRef.current = true;
    agentCancelRequestedRef.current = false;
    agentProgressRef.current = [];
    setAgentTerminalText('');
    setAgentActiveCommand(null);
    setAgentRunStatus('planning');
    const transcriptBase: Msg[] = [...messages, { role: 'user', content: outgoingText }];
    const visiblePrefix: Msg[] = [...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: 'Agent: planning…' }];
    const agentMessages = buildAgentSessionMessages(transcriptBase);
    const nativeMemoryContext = [
      buildNativeAgentMemoryContext(memorySnapshot, outgoingText, workspaceSummary),
      buildOpenClawSkillsContext(discoveredSkills, outgoingText, workspaceSummary)
    ].filter(Boolean).join('\n\n');
    const systemPrompt = buildAgentSystemPrompt(nativeMemoryContext);
    const turnStartedAt = Date.now();
    const progress: string[] = ['Agent: planning…'];
    const toolEvents: NativeAgentToolEvent[] = [];
    let lastOpenClawUsage: Msg['openClawUsage'] | undefined;
    agentProgressRef.current = [...progress];
    setAgentProgressLines([...progress]);
    appendAgentProgress(`Agent session: provider=${settings.providerId}`);

    setCurrentMessages(visiblePrefix);

    for (let step = 0; step < 8; step += 1) {
      assertAgentNotCancelled();
      captureNativeAgentInspectorSnapshot({
        startedAt: turnStartedAt,
        requestMode: 'structured',
        outgoingText,
        memoryContext: nativeMemoryContext,
        systemPrompt,
        payload: {
          kind: 'agent_session',
          providerId: settings.providerId,
          baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
          model: settings.model,
          system: systemPrompt,
          temperature: 0.1,
          maxTokens: 4096,
          messages: agentMessages
        },
        progressLines: progress,
        toolEvents
      });
      let sawToolUseThisTurn = false;
      const turn = await requestAgentTurn(agentMessages, systemPrompt, {
        onText: (text) => {
          if (sawToolUseThisTurn) return;
          updateAgentPlaceholder(outgoingText, text.trim() ? 'Agent: drafting response…' : 'Agent: planning…');
        },
        onToolUse: (toolName) => {
          sawToolUseThisTurn = true;
          updateAgentPlaceholder(outgoingText, `Agent: using ${toolName}…`);
        }
      });
      assertAgentNotCancelled();
      if (turn.stopReason) {
        progress.push(`Agent stop reason: ${turn.stopReason}`);
        appendAgentProgress(`Agent stop reason: ${turn.stopReason}`);
      }

      const assistantContent: Extract<AgentSessionMessage, { role: 'assistant' }>['content'] = [];
      const trimmedText = turn.text.trim();
      if (trimmedText) {
        assistantContent.push({ type: 'text', text: turn.text });
      }

      if (turn.toolUses.length === 0) {
        const userFacingText = extractUserFacingAgentText(trimmedText);
        const finalMessage = userFacingText && !looksLikeAgentInternalText(userFacingText) ? userFacingText : 'Done.';
        const finalContent = finalMessage;
        if (shouldForceBrowserFollowThrough(outgoingText, finalContent)) {
          const followThroughReminder = 'Opening the page is not sufficient for this task. Continue until you actually extract or answer the requested content, using OpenClaw delegation or another readable content path.';
          progress.push(`Agent note: ${followThroughReminder}`);
          appendAgentProgress(`Agent note: ${followThroughReminder}`);
          if (assistantContent.length) {
            agentMessages.push({ role: 'assistant', content: assistantContent });
          }
          agentMessages.push({
            role: 'user',
            content: [{ type: 'text', text: followThroughReminder }]
          });
          updateAgentPlaceholder(outgoingText, 'Agent: continuing after browser handoff…');
          continue;
        }
        agentRunActiveRef.current = false;
        captureNativeAgentInspectorSnapshot({
          startedAt: turnStartedAt,
          requestMode: 'structured',
          outgoingText,
          memoryContext: nativeMemoryContext,
          systemPrompt,
          payload: {
            kind: 'agent_session',
            providerId: settings.providerId,
            baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
            model: settings.model,
            system: systemPrompt,
            temperature: 0.1,
            maxTokens: 4096,
            messages: agentMessages
          },
          progressLines: progress,
          toolEvents,
          lastResponse: finalContent
        });
        await streamNativeAgentFinal(outgoingText, finalContent, { openClawUsage: lastOpenClawUsage });
        return;
      }

      if (trimmedText) {
        const note = `Agent note: ${trimmedText}`;
        progress.push(note);
        appendAgentProgress(note);
      }

      const toolResults: Extract<AgentSessionMessage, { role: 'user' }>['content'] = [];

      for (const toolUse of turn.toolUses) {
        assistantContent.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input });
        appendAgentProgress(`Agent tool_use ${toolUse.name}#${toolUse.id}`);

        const normalized = normalizeAgentActionCandidate({
          type: 'action',
          tool: toolUse.name,
          args: toolUse.input
        });

        const summary = normalized && normalized.type === 'action'
          ? `Agent tool: ${summarizeAgentAction(normalized)}`
          : `Agent tool: ${toolUse.name}`;

        toolEvents.push({
          id: `${toolUse.id}:request`,
          tool: toolUse.name,
          phase: 'request',
          summary,
          detail: JSON.stringify(toolUse.input, null, 2),
          occurredAt: Date.now()
        });

        progress.push(summary);
        appendAgentProgress(summary);
        updateAgentPlaceholder(outgoingText, `Agent: ${summary}`);

        let toolResult = `TOOL_RESULT ${toolUse.name}\nstatus: failed\nreason: invalid tool arguments`;
        let isError = true;
        latestOpenClawRawOutputRef.current = null;
        latestOpenClawUsageRef.current = null;

        if (normalized && normalized.type === 'action') {
          try {
            toolResult = await executeAgentTool(normalized);
            isError = false;
            if (normalized.tool === 'openclaw_agent' && latestOpenClawUsageRef.current) {
              lastOpenClawUsage = latestOpenClawUsageRef.current;
            }
          } catch (error) {
            toolResult = `TOOL_RESULT ${toolUse.name}\nstatus: failed\nreason: ${error instanceof Error ? error.message : 'tool execution failed'}`;
          }
        }

        assertAgentNotCancelled();

        const displayToolResult = toolResult.length > 1200 ? `${toolResult.slice(0, 1200)}\n...[truncated]` : toolResult;
        toolEvents.push({
          id: `${toolUse.id}:result`,
          tool: toolUse.name,
          phase: 'result',
          summary: `Result: ${toolUse.name}`,
          detail: displayToolResult,
          rawDetail: latestOpenClawRawOutputRef.current ?? toolResult,
          occurredAt: Date.now(),
          isError
        });
        progress.push(displayToolResult);
        appendAgentProgress(displayToolResult);
        appendAgentProgress(`Agent tool_result ${toolUse.name}#${toolUse.id} ${isError ? 'error' : 'ok'}`);
        updateAgentPlaceholder(outgoingText, 'Agent: planning next step…');

        toolResults.push({
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: toolResult,
          isError
        });
      }

      agentMessages.push({ role: 'assistant', content: assistantContent });
      agentMessages.push({ role: 'user', content: toolResults });
    }

    agentRunActiveRef.current = false;
    const stoppedContent = 'Agent stopped after reaching the step limit before producing a final response.';
    captureNativeAgentInspectorSnapshot({
      startedAt: turnStartedAt,
      requestMode: 'structured',
      outgoingText,
      memoryContext: nativeMemoryContext,
      systemPrompt,
      payload: {
        kind: 'agent_session',
        providerId: settings.providerId,
        baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
        model: settings.model,
        system: systemPrompt,
        temperature: 0.1,
        maxTokens: 4096,
        messages: agentMessages
      },
      progressLines: progress,
      toolEvents,
      lastResponse: stoppedContent
    });
    await streamNativeAgentFinal(outgoingText, stoppedContent, { openClawUsage: lastOpenClawUsage });
  }

  async function runLegacyClaudeCodeAgent(outgoingText: string) {
    agentRunActiveRef.current = true;
    agentCancelRequestedRef.current = false;
    agentProgressRef.current = [];
    setAgentTerminalText('');
    setAgentActiveCommand(null);
    setAgentRunStatus('planning');
    const transcriptBase: Msg[] = [...messages, { role: 'user', content: outgoingText }];
    const visiblePrefix: Msg[] = [...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: 'Agent: planning…' }];
    const agentMessages: Msg[] = [...transcriptBase];
    const nativeMemoryContext = [
      buildNativeAgentMemoryContext(memorySnapshot, outgoingText, workspaceSummary),
      buildOpenClawSkillsContext(discoveredSkills, outgoingText, workspaceSummary)
    ].filter(Boolean).join('\n\n');
    const turnStartedAt = Date.now();
    const progress: string[] = ['Agent: planning…'];
    const toolEvents: NativeAgentToolEvent[] = [];
    let lastOpenClawUsage: Msg['openClawUsage'] | undefined;
    agentProgressRef.current = [...progress];
    setAgentProgressLines([...progress]);

    setCurrentMessages(visiblePrefix);

    for (let step = 0; step < 8; step += 1) {
      assertAgentNotCancelled();
      const reqMessages = buildAgentMessages(agentMessages, nativeMemoryContext);
      captureNativeAgentInspectorSnapshot({
        startedAt: turnStartedAt,
        requestMode: 'legacy',
        outgoingText,
        memoryContext: nativeMemoryContext,
        systemPrompt: reqMessages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n---\n\n'),
        payload: {
          kind: 'chat',
          providerId: settings.providerId,
          baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
          model: settings.model,
          interactionMode: settings.interactionMode,
          temperature: 0.1,
          messages: reqMessages
        },
        progressLines: progress,
        toolEvents
      });
      const responseText = await requestModelText(reqMessages, {
        onToken: (text) => {
          updateAgentPlaceholder(outgoingText, text.trim() ? 'Agent: thinking…' : 'Agent: planning…');
        }
      });
      assertAgentNotCancelled();
      const action = parseAgentAction(responseText);

      if (!action) {
        const userFacingText = extractUserFacingAgentText(responseText.trim());
        const finalResponse = userFacingText && !looksLikeAgentInternalText(userFacingText)
          ? userFacingText
          : 'Done.';
        if (shouldForceBrowserFollowThrough(outgoingText, finalResponse)) {
          const followThroughReminder = 'Opening the page is not sufficient for this task. Continue until you actually extract or answer the requested content, using OpenClaw delegation or another readable content path.';
          progress.push(`Agent note: ${followThroughReminder}`);
          appendAgentProgress(`Agent note: ${followThroughReminder}`);
          agentMessages.push({ role: 'assistant', content: responseText });
          agentMessages.push({ role: 'user', content: followThroughReminder });
          updateAgentPlaceholder(outgoingText, 'Agent: continuing after browser handoff…');
          continue;
        }
        agentRunActiveRef.current = false;
        captureNativeAgentInspectorSnapshot({
          startedAt: turnStartedAt,
          requestMode: 'legacy',
          outgoingText,
          memoryContext: nativeMemoryContext,
          systemPrompt: reqMessages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n---\n\n'),
          payload: {
            kind: 'chat',
            providerId: settings.providerId,
            baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
            model: settings.model,
            interactionMode: settings.interactionMode,
            temperature: 0.1,
            messages: reqMessages
          },
          progressLines: progress,
          toolEvents,
          lastResponse: finalResponse
        });
        await streamNativeAgentFinal(outgoingText, finalResponse, { openClawUsage: lastOpenClawUsage });
        return;
      }

      if (action.type === 'final') {
        const finalContent = action.message.trim();
        if (shouldForceBrowserFollowThrough(outgoingText, finalContent)) {
          const followThroughReminder = 'Opening the page is not sufficient for this task. Continue until you actually extract or answer the requested content, using OpenClaw delegation or another readable content path.';
          progress.push(`Agent note: ${followThroughReminder}`);
          appendAgentProgress(`Agent note: ${followThroughReminder}`);
          agentMessages.push({ role: 'assistant', content: JSON.stringify(action) });
          agentMessages.push({ role: 'user', content: followThroughReminder });
          updateAgentPlaceholder(outgoingText, 'Agent: continuing after browser handoff…');
          continue;
        }
        agentRunActiveRef.current = false;
        captureNativeAgentInspectorSnapshot({
          startedAt: turnStartedAt,
          requestMode: 'legacy',
          outgoingText,
          memoryContext: nativeMemoryContext,
          systemPrompt: reqMessages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n---\n\n'),
          payload: {
            kind: 'chat',
            providerId: settings.providerId,
            baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
            model: settings.model,
            interactionMode: settings.interactionMode,
            temperature: 0.1,
            messages: reqMessages
          },
          progressLines: progress,
          toolEvents,
          lastResponse: finalContent || 'Done.'
        });
        await streamNativeAgentFinal(outgoingText, finalContent || 'Done.', { openClawUsage: lastOpenClawUsage });
        return;
      }

      const summary = `Agent tool: ${summarizeAgentAction(action)}`;
      toolEvents.push({
        id: `legacy-${step}:request`,
        tool: action.tool,
        phase: 'request',
        summary,
        detail: JSON.stringify(action.args, null, 2),
        occurredAt: Date.now()
      });
      progress.push(summary);
      appendAgentProgress(summary);
      updateAgentPlaceholder(outgoingText, `Agent: ${summary}`);

      latestOpenClawRawOutputRef.current = null;
      latestOpenClawUsageRef.current = null;
      const toolResult = await executeAgentTool(action);
      if (action.tool === 'openclaw_agent' && latestOpenClawUsageRef.current) {
        lastOpenClawUsage = latestOpenClawUsageRef.current;
      }

      assertAgentNotCancelled();

      const displayToolResult = toolResult.length > 1200 ? `${toolResult.slice(0, 1200)}\n...[truncated]` : toolResult;
      toolEvents.push({
        id: `legacy-${step}:result`,
        tool: action.tool,
        phase: 'result',
        summary: `Result: ${action.tool}`,
        detail: displayToolResult,
        rawDetail: latestOpenClawRawOutputRef.current ?? toolResult,
        occurredAt: Date.now(),
        isError: /status:\s*failed/i.test(toolResult)
      });
      progress.push(displayToolResult);
      appendAgentProgress(displayToolResult);
      updateAgentPlaceholder(outgoingText, 'Agent: planning next step…');

      agentMessages.push({ role: 'assistant', content: JSON.stringify(action) });
      agentMessages.push({ role: 'user', content: toolResult });
    }

    agentRunActiveRef.current = false;
    const stoppedContent = 'Agent stopped after reaching the step limit before producing a final response.';
    captureNativeAgentInspectorSnapshot({
      startedAt: turnStartedAt,
      requestMode: 'legacy',
      outgoingText,
      memoryContext: nativeMemoryContext,
      systemPrompt: buildAgentMessages(agentMessages, nativeMemoryContext).filter((item) => item.role === 'system').map((item) => item.content).join('\n\n---\n\n'),
      payload: {
        kind: 'chat',
        providerId: settings.providerId,
        baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
        model: settings.model,
        interactionMode: settings.interactionMode,
        temperature: 0.1,
        messages: buildAgentMessages(agentMessages, nativeMemoryContext)
      },
      progressLines: progress,
      toolEvents,
      lastResponse: stoppedContent
    });
    await streamNativeAgentFinal(outgoingText, stoppedContent, { openClawUsage: lastOpenClawUsage });
  }

  async function runClaudeCodeAgent(outgoingText: string) {
    try {
      await runStructuredClaudeCodeAgent(outgoingText);
    } catch (error) {
      if (!shouldFallbackToLegacyAgent(error)) {
        throw error;
      }

      appendAgentProgress('Structured tool calling unavailable, falling back to legacy JSON agent…');
      await runLegacyClaudeCodeAgent(outgoingText);
    }
  }

  async function onSend(customText?: string) {
    const outgoingText = (customText ?? input).trim();
    if (!outgoingText) return;
    if (!canSend && !customText) return;

    shouldStickToBottomRef.current = true;
    activeStreamRef.current?.close();
    if (!customText) {
      setInput('');
    }
    setIsStreaming(true);

    if (settings.interactionMode === 'claude_cli') {
      try {
        setClaudeCliHandoffNotice({
          kind: 'info',
          text: `Prompt sent to Claude CLI. Continue in Terminal below.${outgoingText ? ` Last prompt: ${previewText(outgoingText, 96)}` : ''}`
        });
        await onSendPromptToClaudeCli(outgoingText);
      } catch (error) {
        setClaudeCliHandoffNotice({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Failed to send prompt to Claude CLI'
        });
      } finally {
        setIsStreaming(false);
      }
      return;
    }

    if (settings.interactionMode === 'native_agent' && workspaceContext.workspaceRoot) {
      try {
        await runClaudeCodeAgent(outgoingText);
      } catch (error) {
        if (isAgentCancelledError(error)) {
          setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: 'Agent run cancelled.' }]);
        } else {
          setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: `Error: ${error instanceof Error ? error.message : 'Agent execution failed'}` }]);
        }
      } finally {
        resetAgentRunState();
        setIsStreaming(false);
      }
      return;
    }

    const nextMessages: Msg[] = [...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: '' }];
    setCurrentMessages(nextMessages);

    const reqMessages = buildChatMessages(nextMessages);
    const req: ChatRequest = {
      providerId: settings.providerId,
      baseUrl: settings.baseUrl.trim() ? settings.baseUrl : undefined,
      apiKey: settings.apiKey,
      model: settings.model,
      interactionMode: settings.interactionMode,
      messages: reqMessages,
      temperature: settings.interactionMode === 'native_agent' ? 0.1 : 0.2
    };

    const stream = openChatStream(req);
    activeStreamRef.current = stream;
    const off = stream.onEvent((ev) => {
      if (ev.kind !== 'chat') return;
      if (ev.type === 'token') {
        setCurrentMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          copy[copy.length - 1] = { ...last, content: last.content + ev.text };
          return copy;
        });
      } else if (ev.type === 'error') {
        setCurrentMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            copy[copy.length - 1] = { role: 'assistant', content: `Error: ${ev.message}` };
            return copy;
          }
          return [...prev, { role: 'assistant', content: `Error: ${ev.message}` }];
        });
        off();
        stream.close();
        if (activeStreamRef.current === stream) {
          activeStreamRef.current = null;
        }
        setIsStreaming(false);
      } else if (ev.type === 'done') {
        off();
        stream.close();
        if (activeStreamRef.current === stream) {
          activeStreamRef.current = null;
        }
        setIsStreaming(false);
      }
    });

    stream.onError((message) => {
      setCurrentMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant' && !last.content) {
          copy[copy.length - 1] = { role: 'assistant', content: `Error: ${message}` };
          return copy;
        }
        return [...prev, { role: 'assistant', content: `Error: ${message}` }];
      });
    });

    stream.onClose(() => {
      if (activeStreamRef.current === stream) {
        activeStreamRef.current = null;
      }
      setIsStreaming(false);
    });
  }

  function resetCurrentThread() {
    rejectPendingAgentQuestion('Agent run cancelled');
    dropPendingThreadPersist(activeProfileId);
    setCurrentMessages([]);
    localStorage.removeItem(storageKey(activeProfileId));
    localStorage.removeItem(historyMetaKey(activeProfileId));
    resetAgentRunState();
  }

  const showAgentPlanningPanel = settings.interactionMode === 'native_agent' && isStreaming;
  const showAgentActivityDock = showAgentPlanningPanel;
  const agentStatusLabel = agentRunStatus === 'running_command'
      ? 'Running terminal command'
      : agentRunStatus === 'awaiting_input'
        ? 'Waiting for input'
      : agentRunStatus === 'cancelling'
        ? 'Cancelling'
        : 'Planning';
  const liveActivityLines = useMemo(() => agentProgressLines.slice(-4).map(formatAgentActivityLine), [agentProgressLines]);
  const readableTerminalSnippet = useMemo(() => {
    return buildReadableTerminalSnippet(agentTerminalText);
  }, [agentTerminalText]);
  const agentDebugLog = useMemo(() => agentProgressLines.slice(-14).join('\n'), [agentProgressLines]);
  const cliRuntimeEvents = useMemo(() => {
    if (cliMinimalMode) {
      return [];
    }
    const source = showClaudeCliDetails
      ? cliRuntimeState.events
      : cliRuntimeState.events.filter((event) => event.kind !== 'tool' && event.kind !== 'status');
    return source.slice(showClaudeCliDetails ? -8 : -4);
  }, [cliMinimalMode, cliRuntimeState.events, showClaudeCliDetails]);
  const cliRuntimeRawTail = useMemo(() => buildReadableTerminalSnippet(cliRuntimeState.rawTail), [cliRuntimeState.rawTail]);
  const runtimeSkillHints = useMemo(() => extractRuntimeSkillHints(cliRuntimeState.debugLogTail), [cliRuntimeState.debugLogTail]);
  const discoveredSkills = useMemo(() => {
    const merged = [...workspaceSkills, ...openClawSkills, ...runtimeSkillHints];
    const map = new Map<string, RuntimeSkillItem>();
    for (const item of merged) {
      map.set(item.key, item);
    }
    return [...map.values()];
  }, [openClawSkills, runtimeSkillHints, workspaceSkills]);
  const isAnySkillsLoading = skillsLoading || openClawSkillsLoading;
  const combinedSkillsError = skillsError || openClawSkillsError;
  const restoredAtText = useMemo(() => (
    cliRuntimeState.resumeInfo.restoredAt ? new Date(cliRuntimeState.resumeInfo.restoredAt).toLocaleString() : null
  ), [cliRuntimeState.resumeInfo.restoredAt]);
  const snapshotSavedAtText = useMemo(() => (
    cliRuntimeState.resumeInfo.snapshotSavedAt ? new Date(cliRuntimeState.resumeInfo.snapshotSavedAt).toLocaleString() : null
  ), [cliRuntimeState.resumeInfo.snapshotSavedAt]);
  const sessionHistoryItems = useMemo(() => {
    return profiles
      .map((profile) => {
        const summary = threadSummaryByProfile[profile.id];
        if (!summary || summary.messageCount === 0) return null;
        const updatedAt = threadUpdatedAtByProfile[profile.id] ?? 0;

        return {
          profileId: profile.id,
          profileName: profile.name,
          updatedAt,
          messageCount: summary.messageCount,
          lastUserText: summary.lastUserText,
          lastAssistantText: summary.lastAssistantText
        } as SessionHistoryItem;
      })
      .filter((item): item is SessionHistoryItem => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [profiles, threadSummaryByProfile, threadUpdatedAtByProfile]);
  const filteredSessionHistoryItems = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    if (!query) return sessionHistoryItems;
    return sessionHistoryItems.filter((item) => {
      return item.profileName.toLowerCase().includes(query)
        || item.lastUserText.toLowerCase().includes(query)
        || item.lastAssistantText.toLowerCase().includes(query);
    });
  }, [historyQuery, sessionHistoryItems]);
  const canOpenInspector = isClaudeCliMode || isNativeAgentMode;
  const memoryInstructionGroups = useMemo<AgentMemoryGroup[]>(() => {
    const snapshot = memorySnapshot;
    if (!snapshot) return [];

    return [
      {
        key: 'project',
        title: 'Project Instructions',
        items: snapshot.instructionFiles.filter((item) => item.scope === 'project'),
        emptyText: 'No project-scoped CLAUDE files or rules found.'
      },
      {
        key: 'user',
        title: 'User Instructions',
        items: snapshot.instructionFiles.filter((item) => item.scope === 'user'),
        emptyText: 'No user-scoped CLAUDE files or rules found.'
      }
    ];
  }, [memorySnapshot]);
  const recentMemoryTimeline = useMemo<InspectorTimelineItem[]>(() => {
    if (!memorySnapshot) return [];
    return [...memorySnapshot.instructionFiles, ...memorySnapshot.autoMemoryFiles]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        label: item.relativePath,
        meta: `${item.scope} · ${item.kind}`,
        updatedAt: item.updatedAt
      }));
  }, [memorySnapshot]);
  const runtimeContextSummaryLines = useMemo(() => {
    const lines = [
      `Workspace: ${cliRuntimeState.workspaceRoot ?? workspaceContext.workspaceRoot ?? 'Not selected'}`,
      `Runtime: ${cliRuntimeState.connected ? (cliRuntimeState.running ? 'Connected and running' : 'Connected and idle') : 'No active Claude CLI session'}`,
      `Memory: ${memorySnapshot ? `${memorySnapshot.instructionFiles.length} instruction files, ${memorySnapshot.autoMemoryFiles.length} auto memory files, auto memory ${memorySnapshot.autoMemoryEnabled ? 'enabled' : 'disabled'}` : 'Memory snapshot unavailable'}`,
      `Skills: ${discoveredSkills.length ? discoveredSkills.slice(0, 4).map((item) => item.name).join(', ') : 'No skills discovered yet'}`
    ];

    if (cliRuntimeState.pendingApproval) {
      lines.push(`Approval pending: ${cliRuntimeState.pendingApproval}`);
    } else if (cliRuntimeState.pendingQuestion) {
      lines.push(`Question pending: ${cliRuntimeState.pendingQuestion}`);
    } else if (cliRuntimeState.lastPlan.length) {
      lines.push(`Latest plan: ${cliRuntimeState.lastPlan.slice(0, 2).join(' | ')}`);
    }

    if (cliRuntimeState.resumeInfo.restoredFromStorage) {
      lines.push(`Resume state restored${snapshotSavedAtText ? ` from snapshot saved at ${snapshotSavedAtText}` : ''}`);
    }

    return lines;
  }, [cliRuntimeState.connected, cliRuntimeState.lastPlan, cliRuntimeState.pendingApproval, cliRuntimeState.pendingQuestion, cliRuntimeState.resumeInfo.restoredFromStorage, cliRuntimeState.running, cliRuntimeState.workspaceRoot, discoveredSkills, memorySnapshot, snapshotSavedAtText, workspaceContext.workspaceRoot]);
  const nativeAgentSnapshotUpdatedAtText = useMemo(() => {
    return nativeAgentInspectorSnapshot ? formatTimestamp(nativeAgentInspectorSnapshot.updatedAt) : null;
  }, [nativeAgentInspectorSnapshot]);
  const nativeAgentExecutionTrace = useMemo(() => buildExecutionTrace(nativeAgentInspectorSnapshot), [nativeAgentInspectorSnapshot]);
  const nativeAgentContextSummaryLines = useMemo(() => {
    const lines = [
      `Workspace: ${workspaceContext.workspaceRoot ?? 'Not selected'}`,
      `Session: ${isStreaming ? 'Running' : 'Idle'}`,
      `Provider: ${providerLabelFor(settings.providerId)} · ${settings.model}`,
      `Memory: ${memorySnapshot ? `${memorySnapshot.instructionFiles.length} instruction files, ${memorySnapshot.autoMemoryFiles.length} auto memory files` : 'Workspace memory unavailable'}`
    ];

    if (nativeAgentInspectorSnapshot) {
      lines.push(`Latest request: ${nativeAgentInspectorSnapshot.requestMode} · ${nativeAgentSnapshotUpdatedAtText ?? 'just now'}`);
      lines.push(`Prompt: ${previewText(nativeAgentInspectorSnapshot.outgoingText, 140)}`);
    }

    if (agentProgressLines.length) {
      lines.push(`Live progress: ${agentProgressLines[agentProgressLines.length - 1]}`);
    }

    return lines;
  }, [agentProgressLines, discoveredSkills, isStreaming, memorySnapshot, nativeAgentInspectorSnapshot, nativeAgentSnapshotUpdatedAtText, settings.model, settings.providerId, workspaceContext.workspaceRoot]);
  const inspectorTitle = isNativeAgentMode ? 'Native Agent Inspector' : 'Claude Inspector';
  const inspectorSubtitle = isNativeAgentMode
    ? 'Inspect Native Agent memory, assembled model inputs, and recent run activity.'
    : 'Unified runtime, memory, and skills view for the current Claude CLI workspace.';
  const cliRuntimeLabel = cliRuntimeState.connected
    ? cliRuntimeState.running
      ? 'Claude CLI is running in Terminal'
      : 'Claude CLI session is ready in Terminal'
    : 'Claude CLI session not connected';
  const cliWorkspaceLabel = cliRuntimeState.workspaceRoot ?? workspaceContext.workspaceRoot ?? 'No workspace selected';
  const cliSignalItems = [
    cliRuntimeState.pendingApproval ? `Approval needed: ${cliRuntimeState.pendingApproval}` : null,
    cliRuntimeState.pendingQuestion ? `Question pending: ${cliRuntimeState.pendingQuestion}` : null,
    cliRuntimeState.lastPlan.length ? `Latest plan: ${cliRuntimeState.lastPlan.slice(0, 2).join(' · ')}` : null,
    cliRuntimeState.diffDetected ? 'Recent terminal output included diff markers.' : null
  ].filter((item): item is string => Boolean(item));
  const openClawGatewayUrl = openClawGatewayStatus?.rpc?.url ?? openClawGatewayStatus?.gateway?.probeUrl ?? null;
  const openClawDashboardLabel = useMemo(() => {
    if (!openClawDashboardUrl) return null;
    return openClawDashboardUrl.replace(/#token=.*$/i, '#token=…');
  }, [openClawDashboardUrl]);
  const openClawAuditIssues = openClawGatewayStatus?.service?.configAudit?.issues ?? [];
  const openClawSessionCount = openClawGatewayHealth?.sessions?.count ?? 0;
  const openClawAgentCount = openClawGatewayHealth?.agents?.length ?? 0;

  async function previewInspectorFile(item: InspectorMemoryFile) {
    const workspaceRoot = cliRuntimeState.workspaceRoot || workspaceContext.workspaceRoot || null;
    setSelectedInspectorFile(item);
    setSelectedInspectorFileLoading(true);
    setSelectedInspectorFileError(null);
    try {
      const contents = await fsClient.readAgentMemoryFile(item.path, workspaceRoot);
      setSelectedInspectorFileContent(contents);
      setSelectedInspectorFileLoading(false);
    } catch (error) {
      setSelectedInspectorFileContent('');
      setSelectedInspectorFileLoading(false);
      setSelectedInspectorFileError(error instanceof Error ? error.message : 'Unable to read file');
    }
  }

  async function revealInspectorFile(item: InspectorMemoryFile) {
    const workspaceRoot = cliRuntimeState.workspaceRoot || workspaceContext.workspaceRoot || null;
    await fsClient.revealAgentPath(item.path, workspaceRoot);
  }

  async function openInspectorSource(item: InspectorMemoryFile) {
    const opened = await workspacePanelRef.current?.openWorkspaceFile(item.path, { reveal: true });
    if (opened) {
      closeInspectorDrawer();
      return;
    }
    await previewInspectorFile(item);
  }

  async function previewInspectorSkill(skill: RuntimeSkillItem) {
    setSelectedInspectorSkill(skill);
    setSelectedInspectorSkillError(null);
    if (skill.source === 'openclaw' && skill.openClawSkillName) {
      setSelectedInspectorSkillLoading(true);
      try {
        const result = await fsClient.runWorkspaceCommand(`openclaw skills info ${quoteShellArg(skill.openClawSkillName)} --json`, 20000);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || 'Unable to read OpenClaw skill info');
        }
        const info = JSON.parse(result.stdout) as OpenClawSkillInfo;
        setSelectedInspectorSkillContent(formatOpenClawSkillInfo(info));
        setSelectedInspectorSkillLoading(false);
      } catch (error) {
        setSelectedInspectorSkillContent(skill.preview ?? skill.meta ?? skill.name);
        setSelectedInspectorSkillLoading(false);
        setSelectedInspectorSkillError(error instanceof Error ? error.message : 'Unable to read OpenClaw skill');
      }
      return;
    }
    if (!skill.path) {
      setSelectedInspectorSkillLoading(false);
      setSelectedInspectorSkillContent(skill.preview ?? (skill.meta ? `${skill.name}\n\n${skill.meta}` : skill.name));
      return;
    }

    setSelectedInspectorSkillLoading(true);
    try {
      const contents = await fsClient.readWorkspaceTextFile(skill.path);
      setSelectedInspectorSkillContent(contents);
      setSelectedInspectorSkillLoading(false);
    } catch (error) {
      setSelectedInspectorSkillContent('');
      setSelectedInspectorSkillLoading(false);
      setSelectedInspectorSkillError(error instanceof Error ? error.message : 'Unable to read skill file');
    }
  }

  async function openInspectorSkillSource(skill: RuntimeSkillItem) {
    if (!skill.path) {
      await previewInspectorSkill(skill);
      return;
    }
    const opened = await workspacePanelRef.current?.openWorkspaceFile(skill.path, { reveal: true });
    if (opened) {
      closeInspectorDrawer();
      return;
    }
    await previewInspectorSkill(skill);
  }

  async function revealInspectorSkillSource(skill: RuntimeSkillItem) {
    if (!skill.path) return;
    const revealed = await workspacePanelRef.current?.revealWorkspaceFile(skill.path);
    if (revealed) return;
    await fsClient.revealAgentPath(skill.path, cliRuntimeState.workspaceRoot || workspaceContext.workspaceRoot || null);
  }

  const refreshOpenClawGateway = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    const hasCachedSnapshot = Boolean(openClawGatewayStatus || openClawGatewayHealth || openClawDashboardUrl);
    if (!silent || !hasCachedSnapshot) {
      setOpenClawGatewayLoading(true);
    }
    setOpenClawGatewayError(null);

    try {
      const installState = await workspacePanelRef.current?.refreshOpenClawInstallState() ?? null;
      setOpenClawInstallSnapshot(installState);

      const [statusResult, healthResult, dashboardResult] = await Promise.all([
        fsClient.runWorkspaceCommand(OPENCLAW_GATEWAY_STATUS_COMMAND, 15000),
        fsClient.runWorkspaceCommand(OPENCLAW_GATEWAY_HEALTH_COMMAND, 15000),
        fsClient.runWorkspaceCommand(OPENCLAW_DASHBOARD_URL_COMMAND, 15000)
      ]);

      if (statusResult.exitCode !== 0) {
        throw new Error(statusResult.stderr.trim() || 'Unable to read OpenClaw gateway status');
      }
      if (healthResult.exitCode !== 0) {
        throw new Error(healthResult.stderr.trim() || 'Unable to read OpenClaw gateway health');
      }
      if (dashboardResult.exitCode !== 0) {
        throw new Error(dashboardResult.stderr.trim() || 'Unable to read OpenClaw dashboard URL');
      }

      setOpenClawGatewayStatus(JSON.parse(statusResult.stdout) as OpenClawGatewayStatusSnapshot);
      setOpenClawGatewayHealth(JSON.parse(healthResult.stdout) as OpenClawGatewayHealthSnapshot);
      setOpenClawDashboardUrl(extractOpenClawDashboardUrl(dashboardResult.stdout));
    } catch (error) {
      setOpenClawGatewayError(error instanceof Error ? error.message : 'Unable to refresh OpenClaw gateway');
    } finally {
      if (!silent || !hasCachedSnapshot) {
        setOpenClawGatewayLoading(false);
      }
    }
  }, [openClawDashboardUrl, openClawGatewayHealth, openClawGatewayStatus]);

  function openOpenClawDrawer() {
    setHistoryDrawerOpen(false);
    setInspectorDrawerOpen(false);
    if (isDrawerOpen) {
      onToggleDrawer();
    }
    setOpenClawDrawerOpen(true);
    void refreshOpenClawGateway({ silent: true });
  }

  function closeOpenClawDrawer() {
    setOpenClawDrawerOpen(false);
  }

  async function handleOpenClawUpdate() {
    setOpenClawActionBusy('update');
    setOpenClawActionNotice('Starting background OpenClaw CLI update. This panel will refresh after the installer finishes.');
    try {
      await workspacePanelRef.current?.installOpenClawCli();
    } finally {
      setOpenClawActionBusy(null);
    }
  }

  async function handleOpenClawOnboarding() {
    setOpenClawActionBusy('onboarding');
    setOpenClawActionNotice('Launching OpenClaw onboarding in the terminal. Return here after it finishes.');
    try {
      await workspacePanelRef.current?.startOpenClawOnboarding();
    } finally {
      setOpenClawActionBusy(null);
    }
  }

  async function handleOpenClawRefresh() {
    setOpenClawActionBusy('refresh');
    try {
      await refreshOpenClawGateway();
      setOpenClawActionNotice('OpenClaw gateway status refreshed.');
    } finally {
      setOpenClawActionBusy(null);
    }
  }

  useEffect(() => {
    if (!openProjectRequestKey) return;
    if (handledOpenProjectRequestRef.current === openProjectRequestKey) return;
    handledOpenProjectRequestRef.current = openProjectRequestKey;

    void workspacePanelRef.current?.openProjectPicker();
  }, [openProjectRequestKey]);

  useEffect(() => {
    let cancelled = false;

    void fsClient.getOpenClawInstallerState().then((nextState) => {
      if (cancelled) return;
      openClawInstallerStatusRef.current = nextState.status;
      setOpenClawInstallerState(nextState);
    }).catch(() => {});

    const unsubscribe = fsClient.onOpenClawInstallerEvent((nextState) => {
      const previousStatus = openClawInstallerStatusRef.current;
      openClawInstallerStatusRef.current = nextState.status;
      setOpenClawInstallerState(nextState);

      if (previousStatus === 'running' && nextState.status === 'success') {
        void (async () => {
          const installState = await workspacePanelRef.current?.refreshOpenClawInstallState() ?? null;
          setOpenClawInstallSnapshot(installState);
          openOpenClawDrawer();
        })();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isDrawerOpen, onToggleDrawer, refreshOpenClawGateway]);

  useEffect(() => {
    if (!openClawInstallRequestKey) return;
    if (handledOpenClawRequestRef.current === openClawInstallRequestKey) return;
    handledOpenClawRequestRef.current = openClawInstallRequestKey;

    void (async () => {
      setOpenClawActionNotice(null);
      if (workspaceContext.openClaw.installed || openClawInstallSnapshot?.openclawVersion) {
        openOpenClawDrawer();
        return;
      }
      const installState = await workspacePanelRef.current?.refreshOpenClawInstallState() ?? null;
      setOpenClawInstallSnapshot(installState);
      if (installState?.openclawVersion) {
        openOpenClawDrawer();
        return;
      }
      setOpenClawDrawerOpen(false);
      await workspacePanelRef.current?.openOpenClawSetup();
    })();
  }, [openClawInstallRequestKey, openClawInstallSnapshot?.openclawVersion, refreshOpenClawGateway, workspaceContext.openClaw.installed]);

  useEffect(() => {
    if (!openClawSetupRequestKey) return;
    if (handledOpenClawSetupRequestRef.current === openClawSetupRequestKey) return;
    handledOpenClawSetupRequestRef.current = openClawSetupRequestKey;

    setOpenClawDrawerOpen(false);
    void workspacePanelRef.current?.openOpenClawSetup();
  }, [openClawSetupRequestKey]);

  useEffect(() => {
    if (!openClawCloseRequestKey) return;
    setOpenClawDrawerOpen(false);
  }, [openClawCloseRequestKey]);

  function renderInspectorMemoryItem(item: InspectorMemoryFile) {
    return (
      <div key={item.id} className="agentMemoryItem">
        <button type="button" className="agentMemoryItemBody" onClick={() => void previewInspectorFile(item)}>
          <div className="agentMemoryItemTop">
            <span className={`agentMemoryBadge scope-${item.scope}`}>{item.scope}</span>
            <span className={`agentMemoryBadge kind-${item.kind}`}>{item.kind}</span>
          </div>
          <div className="agentMemoryItemTitle">{item.relativePath}</div>
          <div className="agentMemoryMeta">{item.displayPath}</div>
          <div className="agentMemoryMeta">{item.lineCount} lines · updated {formatTimestamp(item.updatedAt)}</div>
          {item.preview ? <pre className="agentMemoryPreview">{item.preview}</pre> : <div className="agentMemoryMeta">Empty file</div>}
        </button>
        <div className="agentMemoryItemActions">
          <button type="button" className="agentMemoryActionButton" onClick={() => void previewInspectorFile(item)}>View</button>
          <button type="button" className="agentMemoryActionButton" onClick={() => void openInspectorSource(item)}>
            {isPathInside(workspaceContext.workspaceRoot, item.path) ? 'Open' : 'Preview'}
          </button>
          <button type="button" className="agentMemoryActionButton" onClick={() => void revealInspectorFile(item)}>Reveal</button>
        </div>
      </div>
    );
  }

  function openHistoryDrawer() {
    setOpenClawDrawerOpen(false);
    setInspectorDrawerOpen(false);
    setHistoryDrawerOpen(true);
  }

  function closeHistoryDrawer() {
    setHistoryDrawerOpen(false);
  }

  function openInspectorDrawer(section: InspectorSection = 'overview') {
    setOpenClawDrawerOpen(false);
    setHistoryDrawerOpen(false);
    setInspectorSection(section);
    setInspectorDrawerOpen(true);
  }

  function closeInspectorDrawer() {
    setInspectorDrawerOpen(false);
  }

  function selectHistorySession(profileId: string) {
    handleProfileSelection(profileId);
    closeHistoryDrawer();
  }

  function toggleHistoryDrawer() {
    if (historyDrawerOpen) {
      closeHistoryDrawer();
      return;
    }
    openHistoryDrawer();
  }

  function toggleInspectorDrawer(section: InspectorSection = 'overview') {
    if (!canOpenInspector) return;
    if (inspectorDrawerOpen && inspectorSection === section) {
      closeInspectorDrawer();
      return;
    }
    openInspectorDrawer(section);
  }

  const workspacePanel = (
    <WorkspacePanel
      ref={workspacePanelRef}
      settings={settings}
      onContextChange={setWorkspaceContext}
      onOpenGitPage={onOpenGitPage}
      onRunCommandInTerminal={onRunCommandInTerminal}
      onSendCommandToTerminal={onSendCommandToTerminal}
    />
  );

  const assistantVisible = isDrawerOpen;
  const chatDrawerClassName = suppressDrawerTransition
    ? (assistantVisible ? `chatDrawer open noTransition${immersiveChatOpen ? ' immersiveOpen' : ''}${isDrawerResizing ? ' resizing' : ''}` : 'chatDrawer noTransition')
    : (assistantVisible ? `chatDrawer open${immersiveChatOpen ? ' immersiveOpen' : ''}${isDrawerResizing ? ' resizing' : ''}` : 'chatDrawer');
  const assistantCard = (
    <div className={immersiveChatOpen ? 'chatCard immersiveChatCard' : 'chatCard'}>
      <div className="chatHeader">
              <div className="chatHeaderTitleRow">
                <div className="cardTitle">Inspiration</div>
                <div className={`chatStatus ${currentConnectionState?.status ?? 'checking'}`} title={currentConnectionState?.message ?? connectionHint}>
                  <span className="chatStatusDot" />
                  <span>{currentConnectionState ? currentConnectionState.status === 'ok' ? 'Connected' : currentConnectionState.status === 'error' ? 'Issue' : 'Checking' : 'Checking'}</span>
                </div>
              </div>
                <div className="chatHeaderActions">
                <div className="chatHeaderControls">
                  <select value={activeProfileId} onChange={(e) => handleProfileSelection(e.target.value)} className="chatProfileSelect">
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} · {modeLabelFor(profile.interactionMode)} · {providerLabelFor(profile.providerId)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="chatHeaderActionButtons">
                  <button
                    type="button"
                    className={immersiveChatOpen ? 'secondaryButton is-active' : 'secondaryButton'}
                    onClick={() => setImmersiveChatOpen((value) => !value)}
                    aria-pressed={immersiveChatOpen}
                    title={immersiveChatOpen ? 'Exit immersive chat' : 'Enter immersive chat'}
                  >
                    {immersiveChatOpen ? 'Exit Immerse' : 'Immerse'}
                  </button>
                  <button type="button" onClick={resetCurrentThread} disabled={isStreaming || messages.length === 0}>Reset Session</button>
                </div>
              </div>
            </div>

            {currentConnectionState?.status === 'error' ? (
              <div className="chatHeaderNotice error">{currentConnectionState.message}</div>
            ) : null}

            {profileSwitchNotice ? (
              <div className="chatHeaderNotice info">{profileSwitchNotice}</div>
            ) : null}

            <div className="chatProfileMeta" title={connectionHint}>
              <div className="chatProfileMetaTitle">Current profile: {currentProfileSummary}</div>
              <div className="chatProfileMetaDetail">{currentProfileDetail}</div>
            </div>

            <div
              ref={messagesRef}
              className="messages"
              onScroll={(e) => {
                const el = e.currentTarget;
                const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                shouldStickToBottomRef.current = distanceFromBottom < 24;
              }}
            >
              {isClaudeCliMode ? (
                <div className="localCliHandoffPanel">
                  <div className="localCliHandoffHeader">
                    <div>
                      <div className="localCliHandoffTitle">Claude CLI runs in Terminal</div>
                      <div className="localCliHandoffMeta">{cliRuntimeLabel}</div>
                    </div>
                    <div className="localCliHandoffActions">
                      <button type="button" className="secondaryButton" onClick={() => void onFocusClaudeCliTerminal()}>
                        Focus Terminal
                      </button>
                      <button type="button" className="secondaryButton" onClick={() => void onInterruptClaudeCli()} disabled={!cliRuntimeState.running}>
                        Interrupt
                      </button>
                    </div>
                  </div>
                  <div className="localCliHandoffHint">
                    Send prompts here, then continue the real interaction in the Terminal panel. Chat mirroring is disabled in Claude CLI mode.
                  </div>
                  <div className="localCliHandoffGrid">
                    <div className="localCliHandoffCard">
                      <div className="localCliHandoffLabel">Workspace</div>
                      <div className="localCliHandoffValue">{cliWorkspaceLabel}</div>
                    </div>
                    <div className="localCliHandoffCard">
                      <div className="localCliHandoffLabel">Runtime</div>
                      <div className="localCliHandoffValue">{cliRuntimeState.sessionId ? `Session #${cliRuntimeState.sessionId}` : 'Waiting for Claude CLI session'}</div>
                    </div>
                  </div>
                  {cliHandoffNotice ? (
                    <div className={`chatHeaderNotice ${cliHandoffNotice.kind === 'error' ? 'error' : 'info'}`}>{cliHandoffNotice.text}</div>
                  ) : null}
                  {cliSignalItems.length ? (
                    <div className="localCliSignalList">
                      {cliSignalItems.map((item) => (
                        <div key={item} className="localCliSignalItem">{item}</div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty">Send a prompt to start or continue Claude CLI, then keep working in Terminal.</div>
                  )}
                </div>
              ) : messages.length === 0 ? (
                <div className="empty">{settings.interactionMode === 'native_agent' ? 'Start a persistent native-agent session. This profile keeps its own running conversation.' : 'Send a message to start.'}</div>
              ) : (
                <div>
                  {settings.interactionMode === 'native_agent' ? (
                    <div className="chatInlineActions">
                      <button type="button" onClick={() => void onSend('Continue from the current workspace state and take the next most useful step.')} disabled={isStreaming}>
                        Continue
                      </button>
                    </div>
                  ) : null}

                  <MessageList messages={messages} />
                </div>
              )}
            </div>

            {showAgentActivityDock ? (
              <div className="chatActivityDock">
                {showAgentPlanningPanel ? (
                  <div className="agentLivePanel">
                    <div className="agentLiveHeader">
                      <div className="agentLiveStatus">
                        <span className={`agentLiveDot status-${agentRunStatus}`} />
                        <span className="agentLiveLabel">{formatAgentActivityLine(agentActiveCommand ? `Running in terminal: ${agentActiveCommand}` : `Agent: ${agentStatusLabel}`)}</span>
                      </div>
                      <button type="button" className="agentLiveInterrupt" onClick={() => void cancelActiveAgentRun()} disabled={agentRunStatus === 'cancelling'}>
                        {agentRunStatus === 'cancelling' ? 'Cancelling…' : 'Interrupt'}
                      </button>
                    </div>
                    <div className="agentLiveFeed">
                      {liveActivityLines.length ? liveActivityLines.map((line, index) => (
                        <div key={`${index}-${line.slice(0, 24)}`} className="agentLiveItem">{line}</div>
                      )) : <div className="agentLiveItem muted">正在准备执行…</div>}
                      {readableTerminalSnippet ? <pre className="agentLiveTerminal">{readableTerminalSnippet}</pre> : null}
                      {agentDebugLog ? <pre className="agentLiveDebug">{agentDebugLog}</pre> : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <aside className="assistantSideBar" aria-label="Inspiration tools">
              <button
                type="button"
                className={`assistantSideBarItem ${historyDrawerOpen ? 'active' : ''}`}
                onClick={toggleHistoryDrawer}
                title={historyDrawerOpen ? 'Hide history' : 'Show history'}
                aria-label={historyDrawerOpen ? 'Hide history' : 'Show history'}
              >
                <svg className="assistantSideBarGlyph" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 7v5l3 2" />
                  <path d="M3 12a9 9 0 1 0 3-6.708" />
                  <path d="M3 4v3h3" />
                </svg>
              </button>
              <button
                type="button"
                className={`assistantSideBarItem ${inspectorDrawerOpen ? 'active' : ''}`}
                onClick={() => toggleInspectorDrawer('overview')}
                disabled={!canOpenInspector}
                title={canOpenInspector ? (inspectorDrawerOpen ? `Hide ${inspectorTitle}` : `Show ${inspectorTitle}`) : 'Inspector unavailable in current mode'}
                aria-label={canOpenInspector ? (inspectorDrawerOpen ? `Hide ${inspectorTitle}` : `Show ${inspectorTitle}`) : 'Inspector unavailable in current mode'}
              >
                <svg className="assistantSideBarGlyph" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6.5h12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 16V8A1.5 1.5 0 0 1 6 6.5Z" />
                  <path d="M8 10h8" />
                  <path d="M8 13h5" />
                  <path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z" />
                </svg>
              </button>
            </aside>

            {isNativeAgentMode ? (
              <>
                <button
                  type="button"
                  className={inspectorDrawerOpen ? 'inspectorDrawerBackdrop open' : 'inspectorDrawerBackdrop'}
                  aria-label="Close Native Agent inspector panel"
                  onClick={closeInspectorDrawer}
                />
                <aside className={inspectorDrawerOpen ? 'inspectorDrawerPanel open' : 'inspectorDrawerPanel'}>
                  <div className="agentInspectorPanel">
                    <div className="agentInspectorHeader">
                      <div>
                        <div className="cardTitle">{inspectorTitle}</div>
                        <div className="agentMemoryMeta">{inspectorSubtitle}</div>
                      </div>
                      <div className="agentInspectorActions">
                        <button
                          type="button"
                          onClick={() => {
                            setMemoryRefreshTick((value) => value + 1);
                          }}
                          disabled={memoryLoading}
                        >
                          {memoryLoading ? 'Refreshing…' : 'Refresh'}
                        </button>
                        <button type="button" onClick={closeInspectorDrawer}>Close</button>
                      </div>
                    </div>

                    <div className="agentInspectorTabs" role="tablist" aria-label="Native Agent inspector sections">
                      <button type="button" className={inspectorSection === 'overview' ? 'agentInspectorTab active' : 'agentInspectorTab'} onClick={() => setInspectorSection('overview')}>
                        Overview
                      </button>
                      <button type="button" className={inspectorSection === 'memory' ? 'agentInspectorTab active' : 'agentInspectorTab'} onClick={() => setInspectorSection('memory')}>
                        Memory
                      </button>
                      <button type="button" className={inspectorSection === 'model-input' ? 'agentInspectorTab active' : 'agentInspectorTab'} onClick={() => setInspectorSection('model-input')}>
                        Model Input
                      </button>
                      <button type="button" className={inspectorSection === 'tooling' ? 'agentInspectorTab active' : 'agentInspectorTab'} onClick={() => setInspectorSection('tooling')}>
                        Tooling
                      </button>
                    </div>

                    {inspectorSection === 'overview' ? (
                      <div className="agentInspectorBody">
                        <div className="agentInspectorSummaryGrid">
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Session</span>
                            <span className="agentMemorySummaryValue">{isStreaming ? 'Running' : 'Idle'}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Request Mode</span>
                            <span className="agentMemorySummaryValue">{nativeAgentInspectorSnapshot?.requestMode ?? 'Not run yet'}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Instruction files</span>
                            <span className="agentMemorySummaryValue">{memorySnapshot?.instructionFiles.length ?? 0}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Auto memory files</span>
                            <span className="agentMemorySummaryValue">{memorySnapshot?.autoMemoryFiles.length ?? 0}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Progress lines</span>
                            <span className="agentMemorySummaryValue">{(nativeAgentInspectorSnapshot?.progressLines.length ?? agentProgressLines.length) || 0}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Tool events</span>
                            <span className="agentMemorySummaryValue">{nativeAgentInspectorSnapshot?.toolEvents.length ?? 0}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Last updated</span>
                            <span className="agentMemorySummaryValue">{nativeAgentSnapshotUpdatedAtText ?? 'Not available'}</span>
                          </div>
                        </div>

                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Current Context Summary</div>
                          <div className="agentInspectorSummaryList">
                            {nativeAgentContextSummaryLines.map((line) => (
                              <div key={line} className="agentInspectorSummaryLine">{line}</div>
                            ))}
                          </div>
                        </div>

                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Latest Response</div>
                          {nativeAgentInspectorSnapshot?.lastResponse ? (
                            <div className="bubbleRichContent bubbleMarkdownContent">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkBreaks]}
                                components={{ p: MarkdownParagraph }}
                              >
                                {nativeAgentInspectorSnapshot.lastResponse}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <div className="agentInspectorSectionCalloutMeta">No completed Native Agent response has been recorded yet.</div>
                          )}
                        </div>

                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Recent Activity</div>
                          {(nativeAgentInspectorSnapshot?.progressLines.length || agentProgressLines.length) ? (
                            <div className="cliRuntimeList">
                              {(isStreaming ? agentProgressLines : nativeAgentInspectorSnapshot?.progressLines ?? []).slice(-16).map((line, index) => (
                                <div key={`${index}-${line.slice(0, 32)}`} className="cliRuntimeListItem">{line}</div>
                              ))}
                            </div>
                          ) : (
                            <div className="agentInspectorSectionCalloutMeta">No Native Agent activity recorded yet.</div>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {inspectorSection === 'memory' ? (
                      <div className="agentInspectorBody">
                        {memorySnapshot ? (
                          <div className="agentMemorySummaryGrid">
                            <div className="agentMemorySummaryCard">
                              <span className="agentMemorySummaryLabel">Workspace</span>
                              <span className="agentMemorySummaryValue">{memorySnapshot.workspaceRoot}</span>
                            </div>
                            <div className="agentMemorySummaryCard">
                              <span className="agentMemorySummaryLabel">Auto memory</span>
                              <span className="agentMemorySummaryValue">{memorySnapshot.autoMemoryEnabled ? 'Enabled' : 'Disabled'}</span>
                            </div>
                            <div className="agentMemorySummaryCard">
                              <span className="agentMemorySummaryLabel">Memory root</span>
                              <span className="agentMemorySummaryValue">{memorySnapshot.autoMemoryRoot}</span>
                            </div>
                          </div>
                        ) : null}

                        {memoryError ? <div className="agentMemoryNotice error">{memoryError}</div> : null}
                        {!memoryError && memoryLoading ? <div className="agentMemoryNotice">Loading workspace memory…</div> : null}
                        {!memoryError && !memoryLoading && memorySnapshot?.notices.length ? (
                          <div className="agentMemoryNoticeGroup">
                            {memorySnapshot.notices.map((notice) => (
                              <div key={notice} className="agentMemoryNotice">{notice}</div>
                            ))}
                          </div>
                        ) : null}

                        {memoryInstructionGroups.map((group) => (
                          <div key={group.key} className="agentMemorySection">
                            <div className="agentMemorySectionHeader">
                              <div className="cardTitle">{group.title}</div>
                              <div className="agentMemoryMeta">{group.items.length} files</div>
                            </div>
                            {group.items.length ? (
                              <div className="agentMemoryList">
                                {group.items.map((item) => renderInspectorMemoryItem(item))}
                              </div>
                            ) : (
                              <div className="agentMemoryEmpty">{group.emptyText}</div>
                            )}
                          </div>
                        ))}

                        <div className="agentMemorySection">
                          <div className="agentMemorySectionHeader">
                            <div className="cardTitle">Auto Memory</div>
                            <div className="agentMemoryMeta">{memorySnapshot?.autoMemoryFiles.length ?? 0} files</div>
                          </div>
                          {memorySnapshot?.autoMemoryFiles.length ? (
                            <div className="agentMemoryList">
                              {memorySnapshot.autoMemoryFiles.map((item) => renderInspectorMemoryItem(item))}
                            </div>
                          ) : (
                            <div className="agentMemoryEmpty">No auto memory files found yet for this workspace.</div>
                          )}
                        </div>

                        {selectedInspectorFile ? (
                          <div className="agentInspectorViewer">
                            <div className="agentInspectorViewerHeader">
                              <div>
                                <div className="cardTitle">{selectedInspectorFile.relativePath}</div>
                                <div className="agentMemoryMeta">{selectedInspectorFile.displayPath}</div>
                              </div>
                              <div className="agentInspectorActions">
                                <button type="button" onClick={() => void openInspectorSource(selectedInspectorFile)}>
                                  {isPathInside(workspaceContext.workspaceRoot, selectedInspectorFile.path) ? 'Open in Workspace' : 'Refresh Preview'}
                                </button>
                                <button type="button" onClick={() => void revealInspectorFile(selectedInspectorFile)}>Reveal</button>
                              </div>
                            </div>
                            {selectedInspectorFileError ? <div className="agentMemoryNotice error">{selectedInspectorFileError}</div> : null}
                            {selectedInspectorFileLoading ? <div className="agentMemoryNotice">Loading full contents…</div> : null}
                            {!selectedInspectorFileLoading && !selectedInspectorFileError ? (
                              <pre className="agentInspectorViewerContent">{selectedInspectorFileContent || '(empty file)'}</pre>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {inspectorSection === 'model-input' ? (
                      <div className="agentInspectorBody">
                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Prompt</div>
                          <div className="agentInspectorSectionCalloutMeta">{nativeAgentInspectorSnapshot ? previewText(nativeAgentInspectorSnapshot.outgoingText, 220) : 'No prompt recorded yet.'}</div>
                        </div>

                        <div className="agentInspectorViewer">
                          <div className="agentInspectorViewerHeader">
                            <div>
                              <div className="cardTitle">System Prompt</div>
                              <div className="agentMemoryMeta">Native Agent behavioral instructions plus workspace/session memory.</div>
                            </div>
                          </div>
                          <pre className="agentInspectorViewerContent">{nativeAgentInspectorSnapshot?.systemPrompt || '(not captured yet)'}</pre>
                        </div>

                        <div className="agentInspectorViewer">
                          <div className="agentInspectorViewerHeader">
                            <div>
                              <div className="cardTitle">Memory Context</div>
                              <div className="agentMemoryMeta">Workspace instruction files and auto memory assembled for Native Agent.</div>
                            </div>
                          </div>
                          <pre className="agentInspectorViewerContent">{nativeAgentInspectorSnapshot?.memoryContext || '(no workspace memory included)'}</pre>
                        </div>

                        <div className="agentInspectorViewer">
                          <div className="agentInspectorViewerHeader">
                            <div>
                              <div className="cardTitle">Assembled Model Payload</div>
                              <div className="agentMemoryMeta">Exact request body captured before sending the latest Native Agent turn.</div>
                            </div>
                          </div>
                          <pre className="agentInspectorViewerContent">{nativeAgentInspectorSnapshot?.payload || '(not captured yet)'}</pre>
                        </div>
                      </div>
                    ) : null}

                    {inspectorSection === 'tooling' ? (
                      <div className="agentInspectorBody">
                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Tool Calls and Results</div>
                          <div className="agentInspectorSectionCalloutMeta">Captured request/result pairs from the latest Native Agent run.</div>
                        </div>

                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Execution Trace</div>
                          <div className="agentInspectorSectionCalloutMeta">A one-turn swimlane view of how the latest prompt moved through the agent and tool runtime.</div>
                          {nativeAgentExecutionTrace.length ? (
                            <div className="agentExecutionTrace">
                              <div className="agentExecutionTraceLanes" aria-hidden="true">
                                <span>User</span>
                                <span>Native Agent</span>
                                <span>Tools</span>
                              </div>
                              <div className="agentExecutionTraceList">
                                {nativeAgentExecutionTrace.map((step) => (
                                  <div key={step.id} className={`agentExecutionTraceStep tone-${step.tone ?? 'neutral'}`}>
                                    <div className={`agentExecutionTraceActor actor-${step.actor}`}>{step.actor}</div>
                                    <div className="agentExecutionTraceArrow">→</div>
                                    <div className={`agentExecutionTraceActor actor-${step.target}`}>{step.target}</div>
                                    <details className="agentExecutionTraceCard">
                                      <summary className="agentExecutionTraceSummary">
                                        <div className="agentExecutionTraceSummaryTop">
                                          <div className="agentExecutionTraceTitle">{step.title}</div>
                                          <div className="agentExecutionTraceMetaRow">
                                            {step.occurredAt ? <span>{formatTimestamp(step.occurredAt)}</span> : null}
                                            {step.elapsedMs !== undefined ? <span>+{formatDuration(step.elapsedMs)}</span> : null}
                                            {step.durationMs !== undefined ? <span>duration {formatDuration(step.durationMs)}</span> : null}
                                          </div>
                                        </div>
                                        <div className="agentInspectorSectionCalloutMeta">{step.detail}</div>
                                      </summary>
                                      {step.rawDetail ? (
                                        <pre className="agentExecutionTraceDetail">{step.rawDetail}</pre>
                                      ) : null}
                                    </details>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="agentInspectorSectionCalloutMeta">No execution trace is available until a Native Agent turn has completed.</div>
                          )}
                        </div>

                        {nativeAgentInspectorSnapshot?.toolEvents.length ? (
                          <div className="agentInspectorTimelineList">
                            {nativeAgentInspectorSnapshot.toolEvents.map((event) => (
                              <div key={event.id} className={`agentInspectorToolEvent${event.isError ? ' isError' : ''}`}>
                                <div className="agentInspectorTimelineTop">
                                  <span className="agentInspectorTimelineLabel">{event.summary}</span>
                                  <span className="agentInspectorToolBadge">{event.phase}</span>
                                </div>
                                <div className="agentInspectorSectionCalloutMeta">{event.tool}</div>
                                <pre className="agentInspectorViewerContent">{event.rawDetail ?? event.detail}</pre>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="agentInspectorSectionCalloutMeta">No tool calls captured yet for this Native Agent session.</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </aside>
              </>
            ) : null}

            {isClaudeCliMode ? (
              <>
                <button
                  type="button"
                  className={inspectorDrawerOpen ? 'inspectorDrawerBackdrop open' : 'inspectorDrawerBackdrop'}
                  aria-label="Close Claude inspector panel"
                  onClick={closeInspectorDrawer}
                />
                <aside className={inspectorDrawerOpen ? 'inspectorDrawerPanel open' : 'inspectorDrawerPanel'}>
                  <div className="agentInspectorPanel">
                    <div className="agentInspectorHeader">
                      <div>
                        <div className="cardTitle">{inspectorTitle}</div>
                        <div className="agentMemoryMeta">{inspectorSubtitle}</div>
                      </div>
                      <div className="agentInspectorActions">
                        <button type="button" onClick={() => setShowClaudeCliDetails((v) => !v)}>
                          {showClaudeCliDetails ? 'Hide Details' : 'Show Details'}
                        </button>
                        <button type="button" onClick={() => setClaudeCliMinimalMode((v) => !v)}>
                          {cliMinimalMode ? 'Minimal: On' : 'Minimal: Off'}
                        </button>
                        <button type="button" onClick={() => {
                          setMemoryRefreshTick((value) => value + 1);
                          setSkillsRefreshTick((value) => value + 1);
                        }} disabled={memoryLoading || isAnySkillsLoading}>
                          {memoryLoading || isAnySkillsLoading ? 'Refreshing…' : 'Refresh'}
                        </button>
                        <button type="button" onClick={closeInspectorDrawer}>Close</button>
                      </div>
                    </div>

                    <div className="agentInspectorTabs" role="tablist" aria-label="Claude inspector sections">
                      <button type="button" className={inspectorSection === 'overview' ? 'agentInspectorTab active' : 'agentInspectorTab'} onClick={() => setInspectorSection('overview')}>
                        Overview
                      </button>
                      <button type="button" className={inspectorSection === 'memory' ? 'agentInspectorTab active' : 'agentInspectorTab'} onClick={() => setInspectorSection('memory')}>
                        Memory
                      </button>
                      <button type="button" className={inspectorSection === 'skills' ? 'agentInspectorTab active' : 'agentInspectorTab'} onClick={() => setInspectorSection('skills')}>
                        Skills
                      </button>
                    </div>

                    {inspectorSection === 'overview' ? (
                      <div className="agentInspectorBody">
                        <div className="agentInspectorSummaryGrid">
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Session</span>
                            <span className="agentMemorySummaryValue">{cliRuntimeState.connected ? 'Connected' : 'Inactive'}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Runtime</span>
                            <span className="agentMemorySummaryValue">{cliRuntimeState.running ? 'Running' : 'Idle'}</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Events</span>
                            <span className="agentMemorySummaryValue">{cliRuntimeState.events.length} recent signals</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Skills</span>
                            <span className="agentMemorySummaryValue">{discoveredSkills.length} discovered</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Instruction files</span>
                            <span className="agentMemorySummaryValue">{memorySnapshot?.instructionFiles.length ?? 0} loaded sources</span>
                          </div>
                          <div className="agentMemorySummaryCard">
                            <span className="agentMemorySummaryLabel">Auto memory files</span>
                            <span className="agentMemorySummaryValue">{memorySnapshot?.autoMemoryFiles.length ?? 0} notes</span>
                          </div>
                        </div>

                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Current Context Summary</div>
                          <div className="agentInspectorSummaryList">
                            {runtimeContextSummaryLines.map((line) => (
                              <div key={line} className="agentInspectorSummaryLine">{line}</div>
                            ))}
                          </div>
                        </div>

                        <div className="agentInspectorSectionCallout">
                          <div className="cardTitle">Recent Memory Activity</div>
                          {recentMemoryTimeline.length ? (
                            <div className="agentInspectorTimelineList">
                              {recentMemoryTimeline.map((item) => (
                                <div key={item.id} className="agentInspectorTimelineItem">
                                  <div className="agentInspectorTimelineTop">
                                    <span className="agentInspectorTimelineLabel">{item.label}</span>
                                    <span className="agentInspectorTimelineTime">{formatTimestamp(item.updatedAt)}</span>
                                  </div>
                                  <div className="agentInspectorSectionCalloutMeta">{item.meta}</div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="agentInspectorSectionCalloutMeta">No memory activity detected yet.</div>
                          )}
                        </div>

                        <div className="cliRuntimePanel">
                          <div className="cliRuntimeHeader">
                            <div>
                              <div className="cardTitle">Claude Runtime</div>
                              <div className="cliRuntimeMeta">
                                {cliRuntimeState.connected ? 'Connected to Claude CLI session' : 'No active Claude CLI session'}
                              </div>
                            </div>
                            <div className="cliRuntimeHeaderActions">
                              <div className="pill" style={{ opacity: 1 }}>
                                {cliRuntimeState.running ? 'Running' : 'Idle'}
                              </div>
                            </div>
                          </div>

                          {!cliMinimalMode && !cliRuntimeState.capabilities.interactiveStructuredOutput ? (
                            <div className="cliRuntimeHint">
                              Interactive Claude CLI does not expose documented structured events. This panel shows best-effort runtime signals.
                            </div>
                          ) : null}

                          {!cliMinimalMode && showClaudeCliDetails && cliRuntimeState.debugLogPath ? (
                            <div className="cliRuntimeMetaRow">
                              <span className="cliRuntimeMetaLabel">Debug log</span>
                              <span className="cliRuntimeMetaValue">{cliRuntimeState.debugLogPath}</span>
                            </div>
                          ) : null}

                          {!cliMinimalMode && showClaudeCliDetails ? (
                            <div className="cliRuntimeMetaRow">
                              <span className="cliRuntimeMetaLabel">Signal source</span>
                              <span className="cliRuntimeMetaValue">{cliRuntimeState.capabilities.source}</span>
                            </div>
                          ) : null}

                          {!cliMinimalMode && cliRuntimeState.resumeInfo.restoredFromStorage ? (
                            <div className="cliRuntimeSignal resume">
                              <div className="cardTitle">Workspace Resume</div>
                              <div className="cliRuntimeMetaRow">
                                <span className="cliRuntimeMetaLabel">Snapshot session</span>
                                <span className="cliRuntimeMetaValue">{cliRuntimeState.resumeInfo.snapshotSessionId ?? 'unknown'}</span>
                              </div>
                              <div className="cliRuntimeMetaRow">
                                <span className="cliRuntimeMetaLabel">Snapshot saved</span>
                                <span className="cliRuntimeMetaValue">{snapshotSavedAtText ?? 'unknown'}</span>
                              </div>
                              <div className="cliRuntimeMetaRow">
                                <span className="cliRuntimeMetaLabel">Restored in UI</span>
                                <span className="cliRuntimeMetaValue">{restoredAtText ?? 'unknown'}</span>
                              </div>
                            </div>
                          ) : null}

                          {cliRuntimeState.pendingApproval ? (
                            <div className="cliRuntimeSignal approval">
                              <div className="cardTitle">Approval</div>
                              <div>{cliRuntimeState.pendingApproval}</div>
                            </div>
                          ) : null}

                          {cliRuntimeState.pendingQuestion ? (
                            <div className="cliRuntimeSignal question">
                              <div className="cardTitle">Question</div>
                              <div>{cliRuntimeState.pendingQuestion}</div>
                            </div>
                          ) : null}

                          {cliRuntimeState.lastPlan.length ? (
                            <div className="cliRuntimeSignal plan">
                              <div className="cardTitle">Last Plan</div>
                              <div className="cliRuntimeList">
                                {cliRuntimeState.lastPlan.map((line, index) => (
                                  <div key={`${index}-${line.slice(0, 16)}`} className="cliRuntimeListItem">{line}</div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {!cliMinimalMode && cliRuntimeState.diffDetected ? (
                            <div className="cliRuntimeSignal diff">
                              <div className="cardTitle">Diff Activity</div>
                              <div>Recent terminal output included diff markers.</div>
                            </div>
                          ) : null}

                          {cliRuntimeEvents.length ? (
                            <div className="cliRuntimeSection">
                              <div className="cardTitle">Recent Events</div>
                              <div className="cliRuntimeList">
                                {cliRuntimeEvents.map((event, index) => (
                                  <div key={`${event.createdAt}-${index}`} className={`cliRuntimeEvent kind-${event.kind}`}>
                                    <span className="cliRuntimeEventKind">{event.kind}</span>
                                    <span>{event.text}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {!cliMinimalMode && showClaudeCliDetails && cliRuntimeRawTail ? (
                            <pre className="cliRuntimeRaw">{cliRuntimeRawTail}</pre>
                          ) : null}

                          {!cliMinimalMode && showClaudeCliDetails && cliRuntimeState.debugLogTail ? (
                            <div className="cliRuntimeSection">
                              <div className="cardTitle">Debug Log Tail</div>
                              <pre className="cliRuntimeRaw">{cliRuntimeState.debugLogTail}</pre>
                            </div>
                          ) : null}
                        </div>

                        {memorySnapshot ? (
                          <div className="agentInspectorSectionCallout">
                            <div className="cardTitle">Memory Snapshot</div>
                            <div className="agentMemoryMeta">Auto memory is {memorySnapshot.autoMemoryEnabled ? 'enabled' : 'disabled'} for this workspace.</div>
                            <div className="agentMemoryMeta">Root: {memorySnapshot.autoMemoryRoot}</div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {inspectorSection === 'memory' ? (
                      <div className="agentInspectorBody">
                        {memorySnapshot ? (
                          <div className="agentMemorySummaryGrid">
                            <div className="agentMemorySummaryCard">
                              <span className="agentMemorySummaryLabel">Workspace</span>
                              <span className="agentMemorySummaryValue">{memorySnapshot.workspaceRoot}</span>
                            </div>
                            <div className="agentMemorySummaryCard">
                              <span className="agentMemorySummaryLabel">Auto memory</span>
                              <span className="agentMemorySummaryValue">{memorySnapshot.autoMemoryEnabled ? 'Enabled' : 'Disabled'}</span>
                            </div>
                            <div className="agentMemorySummaryCard">
                              <span className="agentMemorySummaryLabel">Memory root</span>
                              <span className="agentMemorySummaryValue">{memorySnapshot.autoMemoryRoot}</span>
                            </div>
                          </div>
                        ) : null}

                        {memoryError ? <div className="agentMemoryNotice error">{memoryError}</div> : null}
                        {!memoryError && memoryLoading ? <div className="agentMemoryNotice">Loading agent memory…</div> : null}
                        {!memoryError && !memoryLoading && memorySnapshot?.notices.length ? (
                          <div className="agentMemoryNoticeGroup">
                            {memorySnapshot.notices.map((notice) => (
                              <div key={notice} className="agentMemoryNotice">{notice}</div>
                            ))}
                          </div>
                        ) : null}

                        {memoryInstructionGroups.map((group) => (
                          <div key={group.key} className="agentMemorySection">
                            <div className="agentMemorySectionHeader">
                              <div className="cardTitle">{group.title}</div>
                              <div className="agentMemoryMeta">{group.items.length} files</div>
                            </div>
                            {group.items.length ? (
                              <div className="agentMemoryList">
                                {group.items.map((item) => renderInspectorMemoryItem(item))}
                              </div>
                            ) : (
                              <div className="agentMemoryEmpty">{group.emptyText}</div>
                            )}
                          </div>
                        ))}

                        <div className="agentMemorySection">
                          <div className="agentMemorySectionHeader">
                            <div className="cardTitle">Auto Memory</div>
                            <div className="agentMemoryMeta">{memorySnapshot?.autoMemoryFiles.length ?? 0} files</div>
                          </div>
                          {memorySnapshot?.autoMemoryFiles.length ? (
                            <div className="agentMemoryList">
                              {memorySnapshot.autoMemoryFiles.map((item) => renderInspectorMemoryItem(item))}
                            </div>
                          ) : (
                            <div className="agentMemoryEmpty">No auto memory files found yet for this workspace.</div>
                          )}
                        </div>

                        {selectedInspectorFile ? (
                          <div className="agentInspectorViewer">
                            <div className="agentInspectorViewerHeader">
                              <div>
                                <div className="cardTitle">{selectedInspectorFile.relativePath}</div>
                                <div className="agentMemoryMeta">{selectedInspectorFile.displayPath}</div>
                              </div>
                              <div className="agentInspectorActions">
                                <button type="button" onClick={() => void openInspectorSource(selectedInspectorFile)}>
                                  {isPathInside(workspaceContext.workspaceRoot, selectedInspectorFile.path) ? 'Open in Workspace' : 'Refresh Preview'}
                                </button>
                                <button type="button" onClick={() => void revealInspectorFile(selectedInspectorFile)}>Reveal</button>
                              </div>
                            </div>
                            {selectedInspectorFileError ? <div className="agentMemoryNotice error">{selectedInspectorFileError}</div> : null}
                            {selectedInspectorFileLoading ? <div className="agentMemoryNotice">Loading full contents…</div> : null}
                            {!selectedInspectorFileLoading && !selectedInspectorFileError ? (
                              <pre className="agentInspectorViewerContent">{selectedInspectorFileContent || '(empty file)'}</pre>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {inspectorSection === 'skills' ? (
                      <div className="agentInspectorBody">
                        <div className="discoveredSkillsPanel agentInspectorEmbeddedPanel">
                          <div className="discoveredSkillsHeader">
                            <div>
                              <div className="cardTitle">Native Agent Skills</div>
                              <div className="discoveredSkillsMeta">Path: <code>.inspiration/skills</code></div>
                            </div>
                            <div className="agentInspectorSectionCalloutMeta">{discoveredSkills.length} entries</div>
                          </div>
                          {combinedSkillsError ? <div className="discoveredSkillsMeta">{combinedSkillsError}</div> : null}
                          {!combinedSkillsError ? (
                            <div className="discoveredSkillsMeta">{discoveredSkills.length ? `${discoveredSkills.length} skill entries` : 'No skills discovered yet'}</div>
                          ) : null}
                          {discoveredSkills.length ? (
                            <div className="discoveredSkillsList">
                              {discoveredSkills.map((skill) => (
                                <div key={skill.key} className="discoveredSkillsItem">
                                  <button type="button" className="discoveredSkillsItemBody" onClick={() => void previewInspectorSkill(skill)}>
                                    <span className={`discoveredSkillsBadge source-${skill.source}`}>{skill.source}</span>
                                    <span className="discoveredSkillsName">{skill.name}</span>
                                    {skill.meta ? <span className="discoveredSkillsMeta">{skill.meta}</span> : null}
                                  </button>
                                  <div className="discoveredSkillsActions">
                                    <button type="button" className="agentMemoryActionButton" onClick={() => void previewInspectorSkill(skill)}>View</button>
                                    <button type="button" className="agentMemoryActionButton" onClick={() => void openInspectorSkillSource(skill)}>
                                      {skill.path ? 'Open' : 'Preview'}
                                    </button>
                                    <button type="button" className="agentMemoryActionButton" onClick={() => void revealInspectorSkillSource(skill)} disabled={!skill.path}>Reveal</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        {selectedInspectorSkill ? (
                          <div className="agentInspectorViewer">
                            <div className="agentInspectorViewerHeader">
                              <div>
                                <div className="cardTitle">{selectedInspectorSkill.name}</div>
                                <div className="agentMemoryMeta">{selectedInspectorSkill.meta ?? selectedInspectorSkill.source}</div>
                              </div>
                              <div className="agentInspectorActions">
                                <button type="button" onClick={() => void openInspectorSkillSource(selectedInspectorSkill)}>
                                  {selectedInspectorSkill.path ? 'Open in Workspace' : 'Refresh Preview'}
                                </button>
                                <button type="button" onClick={() => void revealInspectorSkillSource(selectedInspectorSkill)} disabled={!selectedInspectorSkill.path}>Reveal</button>
                              </div>
                            </div>
                            {selectedInspectorSkillError ? <div className="agentMemoryNotice error">{selectedInspectorSkillError}</div> : null}
                            {selectedInspectorSkillLoading ? <div className="agentMemoryNotice">Loading full contents…</div> : null}
                            {!selectedInspectorSkillLoading && !selectedInspectorSkillError ? (
                              <pre className="agentInspectorViewerContent">{selectedInspectorSkillContent || '(empty skill)'}</pre>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </aside>
              </>
            ) : null}

            <>
              <button
                type="button"
                className={historyDrawerOpen ? 'historyDrawerBackdrop open' : 'historyDrawerBackdrop'}
                aria-label="Close history panel"
                onClick={closeHistoryDrawer}
              />
              <aside className={historyDrawerOpen ? 'historyDrawerPanel open' : 'historyDrawerPanel'}>
                <div className="historyPanel">
                  <div className="historyPanelHeader">
                    <div>
                      <div className="cardTitle">Session History</div>
                      <div className="historyPanelMeta">Search previous assistant sessions by profile or content.</div>
                    </div>
                    <button type="button" onClick={closeHistoryDrawer}>Close</button>
                  </div>

                  <input
                    className="historySearchInput"
                    value={historyQuery}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    placeholder="Search sessions..."
                  />

                  <div className="historySessionList">
                    {filteredSessionHistoryItems.length === 0 ? (
                      <div className="historyPanelMeta">No matching sessions.</div>
                    ) : (
                      filteredSessionHistoryItems.map((item) => (
                        <button
                          type="button"
                          key={item.profileId}
                          className={`historySessionItem${item.profileId === activeProfileId ? ' active' : ''}`}
                          onClick={() => selectHistorySession(item.profileId)}
                        >
                          <span className="historySessionTop">
                            <span className="historySessionProfile">{item.profileName}</span>
                            <span className="historySessionTime">{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : 'Unknown'}</span>
                          </span>
                          <span className="historySessionCount">{item.messageCount} messages</span>
                          {item.lastUserText ? <span className="historySessionPreview user">U: {item.lastUserText}</span> : null}
                          {item.lastAssistantText ? <span className="historySessionPreview assistant">A: {item.lastAssistantText}</span> : null}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </aside>
            </>

            {pendingAgentQuestion ? (
              <div className="agentQuestionPanel">
                <div className="cardTitle">{pendingAgentQuestion.kind === 'plan' ? 'Execution Plans' : 'Agent Question'}</div>
                <div className="agentQuestionPrompt">{pendingAgentQuestion.prompt}</div>
                {pendingAgentQuestion.options.length ? (
                  <div className="agentQuestionOptions">
                    {pendingAgentQuestion.options.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`agentQuestionOption${pendingAgentQuestion.selectedValues.includes(option.value) ? ' selected' : ''}${option.recommended ? ' recommended' : ''}`}
                        onClick={() => togglePendingAgentQuestionOption(option.value)}
                        aria-pressed={pendingAgentQuestion.selectedValues.includes(option.value)}
                      >
                        <span className="agentQuestionOptionHeader">
                          <span className={`agentQuestionOptionControl ${pendingAgentQuestion.multiSelect ? 'checkbox' : 'radio'}`} aria-hidden="true" />
                          <span className="agentQuestionOptionLabel">{option.label}</span>
                          {option.recommended ? <span className="agentQuestionOptionBadge">Recommended</span> : null}
                        </span>
                        {option.description ? <span className="agentQuestionOptionDescription">{option.description}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="agentQuestionActions">
                  <button
                    type="button"
                    className="primaryAction"
                    onClick={submitPendingAgentSelection}
                    disabled={pendingAgentQuestion.selectedValues.length === 0}
                  >
                    {pendingAgentQuestion.multiSelect ? 'Submit Selection' : 'Submit Choice'}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="composer">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') {
                    return;
                  }
                  if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                rows={3}
                placeholder={settings.interactionMode === 'claude_cli' ? 'Send input directly to the Claude CLI session…' : settings.interactionMode === 'native_agent' ? 'Describe the next coding step, ask for a refactor, or tell it to continue…' : 'Type here…'}
              />
              <button className="sendBtn" onClick={() => void onSend()} disabled={!canSend}>
                {isStreaming ? 'Streaming…' : 'Send'}
              </button>
            </div>
          </div>
  );

  return (
    <div className="page chatPage">
      <div
        key="collab-root"
        className={immersiveChatOpen ? 'workspaceWithDrawer collabMode immersiveChatMode' : 'workspaceWithDrawer collabMode'}
        style={{ '--assistant-drawer-width': `${drawerWidth}px` } as CSSProperties}
      >
        <div className="workspaceMain">
          {workspacePanel}
        </div>
        <div className={chatDrawerClassName} style={assistantVisible ? { width: immersiveChatOpen ? '100%' : `${drawerWidth}px` } : undefined}>
          <div
            className="chatResizeHandle"
            onPointerDown={(ev) => {
              if (immersiveChatOpen) return;
              setIsDrawerResizing(true);
              dragStateRef.current = { startX: ev.clientX, startWidth: drawerWidthRef.current };
              document.body.style.userSelect = 'none';
              document.body.style.cursor = 'col-resize';
            }}
          />
          {assistantCard}
        </div>
        <>
          <button
            type="button"
            className={openClawDrawerOpen ? 'memoryDrawerBackdrop open' : 'memoryDrawerBackdrop'}
            aria-label="Close OpenClaw panel"
            onClick={closeOpenClawDrawer}
          />
          <aside className={openClawDrawerOpen ? 'memoryDrawerPanel open openClawDrawerShell' : 'memoryDrawerPanel openClawDrawerShell'}>
            <div className="agentMemoryPanel openClawDrawerPanel">
              <div className="agentMemoryHeader">
                <div className="openClawDrawerHeaderBrand">
                  <span className="openClawDrawerLogo" aria-hidden="true">
                    <OpenClawLogo />
                  </span>
                  <div>
                    <div className="cardTitle">OpenClaw</div>
                    <div className="agentMemoryMeta">
                      {openClawGatewayStatus?.rpc?.ok
                        ? `Gateway reachable${openClawGatewayUrl ? ` at ${openClawGatewayUrl}` : ''}`
                        : workspaceContext.openClaw.installed
                          ? 'CLI detected locally. Gateway state is loading or unavailable.'
                          : 'OpenClaw CLI is not currently detected.'}
                    </div>
                  </div>
                </div>
                <div className="agentMemoryActions">
                  <button type="button" onClick={() => void handleOpenClawRefresh()} disabled={openClawGatewayLoading || openClawActionBusy !== null}>
                    {openClawActionBusy === 'refresh' || openClawGatewayLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                  <button
                    type="button"
                    className="openClawDashboardButton"
                    onClick={() => {
                      if (!openClawDashboardUrl) return;
                      window.open(openClawDashboardUrl, '_blank', 'noopener,noreferrer');
                    }}
                    disabled={!openClawDashboardUrl}
                  >
                    Open Dashboard
                  </button>
                  <button type="button" className="secondaryButton" onClick={() => void workspacePanelRef.current?.openOpenClawSetup()}>
                    Setup
                  </button>
                  <button type="button" onClick={closeOpenClawDrawer}>Close</button>
                </div>
              </div>

              <div className="agentMemorySummaryGrid openClawDrawerSummaryGrid">
                <div className="agentMemorySummaryCard">
                  <span className="agentMemorySummaryLabel">Gateway Service</span>
                  <span className="agentMemorySummaryValue">{openClawGatewayStatus?.service?.runtime?.status ?? (openClawGatewayLoading ? 'Checking…' : 'Unknown')}</span>
                </div>
                <div className="agentMemorySummaryCard">
                  <span className="agentMemorySummaryLabel">RPC</span>
                  <span className="agentMemorySummaryValue">{openClawGatewayStatus?.rpc?.ok ? 'Reachable' : openClawGatewayLoading ? 'Checking…' : 'Unavailable'}</span>
                </div>
                <div className="agentMemorySummaryCard">
                  <span className="agentMemorySummaryLabel">OpenClaw CLI</span>
                  <span className="agentMemorySummaryValue">{openClawInstallSnapshot?.openclawVersion ?? workspaceContext.openClaw.version ?? 'Not installed'}</span>
                </div>
                <div className="agentMemorySummaryCard">
                  <span className="agentMemorySummaryLabel">Sessions</span>
                  <span className="agentMemorySummaryValue">{openClawGatewayLoading ? 'Checking…' : String(openClawSessionCount)}</span>
                </div>
                <div className="agentMemorySummaryCard">
                  <span className="agentMemorySummaryLabel">Agents</span>
                  <span className="agentMemorySummaryValue">{openClawGatewayLoading ? 'Checking…' : String(openClawAgentCount)}</span>
                </div>
                <div className="agentMemorySummaryCard">
                  <span className="agentMemorySummaryLabel">Dashboard</span>
                  <span className="agentMemorySummaryValue openClawDashboardValue">
                    {openClawDashboardUrl ? (
                      <a href={openClawDashboardUrl} target="_blank" rel="noreferrer noopener" className="openClawEndpointLink">
                        {openClawDashboardLabel ?? 'Authenticated dashboard URL'}
                      </a>
                    ) : openClawGatewayLoading ? 'Checking…' : 'Unavailable'}
                  </span>
                </div>
              </div>

              {openClawGatewayError ? <div className="agentMemoryNotice error">{openClawGatewayError}</div> : null}
              {openClawActionNotice ? <div className="agentMemoryNotice">{openClawActionNotice}</div> : null}
              {openClawAuditIssues.map((issue, index) => (
                <div key={`${issue.code ?? 'issue'}-${index}`} className="agentMemoryNotice">
                  <strong>{issue.level ?? 'notice'}:</strong> {issue.message ?? 'Gateway audit warning'}
                  {issue.detail ? ` ${issue.detail}` : ''}
                </div>
              ))}

              <div className="agentMemorySection">
                <div className="agentMemorySectionHeader">
                  <div className="cardTitle">Gateway</div>
                </div>
                <div className="agentMemoryList">
                  <div className="agentMemoryItem">
                    <div className="agentMemoryItemTitle">Connection</div>
                    <div className="agentMemoryMeta">{openClawGatewayStatus?.gateway?.probeNote ?? 'Local OpenClaw gateway status is pulled directly from the installed CLI.'}</div>
                    <div className="agentMemoryMeta">Bind: {openClawGatewayStatus?.gateway?.bindHost ?? 'Unknown'}:{openClawGatewayStatus?.gateway?.port ?? '—'} · mode {openClawGatewayStatus?.gateway?.bindMode ?? 'unknown'}</div>
                    <div className="agentMemoryMeta">Port state: {openClawGatewayStatus?.port?.status ?? 'unknown'}</div>
                  </div>
                  <div className="agentMemoryItem">
                    <div className="agentMemoryItemTitle">Health</div>
                    <div className="agentMemoryMeta">Gateway health: {openClawGatewayHealth?.ok ? 'OK' : openClawGatewayLoading ? 'Checking…' : 'Unavailable'}</div>
                    <div className="agentMemoryMeta">Default agent: {openClawGatewayHealth?.defaultAgentId ?? 'Unknown'}</div>
                    <div className="agentMemoryMeta">Last sample: {openClawGatewayHealth?.ts ? new Date(openClawGatewayHealth.ts).toLocaleString() : 'Not sampled yet'}</div>
                  </div>
                </div>
              </div>

              {openClawGatewayStatus?.port?.hints?.length ? (
                <div className="agentMemorySection">
                  <div className="agentMemorySectionHeader">
                    <div className="cardTitle">Hints</div>
                  </div>
                  <div className="openClawIssueList">
                    {openClawGatewayStatus.port.hints.map((hint, index) => (
                      <div key={`${hint}-${index}`} className="agentMemoryNotice">{hint}</div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="agentMemorySection">
                <div className="agentMemorySectionHeader">
                  <div className="cardTitle">Environment</div>
                </div>
                <div className="agentMemorySummaryGrid openClawDrawerSummaryGrid compact">
                  <div className="agentMemorySummaryCard">
                    <span className="agentMemorySummaryLabel">Node</span>
                    <span className="agentMemorySummaryValue">{openClawInstallSnapshot?.nodeVersion ?? 'Unknown'}</span>
                  </div>
                  <div className="agentMemorySummaryCard">
                    <span className="agentMemorySummaryLabel">npm</span>
                    <span className="agentMemorySummaryValue">{openClawInstallSnapshot?.npmVersion ?? 'Unknown'}</span>
                  </div>
                  <div className="agentMemorySummaryCard">
                    <span className="agentMemorySummaryLabel">Requirement</span>
                    <span className="agentMemorySummaryValue">Node &gt;=22.12.0{openClawInstallSnapshot && !openClawInstallSnapshot.nodeOk ? ' required' : ''}</span>
                  </div>
                </div>
              </div>

              <div className="agentMemorySection">
                <div className="agentMemorySectionHeader">
                  <div className="cardTitle">Actions</div>
                </div>
                <div className="agentMemoryItemActions">
                  <button type="button" className="agentMemoryActionButton" onClick={() => void handleOpenClawUpdate()} disabled={openClawActionBusy !== null || !((openClawInstallSnapshot?.nodeOk ?? false) && (openClawInstallSnapshot?.npmOk ?? false))}>
                    {openClawActionBusy === 'update' ? 'Updating…' : 'Update CLI'}
                  </button>
                  <button type="button" className="agentMemoryActionButton" onClick={() => void handleOpenClawOnboarding()} disabled={openClawActionBusy !== null || !(openClawInstallSnapshot?.openclawVersion ?? workspaceContext.openClaw.version)}>
                    {openClawActionBusy === 'onboarding' ? 'Launching…' : 'Run Onboarding'}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </>
      </div>
    </div>
  );
}
