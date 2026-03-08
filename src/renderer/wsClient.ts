import type {
  AgentSessionEvent,
  AgentSessionRequest,
  AgentPatchRequest,
  InlineCompletionRequest,
  ChatRequest,
  ServerWsEvent,
  StreamEvent,
  InlineCompletionEvent,
  AgentPatchEvent,
  ClientWsMessage,
  ProviderConnectionRequest,
  ProviderConnectionResult
} from '../shared/types';

export const CORE_SERVER_URL = 'http://127.0.0.1:17840';

function openWsStream(message: ClientWsMessage) {
  const ws = new WebSocket('ws://127.0.0.1:17840/ws');

  const listeners = new Set<(ev: ServerWsEvent) => void>();
  const closeListeners = new Set<() => void>();
  const errorListeners = new Set<(message: string) => void>();
  let didFinish = false;

  function finish() {
    if (didFinish) return;
    didFinish = true;
    closeListeners.forEach((fn) => fn());
  }

  ws.addEventListener('open', () => {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      errorListeners.forEach((fn) => fn('Failed to send WebSocket request'));
      finish();
    }
  });

  ws.addEventListener('message', (msg) => {
    try {
      const ev = JSON.parse(String(msg.data)) as ServerWsEvent;
      listeners.forEach((fn) => fn(ev));
    } catch {
      // ignore
    }
  });

  ws.addEventListener('error', () => {
    errorListeners.forEach((fn) => fn('WebSocket connection failed'));
  });

  ws.addEventListener('close', () => {
    finish();
  });

  return {
    onEvent(fn: (ev: ServerWsEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onClose(fn: () => void) {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    onError(fn: (message: string) => void) {
      errorListeners.add(fn);
      return () => errorListeners.delete(fn);
    },
    close() {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        finish();
        return;
      }
      ws.close();
    }
  };
}

export function openChatStream(req: ChatRequest) {
  const stream = openWsStream(req as ClientWsMessage);
  return {
    onEvent(fn: (ev: StreamEvent) => void) {
      return stream.onEvent((ev) => {
        if (ev.kind === 'chat') fn(ev);
      });
    },
    onClose: stream.onClose,
    onError: stream.onError,
    close: stream.close
  };
}

export function openAgentSessionStream(req: AgentSessionRequest) {
  const stream = openWsStream(req);
  return {
    onEvent(fn: (ev: AgentSessionEvent) => void) {
      return stream.onEvent((ev) => {
        if (ev.kind === 'agent_session') fn(ev);
      });
    },
    onClose: stream.onClose,
    onError: stream.onError,
    close: stream.close
  };
}

export function openInlineCompletionStream(req: InlineCompletionRequest) {
  const stream = openWsStream({ kind: 'inline_completion', ...req });
  return {
    onEvent(fn: (ev: InlineCompletionEvent) => void) {
      return stream.onEvent((ev) => {
        if (ev.kind === 'inline_completion') fn(ev);
      });
    },
    onClose: stream.onClose,
    onError: stream.onError,
    close: stream.close
  };
}

export function openAgentPatchStream(req: AgentPatchRequest) {
  const stream = openWsStream({ kind: 'agent_patch', ...req });
  return {
    onEvent(fn: (ev: AgentPatchEvent) => void) {
      return stream.onEvent((ev) => {
        if (ev.kind === 'agent_patch') fn(ev);
      });
    },
    onClose: stream.onClose,
    onError: stream.onError,
    close: stream.close
  };
}

export async function checkProviderConnection(req: ProviderConnectionRequest): Promise<ProviderConnectionResult> {
  const resp = await fetch(`${CORE_SERVER_URL}/provider/check`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(req)
  });

  if (!resp.ok) {
    return {
      ok: false,
      message: `Connection check failed: ${resp.status}`
    };
  }

  return (await resp.json()) as ProviderConnectionResult;
}
