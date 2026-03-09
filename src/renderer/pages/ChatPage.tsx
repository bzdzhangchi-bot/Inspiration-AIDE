import DOMPurify from 'dompurify';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { AgentSessionMessage, ChatMessage, ChatRequest } from '../../shared/types';
import { claudeCodeClient, type ClaudeCodeRuntimeState } from '../claudeCodeClient';
import { checkProviderConnection, openAgentSessionStream, openChatStream } from '../wsClient';
import { fsClient, type ClaudeMemorySnapshot } from '../fsClient';
import { terminalClient, type TerminalCommandResult, type TerminalEvent } from '../terminalClient';
import { WorkspacePanel, type WorkspacePanelContext, type WorkspacePanelHandle } from '../workspace/WorkspacePanel';
import type { ModelProfile } from './SettingsPage';

type Msg = {
  role: 'user' | 'assistant';
  content: string;
};

const MessageList = memo(function MessageList({ messages }: { messages: Msg[] }) {
  return (
    <div>
      {messages.map((m, idx) => (
        <div key={idx} className={`msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
          <div className="meta">
            <div>{m.role}</div>
          </div>
          <div className="bubble"><ChatBubbleContent content={m.content} renderMarkdown={m.role === 'assistant'} /></div>
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
  allowFreeform: boolean;
  draft: string;
};

type ClaudeSkillItem = {
  key: string;
  name: string;
  source: 'workspace' | 'runtime';
  meta?: string;
  path?: string;
};

type SessionHistoryItem = {
  profileId: string;
  profileName: string;
  updatedAt: number;
  messageCount: number;
  lastUserText: string;
  lastAssistantText: string;
};

type ClaudeMemoryGroup = {
  key: string;
  title: string;
  items: ClaudeMemorySnapshot['instructionFiles'];
  emptyText: string;
};

type InspectorSection = 'overview' | 'memory' | 'skills' | 'model-input' | 'tooling';
type ClaudeInspectorFile = ClaudeMemorySnapshot['instructionFiles'][number];
type ClaudeInspectorTimelineItem = {
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
  isError?: boolean;
};
type NativeAgentInspectorSnapshot = {
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

type AssistantLayoutMode = 'collab' | 'immersive';

const EMPTY_THREAD: Msg[] = [];
const THREAD_PERSIST_DEBOUNCE_MS = 240;
const MAX_NATIVE_MEMORY_ITEMS = 10;
const MAX_NATIVE_MEMORY_PREVIEW_CHARS = 420;
const MAX_NATIVE_MEMORY_QUERY_TERMS = 18;
const ASSISTANT_LAYOUT_MODE_STORAGE_KEY = 'assistantLayoutMode';

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

function scoreNativeMemoryItem(item: ClaudeMemorySnapshot['instructionFiles'][number], searchTerms: string[]) {
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

function buildNativeAgentMemoryContext(snapshot: ClaudeMemorySnapshot | null, focusText: string, workspaceSummary: string) {
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
  /^[|\\/-]{2,}$/,
  /^\s*thinking\s*$/i,
  /^press (enter|return|y|n)/i,
  /^use arrow keys/i,
  /^\(y\/n\)/i,
  /^\[[A-Z0-9_;?]+\]$/
];

const CLI_VISUAL_NOISE_CHARS = /[·•●◦○✳✶✻✽✢…⋯⠁-⣿]/g;
const CLI_PROMPT_PREFIX_PATTERN = /^[❯>$#▪•*]+\s*/u;
const CLI_STARTUP_NOISE_KEYS = [
  'recentactivity',
  'norecentactivity',
  'apiusagebilling',
  'debugmodeenabled',
  'loggingto',
  'modeltotry',
  'tipsforgettingstarted',
  'welcomeback',
  'claudecodev',
  'mediummodel',
  '/inittocreateaclaude.mdfilewithinstructionsforclaude'
];

function isCliVisualNoiseLine(value: string) {
  const line = value.trim();
  if (!line) return false;

  const compact = line.replace(/\s+/g, '');
  if (!compact) return false;

  if (/^[·•●◦○✳✶✻✽✢…⋯⠁-⣿]+$/u.test(compact)) {
    return true;
  }

  const symbolMatches = compact.match(CLI_VISUAL_NOISE_CHARS) ?? [];
  if (symbolMatches.length === 0) {
    return false;
  }

  const withoutNoiseChars = compact.replace(CLI_VISUAL_NOISE_CHARS, '');
  if (!withoutNoiseChars) {
    return true;
  }

  const asciiLetters = withoutNoiseChars.match(/[a-z]/gi) ?? [];
  const digits = withoutNoiseChars.match(/\d/g) ?? [];
  const cjkChars = withoutNoiseChars.match(/[\u3400-\u9fff]/g) ?? [];
  const punctuationOnly = withoutNoiseChars.replace(/[._,;:!?()[\]{}'"`~-]/g, '');

  if (cjkChars.length > 0) {
    return false;
  }

  return symbolMatches.length >= 2 && asciiLetters.length <= 4 && digits.length === 0 && punctuationOnly.length <= 4;
}

function sanitizeCliText(value: string) {
  const withoutControlChars = [...applyBackspaces(stripAnsiSequences(value))]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 || char === '\n' || char === '\r' || char === '\t';
    })
    .join('');

  return withoutControlChars
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function normalizeCliLines(value: string) {
  return sanitizeCliText(value)
    .split('\n')
    .map((line) => line.replace(/\t/g, '  ').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isCliVisualNoiseLine(line))
    .filter((line) => !CLI_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}

function normalizeCliSingleLine(value: string) {
  const lines = normalizeCliLines(value);
  if (!lines.length) return '';
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function toCliComparableText(value: string) {
  return value
    .replace(CLI_PROMPT_PREFIX_PATTERN, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function isCliPromptEchoLine(line: string, promptText: string) {
  const promptComparable = toCliComparableText(promptText);
  if (!promptComparable) return false;
  return toCliComparableText(line) === promptComparable;
}

function isCliStartupNoiseLine(value: string) {
  const compact = value.replace(/\s+/g, '').toLowerCase();
  if (!compact) return false;
  return CLI_STARTUP_NOISE_KEYS.some((key) => compact.includes(key));
}

function toCompactComparableText(value: string) {
  return value.replace(/\s+/g, '').trim().toLowerCase();
}

function getWorkspacePathVariants(workspaceRoot: string | null) {
  if (!workspaceRoot) return [] as string[];

  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const variants = [normalizedRoot];
  const homeMatch = /^(\/Users\/[^/]+)(\/.*)$/.exec(normalizedRoot);
  if (homeMatch) {
    variants.push(`~${homeMatch[2]}`);
  }
  return variants;
}

function isCliWorkspaceBannerLine(line: string, workspaceRoot: string | null) {
  const compactLine = toCompactComparableText(line);
  if (!compactLine) return false;
  return getWorkspacePathVariants(workspaceRoot)
    .map(toCompactComparableText)
    .some((variant) => variant === compactLine);
}

function isCliModelBannerLine(line: string) {
  const compactLine = toCompactComparableText(line);
  return /^(small|medium|large|opus|sonnet|haiku|gpt[-.0-9a-z]*)\/model$/i.test(compactLine);
}

function isCliAnswerLikeLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const compact = toCompactComparableText(trimmed);
  if (!compact) return false;

  const cjkChars = trimmed.match(/[\u3400-\u9fff]/g) ?? [];
  if (cjkChars.length >= 2) {
    return true;
  }

  const latinWords = trimmed.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  if (latinWords.length >= 3) {
    return true;
  }

  if (latinWords.length >= 1 && /[.!?。！？：:]/.test(trimmed) && compact.length >= 6) {
    return true;
  }

  if (/^[-*]\s+/.test(trimmed) && compact.length >= 4) {
    return true;
  }

  if (/^\d+\.\s+/.test(trimmed) && compact.length >= 4) {
    return true;
  }

  return false;
}

function hasCliAnswerLikeContent(value: string) {
  return normalizeCliLines(value).some((line) => isCliAnswerLikeLine(line));
}

function sliceCliLinesAfterPromptEcho(lines: string[], promptText: string) {
  const lastPromptIndex = lines.reduce((foundIndex, line, index) => (
    isCliPromptEchoLine(line, promptText) ? index : foundIndex
  ), -1);

  return lastPromptIndex >= 0 ? lines.slice(lastPromptIndex + 1) : lines;
}

function isMeaningfulClaudeReplyLine(value: string, workspaceRoot: string | null) {
  const line = value.trim();
  if (!line) return false;
  if (isCliVisualNoiseLine(line)) return false;
  if (isCliStartupNoiseLine(line)) return false;
  if (isCliWorkspaceBannerLine(line, workspaceRoot)) return false;
  if (isCliModelBannerLine(line)) return false;
  if (line.startsWith('[user] ')) return false;
  if (/^\[debug\]/i.test(line)) return false;
  if (/^user prompt sent:/i.test(line)) return false;
  if (/^interrupt requested/i.test(line)) return false;
  if (/^started claude code session$/i.test(line)) return false;
  if (/^restarted claude code session$/i.test(line)) return false;
  if (/^restored claude runtime state/i.test(line)) return false;
  return !CLI_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function extractClaudeCliTurnTail(rawTail: string, turnStartSnapshot: string) {
  if (!turnStartSnapshot) return rawTail;
  if (rawTail.startsWith(turnStartSnapshot)) {
    return rawTail.slice(turnStartSnapshot.length);
  }

  const lastUserMarker = rawTail.lastIndexOf('\n[user] ');
  if (lastUserMarker >= 0) {
    return rawTail.slice(lastUserMarker);
  }

  return rawTail;
}

function dedupeAdjacentLines(lines: string[]) {
  return lines.filter((line, index, all) => index === 0 || line !== all[index - 1]);
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

function buildClaudeCliReplyFromRuntime(state: ClaudeCodeRuntimeState, turnStartedAt: number, turnStartSnapshot: string, promptText: string) {
  const normalizedPrompt = normalizeCliSingleLine(promptText).toLowerCase();
  const rawTurnLines = sliceCliLinesAfterPromptEcho(
    normalizeCliLines(extractClaudeCliTurnTail(state.rawTail, turnStartSnapshot)),
    promptText
  )
    .filter((line) => isMeaningfulClaudeReplyLine(line, state.workspaceRoot))
    .filter((line) => !isCliPromptEchoLine(line, promptText))
    .filter((line) => !normalizedPrompt || line.toLowerCase() !== normalizedPrompt)
    .slice(-24);

  const modelLines = dedupeAdjacentLines(rawTurnLines);
  if (modelLines.length) {
    return modelLines.join('\n');
  }

  const eventLines = state.events
    .filter((event) => event.createdAt >= turnStartedAt)
    .filter((event) => event.kind === 'message' || event.kind === 'question' || event.kind === 'approval' || event.kind === 'plan')
    .flatMap((event) => normalizeCliLines(event.text.replace(/^\[debug\]\s*/i, '')))
    .filter((line) => !isCliPromptEchoLine(line, promptText))
    .filter((line) => isMeaningfulClaudeReplyLine(line, state.workspaceRoot))
    .filter((line) => !normalizedPrompt || line.toLowerCase() !== normalizedPrompt)
    .slice(-16);

  return dedupeAdjacentLines(eventLines).join('\n');
}

function formatTimestamp(value: number) {
  return new Date(value).toLocaleString();
}

export function ChatPage(props: {
  settings: ChatSettings;
  profiles: ModelProfile[];
  activeProfileId: string;
  onSelectProfile: (profileId: string) => void;
  onOpenGitPage: () => void;
  isDrawerOpen: boolean;
  onToggleDrawer: () => void;
  onRunCommandInTerminal: (command: string, timeoutMs?: number) => Promise<TerminalCommandResult>;
  onInterruptAgentRun: () => Promise<void>;
  onSendPromptToClaudeCli: (prompt: string) => Promise<void>;
  onInterruptClaudeCli: () => Promise<void>;
}) {
  const { settings, profiles, activeProfileId, onOpenGitPage, onSelectProfile, isDrawerOpen, onToggleDrawer, onRunCommandInTerminal, onInterruptAgentRun, onSendPromptToClaudeCli } = props;

  const workspacePanelRef = useRef<WorkspacePanelHandle | null>(null);
  const drawerWidthRef = useRef(420);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [input, setInput] = useState('');
  const [threadStore, setThreadStore] = useState<ThreadStore>(() => loadStoredThreadState(profiles));
  const [isStreaming, setIsStreaming] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(420);
  const [layoutMode, setLayoutMode] = useState<AssistantLayoutMode>(() => {
    const raw = localStorage.getItem(ASSISTANT_LAYOUT_MODE_STORAGE_KEY);
    return raw === 'immersive' ? 'immersive' : 'collab';
  });
  const [immersiveWorkspaceOpen, setImmersiveWorkspaceOpen] = useState(false);
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
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [inspectorSection, setInspectorSection] = useState<InspectorSection>('overview');
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [memorySnapshot, setMemorySnapshot] = useState<ClaudeMemorySnapshot | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryRefreshTick, setMemoryRefreshTick] = useState(0);
  const [selectedInspectorFile, setSelectedInspectorFile] = useState<ClaudeInspectorFile | null>(null);
  const [selectedInspectorFileContent, setSelectedInspectorFileContent] = useState('');
  const [selectedInspectorFileLoading, setSelectedInspectorFileLoading] = useState(false);
  const [selectedInspectorFileError, setSelectedInspectorFileError] = useState<string | null>(null);
  const [selectedInspectorSkill, setSelectedInspectorSkill] = useState<ClaudeSkillItem | null>(null);
  const [selectedInspectorSkillContent, setSelectedInspectorSkillContent] = useState('');
  const [selectedInspectorSkillLoading, setSelectedInspectorSkillLoading] = useState(false);
  const [selectedInspectorSkillError, setSelectedInspectorSkillError] = useState<string | null>(null);
  const [nativeAgentInspectorSnapshot, setNativeAgentInspectorSnapshot] = useState<NativeAgentInspectorSnapshot | null>(null);
  const [pendingAgentQuestion, setPendingAgentQuestion] = useState<PendingAgentQuestion | null>(null);
  const [profileSwitchNotice, setProfileSwitchNotice] = useState<string | null>(null);
  const activeStreamRef = useRef<{ close: () => void } | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const profileSwitchNoticeTimerRef = useRef<number | null>(null);
  const agentCancelRequestedRef = useRef(false);
  const agentProgressRef = useRef<string[]>([]);
  const agentRunActiveRef = useRef(false);
  const pendingAgentQuestionResolveRef = useRef<((answer: string) => void) | null>(null);
  const pendingAgentQuestionRejectRef = useRef<((error: Error) => void) | null>(null);
  const claudeCliTurnStartedAtRef = useRef<number | null>(null);
  const claudeCliPendingReplyRef = useRef(false);
  const claudeCliTurnRawTailSnapshotRef = useRef('');
  const claudeCliPromptTextRef = useRef('');
  const claudeCliIdleTimerRef = useRef<number | null>(null);
  const claudeCliSawVisibleReplyRef = useRef(false);
  const claudeCliBufferedReplyRef = useRef('');
  const lastMirroredTerminalInputRef = useRef<{ text: string; at: number } | null>(null);
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

  function clearClaudeCliIdleTimer() {
    if (claudeCliIdleTimerRef.current === null) return;
    window.clearTimeout(claudeCliIdleTimerRef.current);
    claudeCliIdleTimerRef.current = null;
  }

  function resetClaudeCliTurnTracking() {
    clearClaudeCliIdleTimer();
    claudeCliTurnStartedAtRef.current = null;
    claudeCliPendingReplyRef.current = false;
    claudeCliTurnRawTailSnapshotRef.current = '';
    claudeCliPromptTextRef.current = '';
    claudeCliSawVisibleReplyRef.current = false;
    claudeCliBufferedReplyRef.current = '';
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

  function beginClaudeCliTurn(promptText: string) {
    clearClaudeCliIdleTimer();
    claudeCliTurnStartedAtRef.current = Date.now();
    claudeCliPendingReplyRef.current = true;
    claudeCliTurnRawTailSnapshotRef.current = claudeRuntimeState.rawTail;
    claudeCliPromptTextRef.current = promptText;
    claudeCliSawVisibleReplyRef.current = false;
    claudeCliBufferedReplyRef.current = '';
  }

  const messages = threadsByProfile[activeProfileId] ?? EMPTY_THREAD;
  const activeThreadUpdatedAt = threadUpdatedAtByProfile[activeProfileId] ?? 0;
  const isClaudeCliMode = settings.interactionMode === 'claude_cli';
  const isNativeAgentMode = settings.interactionMode === 'claude_code';

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
      clearClaudeCliIdleTimer();
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
    resetClaudeCliTurnTracking();
    lastMirroredTerminalInputRef.current = null;
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

    const off = claudeCodeClient.subscribe(setClaudeRuntimeState);
    return () => {
      off();
    };
  }, [settings.interactionMode]);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli') {
      lastMirroredTerminalInputRef.current = null;
      return;
    }

    const off = terminalClient.onEvent((event: TerminalEvent) => {
      if (event.type !== 'input-line') return;
      if (event.source !== 'terminal') return;
      if (!claudeRuntimeState.sessionId || event.sessionId !== claudeRuntimeState.sessionId) return;

      const text = normalizeCliSingleLine(event.text);
      if (!text) return;

      const now = Date.now();
      const last = lastMirroredTerminalInputRef.current;
      if (last && last.text === text && now - last.at < 2500) {
        return;
      }
      lastMirroredTerminalInputRef.current = { text, at: now };

      beginClaudeCliTurn(text);
      setCurrentMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: 'Claude is processing your request...' }]);
    });

    return () => {
      off();
    };
  }, [claudeRuntimeState.sessionId, settings.interactionMode]);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli') {
      resetClaudeCliTurnTracking();
      return;
    }
    if (!claudeCliPendingReplyRef.current) return;
    const startedAt = claudeCliTurnStartedAtRef.current;
    if (!startedAt) return;

    const nextContent = buildClaudeCliReplyFromRuntime(
      claudeRuntimeState,
      startedAt,
      claudeCliTurnRawTailSnapshotRef.current,
      claudeCliPromptTextRef.current
    );
    const hasAnswerLikeContent = nextContent ? hasCliAnswerLikeContent(nextContent) : false;
    if (nextContent && hasAnswerLikeContent) {
      claudeCliSawVisibleReplyRef.current = true;
      claudeCliBufferedReplyRef.current = nextContent;
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
    }

    if (!claudeCliSawVisibleReplyRef.current) return;

    clearClaudeCliIdleTimer();
    claudeCliIdleTimerRef.current = window.setTimeout(() => {
      const finalReply = claudeCliBufferedReplyRef.current.trim();
      if (finalReply && hasCliAnswerLikeContent(finalReply)) {
        setCurrentMessages((prev) => {
          if (prev.length === 0) return prev;
          const lastIndex = prev.length - 1;
          const last = prev[lastIndex];
          if (last.role !== 'assistant') {
            return [...prev, { role: 'assistant', content: finalReply }];
          }
          if (last.content === finalReply) {
            return prev;
          }
          const next = [...prev];
          next[lastIndex] = { role: 'assistant', content: finalReply };
          return next;
        });
      }
      resetClaudeCliTurnTracking();
    }, hasAnswerLikeContent ? 900 : 1400);
  }, [claudeRuntimeState.rawTail, claudeRuntimeState.events, settings.interactionMode]);

  useEffect(() => {
    if (settings.interactionMode !== 'claude_cli' && settings.interactionMode !== 'claude_code') {
      setMemorySnapshot(null);
      setMemoryLoading(false);
      setMemoryError(null);
      return;
    }

    const workspaceRoot = claudeRuntimeState.workspaceRoot || workspaceContext.workspaceRoot;
    if (!workspaceRoot) {
      setMemorySnapshot(null);
      setMemoryLoading(false);
      setMemoryError('No workspace selected');
      return;
    }

    let cancelled = false;
    setMemoryLoading(true);
    setMemoryError(null);

    void fsClient.getClaudeMemorySnapshot(workspaceRoot)
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
  }, [claudeRuntimeState.workspaceRoot, memoryRefreshTick, settings.interactionMode, workspaceContext.workspaceRoot]);

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
            meta: nextRelativePath,
            path: entry.path
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
    drawerWidthRef.current = drawerWidth;
  }, [drawerWidth]);

  useEffect(() => {
    localStorage.setItem(ASSISTANT_LAYOUT_MODE_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    if (layoutMode === 'immersive' && !isDrawerOpen) {
      onToggleDrawer();
    }
  }, [isDrawerOpen, layoutMode, onToggleDrawer]);

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

  const currentProfileSummary = useMemo(() => {
    return `${settings.name} · ${modeLabelFor(settings.interactionMode)} · ${providerLabelFor(settings.providerId)}`;
  }, [settings]);

  const currentProfileDetail = useMemo(() => {
    if (settings.interactionMode === 'claude_cli') {
      return "Runtime source: local Claude CLI from PATH. Provider and model are managed by the CLI runtime.";
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
    const focusPath = workspaceContext.selectedPath ?? workspaceContext.activePath;
    const focusLabel = workspaceContext.selectedEntryKind === 'dir' ? 'Selected folder' : 'Open file';
    const lines = [
      `Workspace root: ${workspaceContext.workspaceRoot}`,
      `Workspace scope: ${workspaceContext.workspaceScopePath ?? workspaceContext.workspaceRoot}`,
      `${focusLabel}: ${focusPath ?? 'None'}`,
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

  function captureNativeAgentInspectorSnapshot(options: {
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
    const modeInstruction = settings.interactionMode === 'claude_code'
      ? 'Operate like a persistent coding agent in an ongoing workspace session. Maintain continuity across turns, continue prior plans without restating everything, prefer concrete next actions, and stay focused on editing, running, and validating project work.'
      : 'You are operating inside a desktop workspace editor. Use the provided workspace context to reason about the current project. When proposing file changes, reference concrete file paths and explain the intended edits clearly.';

    const contextPrefix: ChatMessage[] = [{ role: 'system', content: modeInstruction }];

    if (settings.interactionMode === 'claude_code' && nativeMemoryContext) {
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
      'For non-trivial requests with multiple valid approaches, ask the user to choose a plan before executing. Use ask_user kind=plan with 2 to 4 options and short tradeoffs.',
      'When there is an actual decision to make or multiple valid paths, use ask_user with concise choices instead of guessing.',
      'Prefer inspecting the workspace before editing, prefer targeted patches over full rewrites, and run validation commands when they are relevant.',
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

    return [toolInstruction, ...buildChatMessages(baseMessages, nativeMemoryContext)];
  }

  async function requestAgentTurn(reqMessages: AgentSessionMessage[], systemPrompt: string) {
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
    const nativeMemoryContext = buildNativeAgentMemoryContext(memorySnapshot, outgoingText, workspaceSummary);
    const systemPrompt = buildAgentSystemPrompt(nativeMemoryContext);
    const progress: string[] = ['Agent: planning…'];
    const toolEvents: NativeAgentToolEvent[] = [];
    agentProgressRef.current = [...progress];
    setAgentProgressLines([...progress]);
    appendAgentProgress(`Agent session: provider=${settings.providerId}`);

    setCurrentMessages(visiblePrefix);

    for (let step = 0; step < 8; step += 1) {
      assertAgentNotCancelled();
      captureNativeAgentInspectorSnapshot({
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
      const turn = await requestAgentTurn(agentMessages, systemPrompt);
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
        captureNativeAgentInspectorSnapshot({
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

        toolEvents.push({
          id: `${toolUse.id}:request`,
          tool: toolUse.name,
          phase: 'request',
          summary,
          detail: JSON.stringify(toolUse.input, null, 2)
        });

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
        toolEvents.push({
          id: `${toolUse.id}:result`,
          tool: toolUse.name,
          phase: 'result',
          summary: `Result: ${toolUse.name}`,
          detail: displayToolResult,
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
    const stoppedContent = `${progress.join('\n\n')}\n\nAgent stopped after reaching the step limit.`;
    captureNativeAgentInspectorSnapshot({
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
    setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: stoppedContent }]);
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
    const nativeMemoryContext = buildNativeAgentMemoryContext(memorySnapshot, outgoingText, workspaceSummary);
    const progress: string[] = ['Agent: planning…'];
    const toolEvents: NativeAgentToolEvent[] = [];
    agentProgressRef.current = [...progress];
    setAgentProgressLines([...progress]);

    setCurrentMessages(visiblePrefix);

    for (let step = 0; step < 8; step += 1) {
      assertAgentNotCancelled();
      const reqMessages = buildAgentMessages(agentMessages, nativeMemoryContext);
      captureNativeAgentInspectorSnapshot({
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
      const responseText = await requestModelText(reqMessages);
      assertAgentNotCancelled();
      const action = parseAgentAction(responseText);

      if (!action) {
        agentRunActiveRef.current = false;
        captureNativeAgentInspectorSnapshot({
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
          lastResponse: responseText.trim() || 'Agent returned an empty response.'
        });
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: responseText.trim() || 'Agent returned an empty response.' }]);
        return;
      }

      if (action.type === 'final') {
        agentRunActiveRef.current = false;
        const finalContent = progress.length > 1
          ? `${action.message.trim()}\n\n---\n${progress.join('\n')}`
          : action.message.trim();
        captureNativeAgentInspectorSnapshot({
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
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: finalContent || 'Done.' }]);
        return;
      }

      const summary = `Agent tool: ${summarizeAgentAction(action)}`;
      toolEvents.push({
        id: `legacy-${step}:request`,
        tool: action.tool,
        phase: 'request',
        summary,
        detail: JSON.stringify(action.args, null, 2)
      });
      progress.push(summary);
      appendAgentProgress(summary);
      updateAgentPlaceholder(outgoingText, `Agent: ${summary}`);

      const toolResult = await executeAgentTool(action);

      assertAgentNotCancelled();

      const displayToolResult = toolResult.length > 1200 ? `${toolResult.slice(0, 1200)}\n...[truncated]` : toolResult;
      toolEvents.push({
        id: `legacy-${step}:result`,
        tool: action.tool,
        phase: 'result',
        summary: `Result: ${action.tool}`,
        detail: displayToolResult,
        isError: /status:\s*failed/i.test(toolResult)
      });
      progress.push(displayToolResult);
      appendAgentProgress(displayToolResult);
      updateAgentPlaceholder(outgoingText, 'Agent: planning next step…');

      agentMessages.push({ role: 'assistant', content: JSON.stringify(action) });
      agentMessages.push({ role: 'user', content: toolResult });
    }

    agentRunActiveRef.current = false;
    const stoppedContent = `${progress.join('\n\n')}\n\nAgent stopped after reaching the step limit.`;
    captureNativeAgentInspectorSnapshot({
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
    setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: stoppedContent }]);
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
        beginClaudeCliTurn(outgoingText);
        setCurrentMessages([...messages, { role: 'user', content: outgoingText }, { role: 'assistant', content: 'Claude is processing your request...' }]);
        await onSendPromptToClaudeCli(outgoingText);
      } catch (error) {
        resetClaudeCliTurnTracking();
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
    dropPendingThreadPersist(activeProfileId);
    setCurrentMessages([]);
    localStorage.removeItem(storageKey(activeProfileId));
    localStorage.removeItem(historyMetaKey(activeProfileId));
    resetAgentRunState();
  }

  const showAgentPlanningPanel = settings.interactionMode === 'claude_code' && isStreaming;
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
  const memoryInstructionGroups = useMemo<ClaudeMemoryGroup[]>(() => {
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
  const recentMemoryTimeline = useMemo<ClaudeInspectorTimelineItem[]>(() => {
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
  const claudeContextSummaryLines = useMemo(() => {
    const lines = [
      `Workspace: ${claudeRuntimeState.workspaceRoot ?? workspaceContext.workspaceRoot ?? 'Not selected'}`,
      `Runtime: ${claudeRuntimeState.connected ? (claudeRuntimeState.running ? 'Connected and running' : 'Connected and idle') : 'No active Claude CLI session'}`,
      `Memory: ${memorySnapshot ? `${memorySnapshot.instructionFiles.length} instruction files, ${memorySnapshot.autoMemoryFiles.length} auto memory files, auto memory ${memorySnapshot.autoMemoryEnabled ? 'enabled' : 'disabled'}` : 'Memory snapshot unavailable'}`,
      `Skills: ${claudeSkills.length ? claudeSkills.slice(0, 4).map((item) => item.name).join(', ') : 'No skills discovered yet'}`
    ];

    if (claudeRuntimeState.pendingApproval) {
      lines.push(`Approval pending: ${claudeRuntimeState.pendingApproval}`);
    } else if (claudeRuntimeState.pendingQuestion) {
      lines.push(`Question pending: ${claudeRuntimeState.pendingQuestion}`);
    } else if (claudeRuntimeState.lastPlan.length) {
      lines.push(`Latest plan: ${claudeRuntimeState.lastPlan.slice(0, 2).join(' | ')}`);
    }

    if (claudeRuntimeState.resumeInfo.restoredFromStorage) {
      lines.push(`Resume state restored${snapshotSavedAtText ? ` from snapshot saved at ${snapshotSavedAtText}` : ''}`);
    }

    return lines;
  }, [claudeRuntimeState.connected, claudeRuntimeState.lastPlan, claudeRuntimeState.pendingApproval, claudeRuntimeState.pendingQuestion, claudeRuntimeState.resumeInfo.restoredFromStorage, claudeRuntimeState.running, claudeRuntimeState.workspaceRoot, claudeSkills, memorySnapshot, snapshotSavedAtText, workspaceContext.workspaceRoot]);
  const nativeAgentSnapshotUpdatedAtText = useMemo(() => {
    return nativeAgentInspectorSnapshot ? formatTimestamp(nativeAgentInspectorSnapshot.updatedAt) : null;
  }, [nativeAgentInspectorSnapshot]);
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
  }, [agentProgressLines, isStreaming, memorySnapshot, nativeAgentInspectorSnapshot, nativeAgentSnapshotUpdatedAtText, settings.model, settings.providerId, workspaceContext.workspaceRoot]);
  const inspectorTitle = isNativeAgentMode ? 'Native Agent Inspector' : 'Claude Inspector';
  const inspectorSubtitle = isNativeAgentMode
    ? 'Inspect Native Agent memory, assembled model inputs, and recent run activity.'
    : 'Unified runtime, memory, and skills view for the current Claude CLI workspace.';

  async function previewInspectorFile(item: ClaudeInspectorFile) {
    const workspaceRoot = claudeRuntimeState.workspaceRoot || workspaceContext.workspaceRoot || null;
    setSelectedInspectorFile(item);
    setSelectedInspectorFileLoading(true);
    setSelectedInspectorFileError(null);
    try {
      const contents = await fsClient.readClaudeMemoryFile(item.path, workspaceRoot);
      setSelectedInspectorFileContent(contents);
      setSelectedInspectorFileLoading(false);
    } catch (error) {
      setSelectedInspectorFileContent('');
      setSelectedInspectorFileLoading(false);
      setSelectedInspectorFileError(error instanceof Error ? error.message : 'Unable to read file');
    }
  }

  async function revealInspectorFile(item: ClaudeInspectorFile) {
    const workspaceRoot = claudeRuntimeState.workspaceRoot || workspaceContext.workspaceRoot || null;
    await fsClient.revealClaudePath(item.path, workspaceRoot);
  }

  async function openInspectorSource(item: ClaudeInspectorFile) {
    const opened = await workspacePanelRef.current?.openWorkspaceFile(item.path, { reveal: true });
    if (opened) {
      closeInspectorDrawer();
      return;
    }
    await previewInspectorFile(item);
  }

  async function previewInspectorSkill(skill: ClaudeSkillItem) {
    setSelectedInspectorSkill(skill);
    setSelectedInspectorSkillError(null);
    if (!skill.path) {
      setSelectedInspectorSkillLoading(false);
      setSelectedInspectorSkillContent(skill.meta ? `${skill.name}\n\n${skill.meta}` : skill.name);
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

  async function openInspectorSkillSource(skill: ClaudeSkillItem) {
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

  async function revealInspectorSkillSource(skill: ClaudeSkillItem) {
    if (!skill.path) return;
    const revealed = await workspacePanelRef.current?.revealWorkspaceFile(skill.path);
    if (revealed) return;
    await fsClient.revealClaudePath(skill.path, claudeRuntimeState.workspaceRoot || workspaceContext.workspaceRoot || null);
  }

  function renderInspectorMemoryItem(item: ClaudeInspectorFile) {
    return (
      <div key={item.id} className="claudeMemoryItem">
        <button type="button" className="claudeMemoryItemBody" onClick={() => void previewInspectorFile(item)}>
          <div className="claudeMemoryItemTop">
            <span className={`claudeMemoryBadge scope-${item.scope}`}>{item.scope}</span>
            <span className={`claudeMemoryBadge kind-${item.kind}`}>{item.kind}</span>
          </div>
          <div className="claudeMemoryItemTitle">{item.relativePath}</div>
          <div className="claudeMemoryMeta">{item.displayPath}</div>
          <div className="claudeMemoryMeta">{item.lineCount} lines · updated {formatTimestamp(item.updatedAt)}</div>
          {item.preview ? <pre className="claudeMemoryPreview">{item.preview}</pre> : <div className="claudeMemoryMeta">Empty file</div>}
        </button>
        <div className="claudeMemoryItemActions">
          <button type="button" className="claudeMemoryActionButton" onClick={() => void previewInspectorFile(item)}>View</button>
          <button type="button" className="claudeMemoryActionButton" onClick={() => void openInspectorSource(item)}>
            {isPathInside(workspaceContext.workspaceRoot, item.path) ? 'Open' : 'Preview'}
          </button>
          <button type="button" className="claudeMemoryActionButton" onClick={() => void revealInspectorFile(item)}>Reveal</button>
        </div>
      </div>
    );
  }

  function openHistoryDrawer() {
    setInspectorDrawerOpen(false);
    setHistoryDrawerOpen(true);
  }

  function closeHistoryDrawer() {
    setHistoryDrawerOpen(false);
  }

  function openInspectorDrawer(section: InspectorSection = 'overview') {
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
    />
  );

  const isImmersiveMode = layoutMode === 'immersive';
  const assistantVisible = isImmersiveMode || isDrawerOpen;

  return (
    <div className="page chatPage">
      <div className={isImmersiveMode ? 'workspaceWithDrawer immersiveMode' : 'workspaceWithDrawer collabMode'}>
        {!isImmersiveMode ? (
          <div className="workspaceMain">
            {workspacePanel}
          </div>
        ) : null}

        <div
          className={isImmersiveMode ? 'chatImmersiveMain' : assistantVisible ? 'chatDrawer open' : 'chatDrawer'}
          style={!isImmersiveMode && assistantVisible ? { width: `${drawerWidth}px` } : undefined}
        >
          {!isImmersiveMode ? (
            <div
              className="chatResizeHandle"
              onPointerDown={(ev) => {
                dragStateRef.current = { startX: ev.clientX, startWidth: drawerWidthRef.current };
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'col-resize';
              }}
            />
          ) : null}
          <div
            className={isImmersiveMode ? 'chatCard immersive' : 'chatCard'}
          >
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
                  <div className="assistantLayoutToggle" role="tablist" aria-label="Inspiration layout mode">
                    <button type="button" className={layoutMode === 'collab' ? 'active' : ''} onClick={() => setLayoutMode('collab')} aria-pressed={layoutMode === 'collab'}>
                      Collaborate
                    </button>
                    <button type="button" className={layoutMode === 'immersive' ? 'active' : ''} onClick={() => setLayoutMode('immersive')} aria-pressed={layoutMode === 'immersive'}>
                      Immerse
                    </button>
                  </div>
                </div>
                <div className="chatHeaderActionButtons">
                  {isImmersiveMode ? (
                    <button type="button" className={immersiveWorkspaceOpen ? 'secondaryButton is-active' : 'secondaryButton'} onClick={() => setImmersiveWorkspaceOpen((value) => !value)}>
                      {immersiveWorkspaceOpen ? 'Hide Workspace' : 'Show Workspace'}
                    </button>
                  ) : null}
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
                  <div className="claudeInspectorPanel">
                    <div className="claudeInspectorHeader">
                      <div>
                        <div className="cardTitle">{inspectorTitle}</div>
                        <div className="claudeMemoryMeta">{inspectorSubtitle}</div>
                      </div>
                      <div className="claudeInspectorActions">
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

                    <div className="claudeInspectorTabs" role="tablist" aria-label="Native Agent inspector sections">
                      <button type="button" className={inspectorSection === 'overview' ? 'claudeInspectorTab active' : 'claudeInspectorTab'} onClick={() => setInspectorSection('overview')}>
                        Overview
                      </button>
                      <button type="button" className={inspectorSection === 'memory' ? 'claudeInspectorTab active' : 'claudeInspectorTab'} onClick={() => setInspectorSection('memory')}>
                        Memory
                      </button>
                      <button type="button" className={inspectorSection === 'model-input' ? 'claudeInspectorTab active' : 'claudeInspectorTab'} onClick={() => setInspectorSection('model-input')}>
                        Model Input
                      </button>
                      <button type="button" className={inspectorSection === 'tooling' ? 'claudeInspectorTab active' : 'claudeInspectorTab'} onClick={() => setInspectorSection('tooling')}>
                        Tooling
                      </button>
                    </div>

                    {inspectorSection === 'overview' ? (
                      <div className="claudeInspectorBody">
                        <div className="claudeInspectorSummaryGrid">
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Session</span>
                            <span className="claudeMemorySummaryValue">{isStreaming ? 'Running' : 'Idle'}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Request Mode</span>
                            <span className="claudeMemorySummaryValue">{nativeAgentInspectorSnapshot?.requestMode ?? 'Not run yet'}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Instruction files</span>
                            <span className="claudeMemorySummaryValue">{memorySnapshot?.instructionFiles.length ?? 0}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Auto memory files</span>
                            <span className="claudeMemorySummaryValue">{memorySnapshot?.autoMemoryFiles.length ?? 0}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Progress lines</span>
                            <span className="claudeMemorySummaryValue">{(nativeAgentInspectorSnapshot?.progressLines.length ?? agentProgressLines.length) || 0}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Tool events</span>
                            <span className="claudeMemorySummaryValue">{nativeAgentInspectorSnapshot?.toolEvents.length ?? 0}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Last updated</span>
                            <span className="claudeMemorySummaryValue">{nativeAgentSnapshotUpdatedAtText ?? 'Not available'}</span>
                          </div>
                        </div>

                        <div className="claudeInspectorSectionCallout">
                          <div className="cardTitle">Current Context Summary</div>
                          <div className="claudeInspectorSummaryList">
                            {nativeAgentContextSummaryLines.map((line) => (
                              <div key={line} className="claudeInspectorSummaryLine">{line}</div>
                            ))}
                          </div>
                        </div>

                        <div className="claudeInspectorSectionCallout">
                          <div className="cardTitle">Latest Response</div>
                          {nativeAgentInspectorSnapshot?.lastResponse ? (
                            <div className="bubbleRichContent bubbleMarkdownContent">
                              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{nativeAgentInspectorSnapshot.lastResponse}</ReactMarkdown>
                            </div>
                          ) : (
                            <div className="claudeInspectorSectionCalloutMeta">No completed Native Agent response has been recorded yet.</div>
                          )}
                        </div>

                        <div className="claudeInspectorSectionCallout">
                          <div className="cardTitle">Recent Activity</div>
                          {(nativeAgentInspectorSnapshot?.progressLines.length || agentProgressLines.length) ? (
                            <div className="claudeRuntimeList">
                              {(isStreaming ? agentProgressLines : nativeAgentInspectorSnapshot?.progressLines ?? []).slice(-16).map((line, index) => (
                                <div key={`${index}-${line.slice(0, 32)}`} className="claudeRuntimeListItem">{line}</div>
                              ))}
                            </div>
                          ) : (
                            <div className="claudeInspectorSectionCalloutMeta">No Native Agent activity recorded yet.</div>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {inspectorSection === 'memory' ? (
                      <div className="claudeInspectorBody">
                        {memorySnapshot ? (
                          <div className="claudeMemorySummaryGrid">
                            <div className="claudeMemorySummaryCard">
                              <span className="claudeMemorySummaryLabel">Workspace</span>
                              <span className="claudeMemorySummaryValue">{memorySnapshot.workspaceRoot}</span>
                            </div>
                            <div className="claudeMemorySummaryCard">
                              <span className="claudeMemorySummaryLabel">Auto memory</span>
                              <span className="claudeMemorySummaryValue">{memorySnapshot.autoMemoryEnabled ? 'Enabled' : 'Disabled'}</span>
                            </div>
                            <div className="claudeMemorySummaryCard">
                              <span className="claudeMemorySummaryLabel">Memory root</span>
                              <span className="claudeMemorySummaryValue">{memorySnapshot.autoMemoryRoot}</span>
                            </div>
                          </div>
                        ) : null}

                        {memoryError ? <div className="claudeMemoryNotice error">{memoryError}</div> : null}
                        {!memoryError && memoryLoading ? <div className="claudeMemoryNotice">Loading workspace memory…</div> : null}
                        {!memoryError && !memoryLoading && memorySnapshot?.notices.length ? (
                          <div className="claudeMemoryNoticeGroup">
                            {memorySnapshot.notices.map((notice) => (
                              <div key={notice} className="claudeMemoryNotice">{notice}</div>
                            ))}
                          </div>
                        ) : null}

                        {memoryInstructionGroups.map((group) => (
                          <div key={group.key} className="claudeMemorySection">
                            <div className="claudeMemorySectionHeader">
                              <div className="cardTitle">{group.title}</div>
                              <div className="claudeMemoryMeta">{group.items.length} files</div>
                            </div>
                            {group.items.length ? (
                              <div className="claudeMemoryList">
                                {group.items.map((item) => renderInspectorMemoryItem(item))}
                              </div>
                            ) : (
                              <div className="claudeMemoryEmpty">{group.emptyText}</div>
                            )}
                          </div>
                        ))}

                        <div className="claudeMemorySection">
                          <div className="claudeMemorySectionHeader">
                            <div className="cardTitle">Auto Memory</div>
                            <div className="claudeMemoryMeta">{memorySnapshot?.autoMemoryFiles.length ?? 0} files</div>
                          </div>
                          {memorySnapshot?.autoMemoryFiles.length ? (
                            <div className="claudeMemoryList">
                              {memorySnapshot.autoMemoryFiles.map((item) => renderInspectorMemoryItem(item))}
                            </div>
                          ) : (
                            <div className="claudeMemoryEmpty">No auto memory files found yet for this workspace.</div>
                          )}
                        </div>

                        {selectedInspectorFile ? (
                          <div className="claudeInspectorViewer">
                            <div className="claudeInspectorViewerHeader">
                              <div>
                                <div className="cardTitle">{selectedInspectorFile.relativePath}</div>
                                <div className="claudeMemoryMeta">{selectedInspectorFile.displayPath}</div>
                              </div>
                              <div className="claudeInspectorActions">
                                <button type="button" onClick={() => void openInspectorSource(selectedInspectorFile)}>
                                  {isPathInside(workspaceContext.workspaceRoot, selectedInspectorFile.path) ? 'Open in Workspace' : 'Refresh Preview'}
                                </button>
                                <button type="button" onClick={() => void revealInspectorFile(selectedInspectorFile)}>Reveal</button>
                              </div>
                            </div>
                            {selectedInspectorFileError ? <div className="claudeMemoryNotice error">{selectedInspectorFileError}</div> : null}
                            {selectedInspectorFileLoading ? <div className="claudeMemoryNotice">Loading full contents…</div> : null}
                            {!selectedInspectorFileLoading && !selectedInspectorFileError ? (
                              <pre className="claudeInspectorViewerContent">{selectedInspectorFileContent || '(empty file)'}</pre>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {inspectorSection === 'model-input' ? (
                      <div className="claudeInspectorBody">
                        <div className="claudeInspectorSectionCallout">
                          <div className="cardTitle">Prompt</div>
                          <div className="claudeInspectorSectionCalloutMeta">{nativeAgentInspectorSnapshot ? previewText(nativeAgentInspectorSnapshot.outgoingText, 220) : 'No prompt recorded yet.'}</div>
                        </div>

                        <div className="claudeInspectorViewer">
                          <div className="claudeInspectorViewerHeader">
                            <div>
                              <div className="cardTitle">System Prompt</div>
                              <div className="claudeMemoryMeta">Native Agent behavioral instructions plus workspace/session memory.</div>
                            </div>
                          </div>
                          <pre className="claudeInspectorViewerContent">{nativeAgentInspectorSnapshot?.systemPrompt || '(not captured yet)'}</pre>
                        </div>

                        <div className="claudeInspectorViewer">
                          <div className="claudeInspectorViewerHeader">
                            <div>
                              <div className="cardTitle">Memory Context</div>
                              <div className="claudeMemoryMeta">Workspace instruction files and auto memory assembled for Native Agent.</div>
                            </div>
                          </div>
                          <pre className="claudeInspectorViewerContent">{nativeAgentInspectorSnapshot?.memoryContext || '(no workspace memory included)'}</pre>
                        </div>

                        <div className="claudeInspectorViewer">
                          <div className="claudeInspectorViewerHeader">
                            <div>
                              <div className="cardTitle">Assembled Model Payload</div>
                              <div className="claudeMemoryMeta">Exact request body captured before sending the latest Native Agent turn.</div>
                            </div>
                          </div>
                          <pre className="claudeInspectorViewerContent">{nativeAgentInspectorSnapshot?.payload || '(not captured yet)'}</pre>
                        </div>
                      </div>
                    ) : null}

                    {inspectorSection === 'tooling' ? (
                      <div className="claudeInspectorBody">
                        <div className="claudeInspectorSectionCallout">
                          <div className="cardTitle">Tool Calls and Results</div>
                          <div className="claudeInspectorSectionCalloutMeta">Captured request/result pairs from the latest Native Agent run.</div>
                        </div>

                        {nativeAgentInspectorSnapshot?.toolEvents.length ? (
                          <div className="claudeInspectorTimelineList">
                            {nativeAgentInspectorSnapshot.toolEvents.map((event) => (
                              <div key={event.id} className={`claudeInspectorToolEvent${event.isError ? ' isError' : ''}`}>
                                <div className="claudeInspectorTimelineTop">
                                  <span className="claudeInspectorTimelineLabel">{event.summary}</span>
                                  <span className="claudeInspectorToolBadge">{event.phase}</span>
                                </div>
                                <div className="claudeInspectorSectionCalloutMeta">{event.tool}</div>
                                <pre className="claudeInspectorViewerContent">{event.detail}</pre>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="claudeInspectorSectionCalloutMeta">No tool calls captured yet for this Native Agent session.</div>
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
                  <div className="claudeInspectorPanel">
                    <div className="claudeInspectorHeader">
                      <div>
                        <div className="cardTitle">{inspectorTitle}</div>
                        <div className="claudeMemoryMeta">{inspectorSubtitle}</div>
                      </div>
                      <div className="claudeInspectorActions">
                        <button type="button" onClick={() => setShowClaudeCliDetails((v) => !v)}>
                          {showClaudeCliDetails ? 'Hide Details' : 'Show Details'}
                        </button>
                        <button type="button" onClick={() => setClaudeCliMinimalMode((v) => !v)}>
                          {claudeCliMinimalMode ? 'Minimal: On' : 'Minimal: Off'}
                        </button>
                        <button type="button" onClick={() => {
                          setMemoryRefreshTick((value) => value + 1);
                          setSkillsRefreshTick((value) => value + 1);
                        }} disabled={memoryLoading || skillsLoading}>
                          {memoryLoading || skillsLoading ? 'Refreshing…' : 'Refresh'}
                        </button>
                        <button type="button" onClick={closeInspectorDrawer}>Close</button>
                      </div>
                    </div>

                    <div className="claudeInspectorTabs" role="tablist" aria-label="Claude inspector sections">
                      <button type="button" className={inspectorSection === 'overview' ? 'claudeInspectorTab active' : 'claudeInspectorTab'} onClick={() => setInspectorSection('overview')}>
                        Overview
                      </button>
                      <button type="button" className={inspectorSection === 'memory' ? 'claudeInspectorTab active' : 'claudeInspectorTab'} onClick={() => setInspectorSection('memory')}>
                        Memory
                      </button>
                      <button type="button" className={inspectorSection === 'skills' ? 'claudeInspectorTab active' : 'claudeInspectorTab'} onClick={() => setInspectorSection('skills')}>
                        Skills
                      </button>
                    </div>

                    {inspectorSection === 'overview' ? (
                      <div className="claudeInspectorBody">
                        <div className="claudeInspectorSummaryGrid">
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Session</span>
                            <span className="claudeMemorySummaryValue">{claudeRuntimeState.connected ? 'Connected' : 'Inactive'}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Runtime</span>
                            <span className="claudeMemorySummaryValue">{claudeRuntimeState.running ? 'Running' : 'Idle'}</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Events</span>
                            <span className="claudeMemorySummaryValue">{claudeRuntimeState.events.length} recent signals</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Skills</span>
                            <span className="claudeMemorySummaryValue">{claudeSkills.length} discovered</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Instruction files</span>
                            <span className="claudeMemorySummaryValue">{memorySnapshot?.instructionFiles.length ?? 0} loaded sources</span>
                          </div>
                          <div className="claudeMemorySummaryCard">
                            <span className="claudeMemorySummaryLabel">Auto memory files</span>
                            <span className="claudeMemorySummaryValue">{memorySnapshot?.autoMemoryFiles.length ?? 0} notes</span>
                          </div>
                        </div>

                        <div className="claudeInspectorSectionCallout">
                          <div className="cardTitle">Current Context Summary</div>
                          <div className="claudeInspectorSummaryList">
                            {claudeContextSummaryLines.map((line) => (
                              <div key={line} className="claudeInspectorSummaryLine">{line}</div>
                            ))}
                          </div>
                        </div>

                        <div className="claudeInspectorSectionCallout">
                          <div className="cardTitle">Recent Memory Activity</div>
                          {recentMemoryTimeline.length ? (
                            <div className="claudeInspectorTimelineList">
                              {recentMemoryTimeline.map((item) => (
                                <div key={item.id} className="claudeInspectorTimelineItem">
                                  <div className="claudeInspectorTimelineTop">
                                    <span className="claudeInspectorTimelineLabel">{item.label}</span>
                                    <span className="claudeInspectorTimelineTime">{formatTimestamp(item.updatedAt)}</span>
                                  </div>
                                  <div className="claudeInspectorSectionCalloutMeta">{item.meta}</div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="claudeInspectorSectionCalloutMeta">No memory activity detected yet.</div>
                          )}
                        </div>

                        <div className="claudeRuntimePanel">
                          <div className="claudeRuntimeHeader">
                            <div>
                              <div className="cardTitle">Claude Runtime</div>
                              <div className="claudeRuntimeMeta">
                                {claudeRuntimeState.connected ? 'Connected to Claude CLI session' : 'No active Claude CLI session'}
                              </div>
                            </div>
                            <div className="claudeRuntimeHeaderActions">
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

                        {memorySnapshot ? (
                          <div className="claudeInspectorSectionCallout">
                            <div className="cardTitle">Memory Snapshot</div>
                            <div className="claudeMemoryMeta">Auto memory is {memorySnapshot.autoMemoryEnabled ? 'enabled' : 'disabled'} for this workspace.</div>
                            <div className="claudeMemoryMeta">Root: {memorySnapshot.autoMemoryRoot}</div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {inspectorSection === 'memory' ? (
                      <div className="claudeInspectorBody">
                        {memorySnapshot ? (
                          <div className="claudeMemorySummaryGrid">
                            <div className="claudeMemorySummaryCard">
                              <span className="claudeMemorySummaryLabel">Workspace</span>
                              <span className="claudeMemorySummaryValue">{memorySnapshot.workspaceRoot}</span>
                            </div>
                            <div className="claudeMemorySummaryCard">
                              <span className="claudeMemorySummaryLabel">Auto memory</span>
                              <span className="claudeMemorySummaryValue">{memorySnapshot.autoMemoryEnabled ? 'Enabled' : 'Disabled'}</span>
                            </div>
                            <div className="claudeMemorySummaryCard">
                              <span className="claudeMemorySummaryLabel">Memory root</span>
                              <span className="claudeMemorySummaryValue">{memorySnapshot.autoMemoryRoot}</span>
                            </div>
                          </div>
                        ) : null}

                        {memoryError ? <div className="claudeMemoryNotice error">{memoryError}</div> : null}
                        {!memoryError && memoryLoading ? <div className="claudeMemoryNotice">Loading Claude memory…</div> : null}
                        {!memoryError && !memoryLoading && memorySnapshot?.notices.length ? (
                          <div className="claudeMemoryNoticeGroup">
                            {memorySnapshot.notices.map((notice) => (
                              <div key={notice} className="claudeMemoryNotice">{notice}</div>
                            ))}
                          </div>
                        ) : null}

                        {memoryInstructionGroups.map((group) => (
                          <div key={group.key} className="claudeMemorySection">
                            <div className="claudeMemorySectionHeader">
                              <div className="cardTitle">{group.title}</div>
                              <div className="claudeMemoryMeta">{group.items.length} files</div>
                            </div>
                            {group.items.length ? (
                              <div className="claudeMemoryList">
                                {group.items.map((item) => renderInspectorMemoryItem(item))}
                              </div>
                            ) : (
                              <div className="claudeMemoryEmpty">{group.emptyText}</div>
                            )}
                          </div>
                        ))}

                        <div className="claudeMemorySection">
                          <div className="claudeMemorySectionHeader">
                            <div className="cardTitle">Auto Memory</div>
                            <div className="claudeMemoryMeta">{memorySnapshot?.autoMemoryFiles.length ?? 0} files</div>
                          </div>
                          {memorySnapshot?.autoMemoryFiles.length ? (
                            <div className="claudeMemoryList">
                              {memorySnapshot.autoMemoryFiles.map((item) => renderInspectorMemoryItem(item))}
                            </div>
                          ) : (
                            <div className="claudeMemoryEmpty">No auto memory files found yet for this workspace.</div>
                          )}
                        </div>

                        {selectedInspectorFile ? (
                          <div className="claudeInspectorViewer">
                            <div className="claudeInspectorViewerHeader">
                              <div>
                                <div className="cardTitle">{selectedInspectorFile.relativePath}</div>
                                <div className="claudeMemoryMeta">{selectedInspectorFile.displayPath}</div>
                              </div>
                              <div className="claudeInspectorActions">
                                <button type="button" onClick={() => void openInspectorSource(selectedInspectorFile)}>
                                  {isPathInside(workspaceContext.workspaceRoot, selectedInspectorFile.path) ? 'Open in Workspace' : 'Refresh Preview'}
                                </button>
                                <button type="button" onClick={() => void revealInspectorFile(selectedInspectorFile)}>Reveal</button>
                              </div>
                            </div>
                            {selectedInspectorFileError ? <div className="claudeMemoryNotice error">{selectedInspectorFileError}</div> : null}
                            {selectedInspectorFileLoading ? <div className="claudeMemoryNotice">Loading full contents…</div> : null}
                            {!selectedInspectorFileLoading && !selectedInspectorFileError ? (
                              <pre className="claudeInspectorViewerContent">{selectedInspectorFileContent || '(empty file)'}</pre>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {inspectorSection === 'skills' ? (
                      <div className="claudeInspectorBody">
                        <div className="claudeSkillsPanel claudeInspectorEmbeddedPanel">
                          <div className="claudeSkillsHeader">
                            <div>
                              <div className="cardTitle">Claude Code Skills</div>
                              <div className="claudeSkillsMeta">Path: <code>.claude/skills</code></div>
                            </div>
                            <div className="claudeInspectorSectionCalloutMeta">{claudeSkills.length} entries</div>
                          </div>
                          {skillsError ? <div className="claudeSkillsMeta">{skillsError}</div> : null}
                          {!skillsError ? (
                            <div className="claudeSkillsMeta">{claudeSkills.length ? `${claudeSkills.length} skill entries` : 'No skills discovered yet'}</div>
                          ) : null}
                          {claudeSkills.length ? (
                            <div className="claudeSkillsList">
                              {claudeSkills.map((skill) => (
                                <div key={skill.key} className="claudeSkillsItem">
                                  <button type="button" className="claudeSkillsItemBody" onClick={() => void previewInspectorSkill(skill)}>
                                    <span className={`claudeSkillsBadge source-${skill.source}`}>{skill.source}</span>
                                    <span className="claudeSkillsName">{skill.name}</span>
                                    {skill.meta ? <span className="claudeSkillsMeta">{skill.meta}</span> : null}
                                  </button>
                                  <div className="claudeSkillsActions">
                                    <button type="button" className="claudeMemoryActionButton" onClick={() => void previewInspectorSkill(skill)}>View</button>
                                    <button type="button" className="claudeMemoryActionButton" onClick={() => void openInspectorSkillSource(skill)}>
                                      {skill.path ? 'Open' : 'Preview'}
                                    </button>
                                    <button type="button" className="claudeMemoryActionButton" onClick={() => void revealInspectorSkillSource(skill)} disabled={!skill.path}>Reveal</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        {selectedInspectorSkill ? (
                          <div className="claudeInspectorViewer">
                            <div className="claudeInspectorViewerHeader">
                              <div>
                                <div className="cardTitle">{selectedInspectorSkill.name}</div>
                                <div className="claudeMemoryMeta">{selectedInspectorSkill.meta ?? selectedInspectorSkill.source}</div>
                              </div>
                              <div className="claudeInspectorActions">
                                <button type="button" onClick={() => void openInspectorSkillSource(selectedInspectorSkill)}>
                                  {selectedInspectorSkill.path ? 'Open in Workspace' : 'Refresh Preview'}
                                </button>
                                <button type="button" onClick={() => void revealInspectorSkillSource(selectedInspectorSkill)} disabled={!selectedInspectorSkill.path}>Reveal</button>
                              </div>
                            </div>
                            {selectedInspectorSkillError ? <div className="claudeMemoryNotice error">{selectedInspectorSkillError}</div> : null}
                            {selectedInspectorSkillLoading ? <div className="claudeMemoryNotice">Loading full contents…</div> : null}
                            {!selectedInspectorSkillLoading && !selectedInspectorSkillError ? (
                              <pre className="claudeInspectorViewerContent">{selectedInspectorSkillContent || '(empty skill)'}</pre>
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
                placeholder={settings.interactionMode === 'claude_cli' ? 'Send input directly to the Claude CLI session…' : settings.interactionMode === 'claude_code' ? 'Describe the next coding step, ask for a refactor, or tell it to continue…' : 'Type here…'}
              />
              <button className="sendBtn" onClick={() => void onSend()} disabled={!canSend}>
                {isStreaming ? 'Streaming…' : 'Send'}
              </button>
            </div>
          </div>

          {isImmersiveMode ? (
            <>
              <button
                type="button"
                className={immersiveWorkspaceOpen ? 'immersiveWorkspaceBackdrop open' : 'immersiveWorkspaceBackdrop'}
                aria-label="Close workspace context panel"
                onClick={() => setImmersiveWorkspaceOpen(false)}
              />
              <aside className={immersiveWorkspaceOpen ? 'immersiveWorkspacePanel open' : 'immersiveWorkspacePanel'}>
                <div className="immersiveWorkspaceShell">
                  <div className="immersiveWorkspaceHeader">
                    <div>
                      <div className="cardTitle">Workspace Context</div>
                      <div className="claudeMemoryMeta">
                        {workspaceContext.workspaceScopePath ?? workspaceContext.selectedPath ?? workspaceContext.activePath ?? workspaceContext.workspaceRoot ?? 'No workspace open'}
                      </div>
                    </div>
                    <div className="immersiveWorkspaceActions">
                      <button type="button" onClick={onOpenGitPage} disabled={!workspaceContext.workspaceRoot}>
                        Open Git
                      </button>
                      <button type="button" onClick={() => setImmersiveWorkspaceOpen(false)}>Close</button>
                    </div>
                  </div>
                  <div className="immersiveWorkspaceBody">
                    {workspacePanel}
                  </div>
                </div>
              </aside>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
