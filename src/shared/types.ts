export type ProviderId = 'openai_compat' | 'anthropic' | 'github_copilot';
export type InteractionMode = 'standard' | 'native_agent' | 'claude_cli';

export type Role = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: Role;
  content: string;
};

export type ChatRequest = {
  providerId: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  interactionMode?: InteractionMode;
  messages: ChatMessage[];
  temperature?: number;
};

export type AgentToolName =
  | 'list_dir'
  | 'read_file'
  | 'read_file_range'
  | 'search_text'
  | 'openclaw_skill_list'
  | 'openclaw_skill_info'
  | 'openclaw_agent'
  | 'apply_patch'
  | 'write_file'
  | 'create_file'
  | 'create_dir'
  | 'delete_entry'
  | 'git_status'
  | 'git_diff'
  | 'run_command'
  | 'ask_user';

export type AgentTextBlock = {
  type: 'text';
  text: string;
};

export type AgentToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: AgentToolName;
  input: Record<string, unknown>;
};

export type AgentToolResultBlock = {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type AgentSessionMessage =
  | {
      role: 'user';
      content: Array<AgentTextBlock | AgentToolResultBlock>;
    }
  | {
      role: 'assistant';
      content: Array<AgentTextBlock | AgentToolUseBlock>;
    };

export type AgentSessionRequest = {
  kind: 'agent_session';
  providerId: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  system: string;
  messages: AgentSessionMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type ProviderConnectionRequest = {
  providerId: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  model: string;
};

export type ProviderConnectionResult = {
  ok: boolean;
  message: string;
};

export type StreamEvent =
  | { kind: 'chat'; type: 'token'; text: string }
  | { kind: 'chat'; type: 'error'; message: string }
  | { kind: 'chat'; type: 'done' };

export type AgentSessionEvent =
  | { kind: 'agent_session'; type: 'text'; text: string }
  | { kind: 'agent_session'; type: 'tool_use'; id: string; name: AgentToolName; input: Record<string, unknown> }
  | { kind: 'agent_session'; type: 'error'; message: string }
  | { kind: 'agent_session'; type: 'done'; stopReason?: string };

export type InlineCompletionRequest = {
  providerId: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  filePath?: string;
  documentText: string;
  cursorOffset: number;
};

export type InlineCompletionEvent =
  | { kind: 'inline_completion'; type: 'completion'; text: string }
  | { kind: 'inline_completion'; type: 'error'; message: string }
  | { kind: 'inline_completion'; type: 'done' };

export type FilePatch =
  | { operation: 'modify' | 'create'; filePath: string; newText: string }
  | { operation: 'delete'; filePath: string };

export type AgentPatchRequest = {
  providerId: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  task: string;
  activeFilePath?: string;
  activeFileText: string;
};

export type AgentPatchEvent =
  | { kind: 'agent_patch'; type: 'progress'; message: string }
  | { kind: 'agent_patch'; type: 'patch'; patches: FilePatch[] }
  | { kind: 'agent_patch'; type: 'error'; message: string }
  | { kind: 'agent_patch'; type: 'done' };

export type ClientWsMessage =
  | ChatRequest
  | AgentSessionRequest
  | ({ kind: 'inline_completion' } & InlineCompletionRequest)
  | ({ kind: 'agent_patch' } & AgentPatchRequest);

export type ServerWsEvent = StreamEvent | AgentSessionEvent | InlineCompletionEvent | AgentPatchEvent;
