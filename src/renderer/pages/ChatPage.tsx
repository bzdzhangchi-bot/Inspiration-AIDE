import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionMessage, ChatMessage, ChatRequest } from '../../shared/types';
import { claudeCodeClient, type ClaudeCodeRuntimeState } from '../claudeCodeClient';
import { checkProviderConnection, openAgentSessionStream, openChatStream } from '../wsClient';
import { fsClient } from '../fsClient';
import { terminalClient, type TerminalCommandResult, type TerminalEvent } from '../terminalClient';
import { WorkspacePanel, type WorkspacePanelContext, type WorkspacePanelHandle } from '../workspace/WorkspacePanel';
import type { ModelProfile } from './SettingsPage';

type Msg = {
  role: 'user' | 'assistant';
  content: string;
};

type ThreadMap = Record<string, Msg[]>;
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
  allowFreeform: boolean;
  draft: string;
};

type ClaudeSkillItem = {
  key: string;
  name: string;
  source: 'workspace' | 'runtime';
  meta?: string;
};

type SessionHistoryItem = {
  profileId: string;
  profileName: string;
  updatedAt: number;
  messageCount: number;
  lastUserText: string;
  lastAssistantText: string;
};

function providerLabelFor(providerId: ModelProfile['providerId']) {
  if (providerId === 'github_copilot') return 'Copilot';
  if (providerId === 'anthropic') return 'Anthropic';
  return 'Compatible Gateway';
}

function modeLabelFor(mode: ModelProfile['interactionMode']) {
  if (mode === 'claude_cli') return 'Claude CLI';
  if (mode === 'claude_code') return 'Native Agent';
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
  | { type: 'action'; tool: 'apply_patch'; args: { path: string; replacements?: PatchReplacement[]; oldText?: string; newText?: string } }
  | { type: 'action'; tool: 'write_file'; args: { path: string; content: string } }
  | { type: 'action'; tool: 'run_command'; args: { command: string; timeoutMs?: number } }
  | { type: 'action'; tool: 'ask_user'; args: { prompt: string; options?: Array<string | AgentChoiceOption>; allowFreeform?: boolean; kind?: 'question' | 'plan' } }
  | { type: 'final'; message: string };

export type ChatSettings = Pick<ModelProfile, 'id' | 'name' | 'providerId' | 'baseUrl' | 'apiKey' | 'model' | 'interactionMode' | 'inlineCompletionsEnabled' | 'agentPatchesEnabled'>;

const INITIAL_CLAUDE_RUNTIME_STATE: ClaudeCodeRuntimeState = {
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
    source: 'claude --help indicates stream-json only works with --print'
  }
};

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

const AGENT_TOOL_NAMES = ['list_dir', 'read_file', 'apply_patch', 'write_file', 'run_command', 'ask_user'] as const;

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
    return {
      type: 'action',
      tool: 'list_dir',
      args: {
        path: typeof record.path === 'string' ? record.path : undefined
      }
    };
  }

  if (directTool === 'read_file') {
    if (typeof record.path !== 'string') return null;
    return { type: 'action', tool: 'read_file', args: { path: record.path } };
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

  if (directTool === 'run_command') {
    if (typeof record.command !== 'string') return null;
    return {
      type: 'action',
      tool: 'run_command',
      args: {
        command: record.command,
        timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined
      }
    };
  }

  if (directTool === 'ask_user') {
    if (typeof record.prompt !== 'string') return null;
    return {
      type: 'action',
      tool: 'ask_user',
      args: {
        prompt: record.prompt,
        options: normalizeAgentChoiceOptions(record.options),
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
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
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
    const objects = extractBalancedJsonObjects(candidate);
    for (const object of objects) {
      const parsed = tryParseAgentActionCandidate(object);
      if (parsed) return parsed;
    }
  }

  return null;
}

function summarizeCommandResult(result: { stdout: string; stderr: string; exitCode: number | null; signal: string | null; cwd: string }) {
  const parts = [`cwd: ${result.cwd}`, `exitCode: ${result.exitCode ?? 'null'}`, `signal: ${result.signal ?? 'null'}`];
  if (result.stdout.trim()) {
    parts.push(`stdout:\n${result.stdout}`);
  }
  if (result.stderr.trim()) {
    parts.push(`stderr:\n${result.stderr}`);
  }
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
  if (action.tool === 'run_command') {
    return `run_command ${action.args.command}`;
  }
  if (action.tool === 'ask_user') {
    return `ask_user ${action.args.prompt}`;
  }
  if (action.tool === 'apply_patch') {
    return `apply_patch ${action.args.path}`;
  }
  if (action.tool === 'write_file') {
    return `write_file ${action.args.path}`;
  }
  return `path` in action.args && typeof action.args.path === 'string'
    ? `${action.tool} ${action.args.path}`
    : action.tool;
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
  /^[|\\/\-]{2,}$/,
  /^\s*thinking\s*$/i,
  /^press (enter|return|y|n)/i,
  /^use arrow keys/i,
  /^\(y\/n\)/i,
  /^\[[A-Z0-9_;?]+\]$/
];

function sanitizeCliText(value: string) {
  return applyBackspaces(stripAnsiSequences(value))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function normalizeCliLines(value: string) {
  return sanitizeCliText(value)
    .split('\n')
    .map((line) => line.replace(/\t/g, '  ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !CLI_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}

function normalizeCliSingleLine(value: string) {
  const lines = normalizeCliLines(value);
  if (!lines.length) return '';
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function joinWorkspacePath(base: string, name: string) {
  const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedName = name.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalizedBase ? `${normalizedBase}/${normalizedName}` : normalizedName;
}

function toWorkspaceRelativePath(workspaceRoot: string, absoluteOrRelativePath: string) {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = absoluteOrRelativePath.replace(/\\/g, '/');
  if (target === root) return '.';
  if (target.startsWith(`${root}/`)) {
    return target.slice(root.length + 1);
  }
  return target.replace(/^\/+/, '');
}

function isMissingPathError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /ENOENT|no such file or directory/i.test(error.message);
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
  if (line.startsWith('Agent tool: list_dir ')) return `正在查看目录: ${line.slice('Agent tool: list_dir '.length)}`;
  if (line.startsWith('Agent tool: apply_patch ')) return `准备修改文件: ${line.slice('Agent tool: apply_patch '.length)}`;
  if (line.startsWith('Agent tool: write_file ')) return `准备写入文件: ${line.slice('Agent tool: write_file '.length)}`;
  if (line.startsWith('Running in terminal: ')) return `命令执行中: ${line.slice('Running in terminal: '.length)}`;
  if (line.startsWith('TOOL_RESULT run_command')) return '命令执行完成，正在读取结果';
  if (line.startsWith('TOOL_RESULT read_file')) return '文件内容已读取';
  if (line.startsWith('TOOL_RESULT list_dir')) return '目录内容已获取';
  if (line.startsWith('TOOL_RESULT apply_patch')) return '补丁已应用';
  if (line.startsWith('TOOL_RESULT write_file')) return '文件已写入';
  return line;
}

function extractRuntimeSkillHints(debugLogTail: string): ClaudeSkillItem[] {
  if (!debugLogTail.trim()) return [];

  const lines = debugLogTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const hints: ClaudeSkillItem[] = [];

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

  const map = new Map<string, ClaudeSkillItem>();
  for (const item of hints) {
    map.set(item.key, item);
  }

  return [...map.values()].slice(-4);
}

function buildClaudeCliReplyFromRuntime(state: ClaudeCodeRuntimeState, turnStartedAt: number) {
  const modelLines = state.events
    .filter((event) => event.createdAt >= turnStartedAt)
    .filter((event) => event.kind === 'message')
    .flatMap((event) => normalizeCliLines(event.text))
    .map((line) => line.replace(/^\[debug\]\s*/i, '').trim())
    .filter((line) => line.length > 0)
    .slice(-16)
    .filter((line, index, arr) => index === 0 || line !== arr[index - 1]);

  if (modelLines.length) {
    return modelLines.join('\n');
  }

  const eventLines = state.events
    .filter((event) => event.createdAt >= turnStartedAt)
    .filter((event) => event.kind === 'question' || event.kind === 'approval' || event.kind === 'plan')
    .slice(-6)
    .flatMap((event) => normalizeCliLines(event.text.replace(/^\[debug\]\s*/i, '')))
    .filter((text) => text.length > 0);

  if (eventLines.length) {
    return eventLines.join('\n');
  }

  const fallback: string[] = [state.running ? 'Claude is working...' : 'Claude finished this turn.'];
  if (state.pendingApproval) {
    fallback.push(`Approval needed: ${state.pendingApproval}`);
  }
  if (state.pendingQuestion) {
    fallback.push(`Question: ${state.pendingQuestion}`);
  }
  if (state.lastPlan.length) {
    fallback.push('Plan:');
    fallback.push(...state.lastPlan.slice(-4));
  }

  return fallback.join('\n');
}

export function ChatPage(props: {
  settings: ChatSettings;
  profiles: ModelProfile[];
  activeProfileId: string;
  onSelectProfile: (profileId: string) => void;
  isDrawerOpen: boolean;
  onToggleDrawer: () => void;
  onRunCommandInTerminal: (command: string, timeoutMs?: number) => Promise<TerminalCommandResult>;
  onInterruptAgentRun: () => Promise<void>;
  onSendPromptToClaudeCli: (prompt: string) => Promise<void>;
  onInterruptClaudeCli: () => Promise<void>;
}) {
  const { settings, profiles, activeProfileId, onSelectProfile, isDrawerOpen, onRunCommandInTerminal, onInterruptAgentRun, onSendPromptToClaudeCli } = props;

  const workspacePanelRef = useRef<WorkspacePanelHandle | null>(null);
  const drawerWidthRef = useRef(420);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [input, setInput] = useState('');
  const [threadsByProfile, setThreadsByProfile] = useState<ThreadMap>(() => {
    const initial: ThreadMap = {};
    for (const profile of profiles) {
      initial[profile.id] = loadStoredThread(profile.id);
    }
    return initial;
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(420);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspacePanelContext>({
    workspaceRoot: null,
    activePath: null,
    activeText: '',
    activeFileName: null,
    topLevelEntries: [],
    pendingPatchCount: 0,
    agentStatus: '',
    dirty: false,
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
  const [claudeRuntimeState, setClaudeRuntimeState] = useState<ClaudeCodeRuntimeState>(INITIAL_CLAUDE_RUNTIME_STATE);
  const [claudeCliMinimalMode, setClaudeCliMinimalMode] = useState(true);
  const [showClaudeCliDetails, setShowClaudeCliDetails] = useState(false);
  const [workspaceSkills, setWorkspaceSkills] = useState<ClaudeSkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsRefreshTick, setSkillsRefreshTick] = useState(0);
  const [skillsDrawerOpen, setSkillsDrawerOpen] = useState(false);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [pendingAgentQuestion, setPendingAgentQuestion] = useState<PendingAgentQuestion | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const activeStreamRef = useRef<{ close: () => void } | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const agentCancelRequestedRef = useRef(false);
  const agentProgressRef = useRef<string[]>([]);
  const agentRunActiveRef = useRef(false);
  const pendingAgentQuestionResolveRef = useRef<((answer: string) => void) | null>(null);
  const pendingAgentQuestionRejectRef = useRef<((error: Error) => void) | null>(null);
  const claudeCliTurnStartedAtRef = useRef<number | null>(null);
  const claudeCliPendingReplyRef = useRef(false);
  const lastMirroredTerminalInputRef = useRef<{ text: string; at: number } | null>(null);

  const messages = useMemo(() => threadsByProfile[activeProfileId] ?? loadStoredThread(activeProfileId), [activeProfileId, threadsByProfile]);

  useEffect(() => {
    const threadKey = storageKey(activeProfileId);
    const metaKey = historyMetaKey(activeProfileId);

    if (messages.length === 0) {
      localStorage.removeItem(threadKey);
      localStorage.removeItem(metaKey);
      return;
    }

    localStorage.setItem(threadKey, JSON.stringify(messages));
    localStorage.setItem(metaKey, JSON.stringify({ updatedAt: Date.now() }));
  }, [activeProfileId, messages]);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el || !shouldStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    return () => {
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
    claudeCliTurnStartedAtRef.current = null;
    claudeCliPendingReplyRef.current = false;
    lastMirroredTerminalInputRef.current = null;
    setSkillsDrawerOpen(false);
    setHistoryDrawerOpen(false);
    setHistoryQuery('');
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
    const off = claudeCodeClient.subscribe(setClaudeRuntimeState);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli') return;
    if (!claudeCliPendingReplyRef.current) return;
    const startedAt = claudeCliTurnStartedAtRef.current;
    if (!startedAt) return;

    const nextContent = buildClaudeCliReplyFromRuntime(claudeRuntimeState, startedAt);
    setCurrentMessages((prev) => {
      if (prev.length === 0) return prev;
      const lastIndex = prev.length - 1;
      const last = prev[lastIndex];
      if (last.role !== 'assistant') {
        return [...prev, { role: 'assistant', content: nextContent }];
      }
      if (last.content === nextContent) {
        return prev;
      }
      const next = [...prev];
      next[lastIndex] = { role: 'assistant', content: nextContent };
      return next;
    });

    if (!claudeRuntimeState.running) {
      claudeCliPendingReplyRef.current = false;
      claudeCliTurnStartedAtRef.current = null;
    }
  }, [claudeRuntimeState, settings.interactionMode]);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli') {
      setWorkspaceSkills([]);
      setSkillsLoading(false);
      setSkillsError(null);
      return;
    }

    if (!claudeRuntimeState.workspaceRoot) {
      setWorkspaceSkills([]);
      setSkillsLoading(false);
      setSkillsError('No workspace selected');
      return;
    }
    const workspaceRoot = claudeRuntimeState.workspaceRoot;

    let cancelled = false;
    setSkillsLoading(true);
    setSkillsError(null);

    const skillsRoot = '.claude/skills';
    const visited = new Set<string>();

    async function collectSkills(relativeDir: string, depth: number): Promise<ClaudeSkillItem[]> {
      if (depth > 5 || visited.has(relativeDir)) return [];
      visited.add(relativeDir);

      const entries = await fsClient.listWorkspaceDir(relativeDir);
      const items: ClaudeSkillItem[] = [];

      for (const entry of entries) {
        const nextRelativePath = toWorkspaceRelativePath(workspaceRoot, entry.path);
        if (entry.kind === 'file' && /^skill\.md$/i.test(entry.name)) {
          const folderName = nextRelativePath.split('/').slice(-2, -1)[0] ?? entry.name;
          items.push({
            key: `workspace-${nextRelativePath}`,
            name: folderName,
            source: 'workspace',
            meta: nextRelativePath
          });
          continue;
        }

        if (entry.kind === 'dir') {
          const childItems = await collectSkills(joinWorkspacePath(relativeDir, entry.name), depth + 1);
          items.push(...childItems);
        }
      }

      return items;
    }

    void collectSkills(skillsRoot, 0)
      .then((items) => {
        if (cancelled) return;
        setWorkspaceSkills(items);
        setSkillsLoading(false);
        setSkillsError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setWorkspaceSkills([]);
        setSkillsLoading(false);
        if (isMissingPathError(error)) {
          setSkillsError(null);
          return;
        }
        setSkillsError(error instanceof Error ? error.message : 'Unable to load workspace skills');
      });

    return () => {
      cancelled = true;
    };
  }, [claudeRuntimeState.workspaceRoot, settings.interactionMode, skillsRefreshTick]);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli') return;

    const off = terminalClient.onEvent((event) => {
      if (event.type !== 'input-line') return;
      if (event.source !== 'terminal') return;
      if (!claudeRuntimeState.sessionId || event.sessionId !== claudeRuntimeState.sessionId) return;
      const text = normalizeCliSingleLine(event.text);
      if (!text) return;

      const now = Date.now();
      const last = lastMirroredTerminalInputRef.current;
      if (last && last.text === text && now - last.at < 4000) {
        return;
      }
      lastMirroredTerminalInputRef.current = { text, at: now };

      claudeCliTurnStartedAtRef.current = Date.now();
      claudeCliPendingReplyRef.current = true;
      setCurrentMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: 'Claude is processing your request...' }]);
    });

    return () => {
      off();
    };
  }, [claudeRuntimeState.sessionId, settings.interactionMode]);

  useEffect(() => {
    drawerWidthRef.current = drawerWidth;
  }, [drawerWidth]);

  useEffect(() => {
    function onPointerMove(ev: PointerEvent) {
      const drag = dragStateRef.current;
      if (!drag) return;
      const nextWidth = Math.max(320, Math.min(720, drag.startWidth + (drag.startX - ev.clientX)));
      setDrawerWidth(nextWidth);
    }

    function onPointerUp() {
      dragStateRef.current = null;
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

  function setCurrentMessages(updater: Msg[] | ((prev: Msg[]) => Msg[])) {
    setThreadsByProfile((prev) => {
      const current = prev[activeProfileId] ?? loadStoredThread(activeProfileId);
      const nextMessages = typeof updater === 'function' ? updater(current) : updater;
      return {
        ...prev,
        [activeProfileId]: nextMessages
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

  async function promptAgentQuestion(args: { prompt: string; options?: Array<string | AgentChoiceOption>; allowFreeform?: boolean; kind?: 'question' | 'plan' }) {
    appendAgentProgress(`Agent asks: ${args.prompt}`);
    setAgentRunStatus('awaiting_input');

    const normalizedOptions = normalizeAgentChoiceOptions(args.options) ?? [];

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
        kind: args.kind ?? 'question',
        prompt: args.prompt,
        options: normalizedOptions,
        allowFreeform: args.allowFreeform ?? normalizedOptions.length === 0,
        draft: ''
      });
    });
  }

  function submitPendingAgentAnswer(answer: string) {
    const trimmed = answer.trim();
    if (!trimmed) return;
    appendAgentProgress(`Agent answer: ${trimmed}`);
    pendingAgentQuestionResolveRef.current?.(trimmed);
  }

  function updateAgentPlaceholder(userText: string, statusText: string) {
    setCurrentMessages([...messages, { role: 'user', content: userText }, { role: 'assistant', content: statusText }]);
  }

  function isAgentCancelledError(error: unknown) {
    return error instanceof Error && error.message === 'Agent run cancelled';
  }

  function assertAgentNotCancelled() {
    if (agentCancelRequestedRef.current) {
      throw new Error('Agent run cancelled');
    }
  }

  async function cancelActiveAgentRun() {
    if (!isStreaming) return;
    agentCancelRequestedRef.current = true;
    setAgentRunStatus('cancelling');
    setAgentActiveCommand(null);
    appendAgentProgress('Cancellation requested…');
    activeStreamRef.current?.close();
    activeStreamRef.current = null;
    rejectPendingAgentQuestion('Agent run cancelled');
    try {
      await onInterruptAgentRun();
    } catch {
      // ignore interrupt failures; the model stream may already be stopped
    }
  }

  const connectionHint = useMemo(() => {
    const modeLabel = settings.interactionMode === 'claude_cli'
      ? 'Claude CLI runtime'
      : settings.interactionMode === 'claude_code'
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

  const connectionKey = useMemo(
    () => [settings.interactionMode, settings.providerId, settings.baseUrl.trim(), settings.apiKey.trim(), settings.model.trim()].join('|'),
    [settings.apiKey, settings.baseUrl, settings.interactionMode, settings.model, settings.providerId]
  );

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
  }, [connectionKey, settings.apiKey, settings.baseUrl, settings.interactionMode, settings.model, settings.providerId]);

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
    const lines = [
      `Workspace root: ${workspaceContext.workspaceRoot}`,
      `Open file: ${workspaceContext.activePath ?? 'None'}`,
      `Unsaved edits: ${workspaceContext.dirty ? 'yes' : 'no'}`,
      `Top-level entries: ${entryNames.length ? entryNames.join(', ') : '(empty)'}`,
      `Interaction mode: ${settings.interactionMode === 'claude_cli' ? 'Claude CLI runtime session' : settings.interactionMode === 'claude_code' ? 'Native agent persistent coding session' : 'Standard chat session'}`
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

  function buildChatMessages(nextMessages: Msg[]): ChatMessage[] {
    const modeInstruction = settings.interactionMode === 'claude_code'
      ? 'Operate like a persistent coding agent in an ongoing workspace session. Maintain continuity across turns, continue prior plans without restating everything, prefer concrete next actions, and stay focused on editing, running, and validating project work.'
      : 'You are operating inside a desktop workspace editor. Use the provided workspace context to reason about the current project. When proposing file changes, reference concrete file paths and explain the intended edits clearly.';

    const contextPrefix: ChatMessage[] = workspaceContext.workspaceRoot
      ? [
          { role: 'system', content: modeInstruction },
          { role: 'system', content: workspaceSummary }
        ]
      : [{ role: 'system', content: modeInstruction }];

    return [
      ...contextPrefix,
      ...nextMessages
        .filter((m) => m.role !== 'assistant' || m.content.length > 0)
        .map((m) => ({ role: m.role, content: m.content }))
    ];
  }

  function buildAgentSystemPrompt() {
    return [
      'You are an autonomous coding agent for this workspace.',
      'Maintain continuity across turns and keep working until the task is complete or genuinely blocked.',
      'Use the provided tools for filesystem and terminal access instead of describing tool calls in plain text or JSON.',
      'For non-trivial requests with multiple valid approaches, ask the user to choose a plan before executing. Use ask_user kind=plan with 2 to 4 options and short tradeoffs.',
      'When there is an actual decision to make or multiple valid paths, use ask_user with concise choices instead of guessing.',
      'Prefer inspecting the workspace before editing, prefer targeted patches over full rewrites, and run validation commands when they are relevant.',
      'When the task is complete, answer the user directly in normal prose.',
      workspaceSummary
    ].join('\n\n');
  }

  function buildAgentSessionMessages(nextMessages: Msg[]): AgentSessionMessage[] {
    return nextMessages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: message.content }]
    }));
  }

  function buildAgentMessages(baseMessages: Msg[]): ChatMessage[] {
    const toolInstruction: ChatMessage = {
      role: 'system',
      content: [
        'You are an autonomous coding agent for this workspace.',
        'Respond with JSON only and choose exactly one next step.',
        'Do not add explanatory text before or after the JSON object.',
        'Valid responses:',
        '{"type":"action","tool":"list_dir","args":{"path":"relative/or/absolute/path"}}',
        '{"type":"action","tool":"read_file","args":{"path":"relative/or/absolute/path"}}',
        '{"type":"action","tool":"apply_patch","args":{"path":"relative/or/absolute/path","replacements":[{"oldText":"exact existing text","newText":"replacement text"}]}}',
        '{"type":"action","tool":"write_file","args":{"path":"relative/or/absolute/path","content":"full file content"}}',
        '{"type":"action","tool":"run_command","args":{"command":"shell command","timeoutMs":20000}}',
        '{"type":"action","tool":"ask_user","args":{"prompt":"question for the user","options":["choice A","choice B"],"allowFreeform":true}}',
        '{"type":"action","tool":"ask_user","args":{"kind":"plan","prompt":"Choose an implementation plan","options":[{"value":"safe","label":"Minimal patch","description":"Smallest possible change, low risk","recommended":true},{"value":"deeper","label":"Refactor the flow","description":"Cleaner long-term structure, larger change"}]}}',
        '{"type":"final","message":"user-facing answer"}',
        'Rules:',
        '- Use one tool at a time.',
        '- Keep the action wrapper. Prefer {"type":"action","tool":"read_file","args":...} over shorthand forms like {"type":"read_file",...}.',
        '- For larger or ambiguous tasks, prefer ask_user kind=plan before taking irreversible steps.',
        '- Use ask_user when there is a real user choice or ambiguity that should not be guessed.',
        '- Prefer list_dir/read_file before editing files.',
        '- Prefer apply_patch for targeted edits to existing files.',
        '- apply_patch may include multiple exact replacements in one call when they belong to the same file change.',
        '- Use write_file only for new files or full rewrites when patching is not practical.',
        '- Use run_command for build/test/inspection commands when needed.',
        '- After a tool result is returned, continue with another JSON response.',
        '- If the task is complete, return type=final.'
      ].join('\n')
    };

    return [toolInstruction, ...buildChatMessages(baseMessages)];
  }

  async function requestAgentTurn(reqMessages: AgentSessionMessage[]) {
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
        system: buildAgentSystemPrompt(),
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
          return;
        }
        if (ev.type === 'tool_use') {
          toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
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

  async function requestModelText(reqMessages: ChatMessage[]) {
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
        temperature: settings.interactionMode === 'claude_code' ? 0.1 : 0.2
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
    const progress: string[] = ['Agent: planning…'];
    agentProgressRef.current = [...progress];
    setAgentProgressLines([...progress]);
    appendAgentProgress(`Agent session: provider=${settings.providerId}`);

    setCurrentMessages(visiblePrefix);

    for (let step = 0; step < 8; step += 1) {
      assertAgentNotCancelled();
      const turn = await requestAgentTurn(agentMessages);
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
        agentRunActiveRef.current = false;
        const finalMessage = trimmedText || 'Done.';
        const finalContent = progress.length > 1
          ? `${finalMessage}\n\n---\n${progress.join('\n')}`
          : finalMessage;
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: finalContent }]);
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

        progress.push(summary);
        appendAgentProgress(summary);
        updateAgentPlaceholder(outgoingText, `Agent: ${summary}`);

        let toolResult = `TOOL_RESULT ${toolUse.name}\nstatus: failed\nreason: invalid tool arguments`;
        let isError = true;

        if (normalized && normalized.type === 'action') {
          try {
            toolResult = await executeAgentTool(normalized);
            isError = false;
          } catch (error) {
            toolResult = `TOOL_RESULT ${toolUse.name}\nstatus: failed\nreason: ${error instanceof Error ? error.message : 'tool execution failed'}`;
          }
        }

        assertAgentNotCancelled();

        const displayToolResult = toolResult.length > 1200 ? `${toolResult.slice(0, 1200)}\n...[truncated]` : toolResult;
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
    setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: `${progress.join('\n\n')}\n\nAgent stopped after reaching the step limit.` }]);
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
    const progress: string[] = ['Agent: planning…'];
    agentProgressRef.current = [...progress];
    setAgentProgressLines([...progress]);

    setCurrentMessages(visiblePrefix);

    for (let step = 0; step < 8; step += 1) {
      assertAgentNotCancelled();
      const responseText = await requestModelText(buildAgentMessages(agentMessages));
      assertAgentNotCancelled();
      const action = parseAgentAction(responseText);

      if (!action) {
        agentRunActiveRef.current = false;
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: responseText.trim() || 'Agent returned an empty response.' }]);
        return;
      }

      if (action.type === 'final') {
        agentRunActiveRef.current = false;
        const finalContent = progress.length > 1
          ? `${action.message.trim()}\n\n---\n${progress.join('\n')}`
          : action.message.trim();
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: finalContent || 'Done.' }]);
        return;
      }

      const summary = `Agent tool: ${summarizeAgentAction(action)}`;
      progress.push(summary);
      appendAgentProgress(summary);
      updateAgentPlaceholder(outgoingText, `Agent: ${summary}`);

      const toolResult = await executeAgentTool(action);

      assertAgentNotCancelled();

      progress.push(toolResult.length > 1200 ? `${toolResult.slice(0, 1200)}\n...[truncated]` : toolResult);
      appendAgentProgress(toolResult.length > 1200 ? `${toolResult.slice(0, 1200)}\n...[truncated]` : toolResult);
      updateAgentPlaceholder(outgoingText, 'Agent: planning next step…');

      agentMessages.push({ role: 'assistant', content: JSON.stringify(action) });
      agentMessages.push({ role: 'user', content: toolResult });
    }

    agentRunActiveRef.current = false;
    setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: `${progress.join('\n\n')}\n\nAgent stopped after reaching the step limit.` }]);
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
        const startedAt = Date.now();
        claudeCliTurnStartedAtRef.current = startedAt;
        claudeCliPendingReplyRef.current = true;
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: 'Claude is processing your request...' }]);
        await onSendPromptToClaudeCli(outgoingText);
      } catch (error) {
        claudeCliPendingReplyRef.current = false;
        claudeCliTurnStartedAtRef.current = null;
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: `Error: ${error instanceof Error ? error.message : 'Failed to send prompt to Claude CLI'}` }]);
      } finally {
        setIsStreaming(false);
      }
      return;
    }

    if (settings.interactionMode === 'claude_code' && workspaceContext.workspaceRoot) {
      try {
        await runClaudeCodeAgent(outgoingText);
      } catch (error) {
        if (isAgentCancelledError(error)) {
          const cancelledSummary = [...agentProgressRef.current, 'Agent run cancelled.'].join('\n\n');
          setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: cancelledSummary }]);
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
      temperature: settings.interactionMode === 'claude_code' ? 0.1 : 0.2
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
    setCurrentMessages([]);
    localStorage.removeItem(storageKey(activeProfileId));
    resetAgentRunState();
  }

  const showAgentPlanningPanel = settings.interactionMode === 'claude_code' && isStreaming;
  const showAgentActivityDock = showAgentPlanningPanel;
  const showClaudeCliRuntimeDock = false;
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
  const claudeRuntimeEvents = useMemo(() => {
    if (claudeCliMinimalMode) {
      return [];
    }
    const source = showClaudeCliDetails
      ? claudeRuntimeState.events
      : claudeRuntimeState.events.filter((event) => event.kind !== 'tool' && event.kind !== 'status');
    return source.slice(showClaudeCliDetails ? -8 : -4);
  }, [claudeCliMinimalMode, claudeRuntimeState.events, showClaudeCliDetails]);
  const claudeRuntimeRawTail = useMemo(() => buildReadableTerminalSnippet(claudeRuntimeState.rawTail), [claudeRuntimeState.rawTail]);
  const runtimeSkillHints = useMemo(() => extractRuntimeSkillHints(claudeRuntimeState.debugLogTail), [claudeRuntimeState.debugLogTail]);
  const claudeSkills = useMemo(() => {
    const merged = [...workspaceSkills, ...runtimeSkillHints];
    const map = new Map<string, ClaudeSkillItem>();
    for (const item of merged) {
      map.set(item.key, item);
    }
    return [...map.values()];
  }, [runtimeSkillHints, workspaceSkills]);
  const restoredAtText = useMemo(() => (
    claudeRuntimeState.resumeInfo.restoredAt ? new Date(claudeRuntimeState.resumeInfo.restoredAt).toLocaleString() : null
  ), [claudeRuntimeState.resumeInfo.restoredAt]);
  const snapshotSavedAtText = useMemo(() => (
    claudeRuntimeState.resumeInfo.snapshotSavedAt ? new Date(claudeRuntimeState.resumeInfo.snapshotSavedAt).toLocaleString() : null
  ), [claudeRuntimeState.resumeInfo.snapshotSavedAt]);
  const sessionHistoryItems = useMemo(() => {
    return profiles
      .map((profile) => {
        const thread = threadsByProfile[profile.id] ?? loadStoredThread(profile.id);
        if (!thread.length) return null;
        const lastUser = [...thread].reverse().find((item) => item.role === 'user')?.content ?? '';
        const lastAssistant = [...thread].reverse().find((item) => item.role === 'assistant')?.content ?? '';
        const updatedAt = loadHistoryUpdatedAt(profile.id);

        return {
          profileId: profile.id,
          profileName: profile.name,
          updatedAt,
          messageCount: thread.length,
          lastUserText: previewText(lastUser, 90),
          lastAssistantText: previewText(lastAssistant, 120)
        } as SessionHistoryItem;
      })
      .filter((item): item is SessionHistoryItem => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [profiles, threadsByProfile]);
  const filteredSessionHistoryItems = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    if (!query) return sessionHistoryItems;
    return sessionHistoryItems.filter((item) => {
      return item.profileName.toLowerCase().includes(query)
        || item.lastUserText.toLowerCase().includes(query)
        || item.lastAssistantText.toLowerCase().includes(query);
    });
  }, [historyQuery, sessionHistoryItems]);
  const canOpenSkills = settings.interactionMode === 'claude_cli';

  function openHistoryDrawer() {
    setSkillsDrawerOpen(false);
    setHistoryDrawerOpen(true);
  }

  function closeHistoryDrawer() {
    setHistoryDrawerOpen(false);
  }

  function openSkillsDrawer() {
    setHistoryDrawerOpen(false);
    setSkillsDrawerOpen(true);
  }

  function closeSkillsDrawer() {
    setSkillsDrawerOpen(false);
  }

  function selectHistorySession(profileId: string) {
    onSelectProfile(profileId);
    closeHistoryDrawer();
  }

  function toggleHistoryDrawer() {
    if (historyDrawerOpen) {
      closeHistoryDrawer();
      return;
    }
    openHistoryDrawer();
  }

  function toggleSkillsDrawer() {
    if (!canOpenSkills) return;
    if (skillsDrawerOpen) {
      closeSkillsDrawer();
      return;
    }
    openSkillsDrawer();
  }

  return (
    <div className="page chatPage">
      <div className="workspaceWithDrawer">
        <div className="workspaceMain">
          <WorkspacePanel ref={workspacePanelRef} settings={settings} onContextChange={setWorkspaceContext} onRunCommandInTerminal={onRunCommandInTerminal} />
        </div>

        <div className={isDrawerOpen ? 'chatDrawer open' : 'chatDrawer'} style={isDrawerOpen ? { width: `${drawerWidth}px` } : undefined}>
          <div
            className="chatResizeHandle"
            onPointerDown={(ev) => {
              dragStateRef.current = { startX: ev.clientX, startWidth: drawerWidthRef.current };
              document.body.style.userSelect = 'none';
              document.body.style.cursor = 'col-resize';
            }}
          />
          <div className="chatCard">
            <div className="chatHeader">
              <div className="chatHeaderTitleRow">
                <div className="cardTitle">Assistant</div>
                <div className={`chatStatus ${currentConnectionState?.status ?? 'checking'}`} title={currentConnectionState?.message ?? connectionHint}>
                  <span className="chatStatusDot" />
                  <span>{currentConnectionState ? currentConnectionState.status === 'ok' ? 'Connected' : currentConnectionState.status === 'error' ? 'Issue' : 'Checking' : 'Checking'}</span>
                </div>
              </div>
              <div className="chatHeaderActions">
                <select value={activeProfileId} onChange={(e) => onSelectProfile(e.target.value)} className="chatProfileSelect">
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {modeLabelFor(profile.interactionMode)} · {providerLabelFor(profile.providerId)}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={resetCurrentThread} disabled={isStreaming || messages.length === 0}>Reset Session</button>
              </div>
            </div>

            {currentConnectionState?.status === 'error' ? (
              <div className="chatHeaderNotice error">{currentConnectionState.message}</div>
            ) : null}

            <div
              ref={messagesRef}
              className="messages"
              onScroll={(e) => {
                const el = e.currentTarget;
                const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                shouldStickToBottomRef.current = distanceFromBottom < 24;
              }}
            >
              {messages.length === 0 ? (
                <div className="empty">{settings.interactionMode === 'claude_cli' ? 'Send a prompt to start or continue real Claude CLI. The conversation will update directly in this chat.' : settings.interactionMode === 'claude_code' ? 'Start a persistent native-agent session. This profile keeps its own running conversation.' : 'Send a message to start.'}</div>
              ) : (
                <div>
                  {settings.interactionMode === 'claude_code' ? (
                    <div className="chatInlineActions">
                      <button type="button" onClick={() => void onSend('Continue from the current workspace state and take the next most useful step.')} disabled={isStreaming}>
                        Continue
                      </button>
                    </div>
                  ) : null}

                  {messages.map((m, idx) => (
                    <div key={idx} className={`msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
                      <div className="meta">
                        <div>{m.role}</div>
                      </div>
                      <div className="bubble">{m.content}</div>
                    </div>
                  ))}
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

            {showClaudeCliRuntimeDock ? (
              <div className="chatActivityDock">
                <div className="claudeRuntimePanel">
                  <div className="claudeRuntimeHeader">
                    <div>
                      <div className="cardTitle">Claude Runtime</div>
                      <div className="claudeRuntimeMeta">
                        {claudeRuntimeState.connected ? 'Connected to Claude CLI session' : 'No active Claude CLI session'}
                      </div>
                    </div>
                    <div className="claudeRuntimeHeaderActions">
                      <button type="button" onClick={() => setClaudeCliMinimalMode((v) => !v)}>
                        {claudeCliMinimalMode ? 'Minimal: On' : 'Minimal: Off'}
                      </button>
                      <button type="button" onClick={() => setShowClaudeCliDetails((v) => !v)}>
                        {showClaudeCliDetails ? 'Hide Details' : 'Show Details'}
                      </button>
                      <div className="pill" style={{ opacity: 1 }}>
                        {claudeRuntimeState.running ? 'Running' : 'Idle'}
                      </div>
                    </div>
                  </div>

                  {!claudeCliMinimalMode && !claudeRuntimeState.capabilities.interactiveStructuredOutput ? (
                    <div className="claudeRuntimeHint">
                      Interactive Claude CLI does not expose documented structured events. This panel shows best-effort runtime signals.
                    </div>
                  ) : null}

                  {!claudeCliMinimalMode && showClaudeCliDetails && claudeRuntimeState.debugLogPath ? (
                    <div className="claudeRuntimeMetaRow">
                      <span className="claudeRuntimeMetaLabel">Debug log</span>
                      <span className="claudeRuntimeMetaValue">{claudeRuntimeState.debugLogPath}</span>
                    </div>
                  ) : null}

                  {!claudeCliMinimalMode && showClaudeCliDetails ? (
                    <div className="claudeRuntimeMetaRow">
                      <span className="claudeRuntimeMetaLabel">Signal source</span>
                      <span className="claudeRuntimeMetaValue">{claudeRuntimeState.capabilities.source}</span>
                    </div>
                  ) : null}

                  {!claudeCliMinimalMode && claudeRuntimeState.resumeInfo.restoredFromStorage ? (
                    <div className="claudeRuntimeSignal resume">
                      <div className="cardTitle">Workspace Resume</div>
                      <div className="claudeRuntimeMetaRow">
                        <span className="claudeRuntimeMetaLabel">Snapshot session</span>
                        <span className="claudeRuntimeMetaValue">{claudeRuntimeState.resumeInfo.snapshotSessionId ?? 'unknown'}</span>
                      </div>
                      <div className="claudeRuntimeMetaRow">
                        <span className="claudeRuntimeMetaLabel">Snapshot saved</span>
                        <span className="claudeRuntimeMetaValue">{snapshotSavedAtText ?? 'unknown'}</span>
                      </div>
                      <div className="claudeRuntimeMetaRow">
                        <span className="claudeRuntimeMetaLabel">Restored in UI</span>
                        <span className="claudeRuntimeMetaValue">{restoredAtText ?? 'unknown'}</span>
                      </div>
                    </div>
                  ) : null}

                  {claudeRuntimeState.pendingApproval ? (
                    <div className="claudeRuntimeSignal approval">
                      <div className="cardTitle">Approval</div>
                      <div>{claudeRuntimeState.pendingApproval}</div>
                    </div>
                  ) : null}

                  {claudeRuntimeState.pendingQuestion ? (
                    <div className="claudeRuntimeSignal question">
                      <div className="cardTitle">Question</div>
                      <div>{claudeRuntimeState.pendingQuestion}</div>
                    </div>
                  ) : null}

                  {claudeRuntimeState.lastPlan.length ? (
                    <div className="claudeRuntimeSignal plan">
                      <div className="cardTitle">Last Plan</div>
                      <div className="claudeRuntimeList">
                        {claudeRuntimeState.lastPlan.map((line, index) => (
                          <div key={`${index}-${line.slice(0, 16)}`} className="claudeRuntimeListItem">{line}</div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {!claudeCliMinimalMode && claudeRuntimeState.diffDetected ? (
                    <div className="claudeRuntimeSignal diff">
                      <div className="cardTitle">Diff Activity</div>
                      <div>Recent terminal output included diff markers.</div>
                    </div>
                  ) : null}

                  {claudeRuntimeEvents.length ? (
                    <div className="claudeRuntimeSection">
                      <div className="cardTitle">Recent Events</div>
                      <div className="claudeRuntimeList">
                        {claudeRuntimeEvents.map((event, index) => (
                          <div key={`${event.createdAt}-${index}`} className={`claudeRuntimeEvent kind-${event.kind}`}>
                            <span className="claudeRuntimeEventKind">{event.kind}</span>
                            <span>{event.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {!claudeCliMinimalMode && showClaudeCliDetails && claudeRuntimeRawTail ? (
                    <pre className="claudeRuntimeRaw">{claudeRuntimeRawTail}</pre>
                  ) : null}

                  {!claudeCliMinimalMode && showClaudeCliDetails && claudeRuntimeState.debugLogTail ? (
                    <div className="claudeRuntimeSection">
                      <div className="cardTitle">Debug Log Tail</div>
                      <pre className="claudeRuntimeRaw">{claudeRuntimeState.debugLogTail}</pre>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <aside className="assistantSideBar" aria-label="Assistant tools">
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
                className={`assistantSideBarItem ${skillsDrawerOpen ? 'active' : ''}`}
                onClick={toggleSkillsDrawer}
                disabled={!canOpenSkills}
                title={canOpenSkills ? (skillsDrawerOpen ? 'Hide skills' : 'Show skills') : 'Skills are available in Claude CLI mode'}
                aria-label={canOpenSkills ? (skillsDrawerOpen ? 'Hide skills' : 'Show skills') : 'Skills unavailable in current mode'}
              >
                <svg className="assistantSideBarGlyph" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z" />
                  <path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14Z" />
                </svg>
              </button>
            </aside>

            {settings.interactionMode === 'claude_cli' ? (
              <>
                <button
                  type="button"
                  className={skillsDrawerOpen ? 'skillsDrawerBackdrop open' : 'skillsDrawerBackdrop'}
                  aria-label="Close skills panel"
                  onClick={closeSkillsDrawer}
                />
                <aside className={skillsDrawerOpen ? 'skillsDrawerPanel open' : 'skillsDrawerPanel'}>
                  <div className="claudeSkillsPanel">
                    <div className="claudeSkillsHeader">
                      <div>
                        <div className="cardTitle">Claude Code Skills</div>
                        <div className="claudeSkillsMeta">Path: <code>.claude/skills</code></div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" onClick={() => setSkillsRefreshTick((v) => v + 1)} disabled={skillsLoading}>
                          {skillsLoading ? 'Refreshing…' : 'Refresh'}
                        </button>
                        <button type="button" onClick={closeSkillsDrawer}>Close</button>
                      </div>
                    </div>
                    {skillsError ? <div className="claudeSkillsMeta">{skillsError}</div> : null}
                    {!skillsError ? (
                      <div className="claudeSkillsMeta">{claudeSkills.length ? `${claudeSkills.length} skill entries` : 'No skills discovered yet'}</div>
                    ) : null}
                    {claudeSkills.length ? (
                      <div className="claudeSkillsList">
                        {claudeSkills.map((skill) => (
                          <div key={skill.key} className="claudeSkillsItem">
                            <span className={`claudeSkillsBadge source-${skill.source}`}>{skill.source}</span>
                            <span className="claudeSkillsName">{skill.name}</span>
                            {skill.meta ? <span className="claudeSkillsMeta">{skill.meta}</span> : null}
                          </div>
                        ))}
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
                      <button key={option.value} type="button" className={`agentQuestionOption${option.recommended ? ' recommended' : ''}`} onClick={() => submitPendingAgentAnswer(option.value)}>
                        <span className="agentQuestionOptionHeader">
                          <span className="agentQuestionOptionLabel">{option.label}</span>
                          {option.recommended ? <span className="agentQuestionOptionBadge">Recommended</span> : null}
                        </span>
                        {option.description ? <span className="agentQuestionOptionDescription">{option.description}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {pendingAgentQuestion.allowFreeform ? (
                  <div className="agentQuestionFreeform">
                    <textarea
                      value={pendingAgentQuestion.draft}
                      onChange={(e) => setPendingAgentQuestion((current) => current ? { ...current, draft: e.target.value } : current)}
                      rows={3}
                      placeholder="Type your answer…"
                    />
                    <button
                      type="button"
                      className="primaryAction"
                      onClick={() => submitPendingAgentAnswer(pendingAgentQuestion.draft)}
                      disabled={!pendingAgentQuestion.draft.trim()}
                    >
                      Submit Answer
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="composer">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || isComposing || e.keyCode === 229) {
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                rows={3}
                placeholder={settings.interactionMode === 'claude_cli' ? 'Send input directly to the Claude CLI session…' : settings.interactionMode === 'claude_code' ? 'Describe the next coding step, ask for a refactor, or tell it to continue…' : 'Type here…'}
              />
              <button className="sendBtn" onClick={() => void onSend()} disabled={!canSend}>
                {isStreaming ? 'Streaming…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}