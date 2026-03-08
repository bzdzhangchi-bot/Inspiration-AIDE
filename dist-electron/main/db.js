import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function appDataDir() {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'assistant-desk');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function openDb() {
    const dbPath = path.join(appDataDir(), 'assistant-desk.sqlite3');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
    create table if not exists conversations (
      id text primary key,
      title text not null,
      created_at integer not null
    );

    create table if not exists messages (
      id text primary key,
      conversation_id text not null,
      role text not null,
      content text not null,
      created_at integer not null
    );

    create index if not exists idx_messages_conversation on messages(conversation_id, created_at);
  `);
    return db;
}
//# sourceMappingURL=db.js.map