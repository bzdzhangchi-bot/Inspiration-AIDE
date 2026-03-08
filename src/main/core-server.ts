import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { AgentSessionRequest, ChatRequest, ClientWsMessage, ServerWsEvent, StreamEvent } from '../shared/types.js';
import { openDb } from './db.js';
import { checkProviderConnection, streamAgentPatch, streamAgentSession, streamChat, streamInlineCompletion } from './providers.js';

const PORT = Number(process.env.ASSISTANT_DESK_PORT || 17840);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function decodeWorkspacePreviewToken(token: string) {
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function isPathInside(parentPath: string, targetPath: string) {
  const relative = path.relative(parentPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

app.get(/^\/workspace-preview\/([^/]+)\/(.+)$/, async (req, res) => {
  const match = req.path.match(/^\/workspace-preview\/([^/]+)\/(.+)$/);
  if (!match) {
    res.status(404).end();
    return;
  }

  try {
    const workspaceRoot = path.resolve(decodeWorkspacePreviewToken(match[1]));
    const relativePath = decodeURIComponent(match[2]);
    const resolvedPath = path.resolve(workspaceRoot, relativePath);

    if (!isPathInside(workspaceRoot, resolvedPath)) {
      res.status(403).type('text/plain').send('Preview path denied');
      return;
    }

    const stats = await fs.stat(resolvedPath);
    const finalPath = stats.isDirectory() ? path.join(resolvedPath, 'index.html') : resolvedPath;

    if (!isPathInside(workspaceRoot, finalPath)) {
      res.status(403).type('text/plain').send('Preview path denied');
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      res.status(404).type('text/plain').send('Preview file not found');
      return;
    }

    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to load preview file'
    });
  }
});

const db = openDb();
void db; // db is initialized for MVP; persistence wiring comes next

app.get('/health', (_req, res) => {
  res.json({ ok: true, port: PORT });
});

app.post('/provider/check', async (req, res) => {
  try {
    const result = await checkProviderConnection(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Connection check failed'
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[core] http listening on ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ kind: 'chat', type: 'error', message: 'Invalid JSON' } satisfies StreamEvent));
      ws.send(JSON.stringify({ kind: 'chat', type: 'done' } satisfies StreamEvent));
      return;
    }

    const isLegacyChat =
      !!msg &&
      typeof msg === 'object' &&
      !('kind' in msg) &&
      'messages' in msg &&
      Array.isArray((msg as { messages?: unknown }).messages);

    const req = msg as ClientWsMessage;

    async function send(ev: ServerWsEvent) {
      ws.send(JSON.stringify(ev));
    }

    try {
      if (isLegacyChat || (req && typeof req === 'object' && !('kind' in req))) {
        for await (const ev of streamChat(req as ChatRequest)) {
          await send(ev);
        }
        return;
      }

      if (req && typeof req === 'object' && 'kind' in req && req.kind === 'inline_completion') {
        for await (const ev of streamInlineCompletion(req)) {
          await send(ev);
        }
        return;
      }

      if (req && typeof req === 'object' && 'kind' in req && req.kind === 'agent_session') {
        for await (const ev of streamAgentSession(req as AgentSessionRequest)) {
          await send(ev);
        }
        return;
      }

      if (req && typeof req === 'object' && 'kind' in req && req.kind === 'agent_patch') {
        for await (const ev of streamAgentPatch(req)) {
          await send(ev);
        }
        return;
      }

      await send({ kind: 'chat', type: 'error', message: 'Unknown message kind' } satisfies StreamEvent);
      await send({ kind: 'chat', type: 'done' } satisfies StreamEvent);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      await send({ kind: 'chat', type: 'error', message } satisfies StreamEvent);
      await send({ kind: 'chat', type: 'done' } satisfies StreamEvent);
    }
  });
});
