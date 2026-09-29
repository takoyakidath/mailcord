import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

function applySchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS address_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_address TEXT NOT NULL UNIQUE,
      discord_guild_id TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_inbound_emails (
      resend_email_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocked_senders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_address TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_message_id TEXT NOT NULL UNIQUE,
      binding_id INTEGER NOT NULL REFERENCES address_bindings(id),
      external_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      email_message_id TEXT NOT NULL,
      in_reply_to TEXT,
      references_chain TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
      created_at TEXT NOT NULL
    );
  `);
}

// A fresh clone's `data/` directory doesn't exist yet (it's gitignored); Docker's VOLUME
// mount creates it for us, but a local `npm run dev` needs it created explicitly.
function ensureParentDirectory(path: string): void {
  if (path === ':memory:') return;
  mkdirSync(dirname(path), { recursive: true });
}

/** Returns both the query interface and the raw handle, for callers that need to close it. */
export function createDbWithHandle(path: string): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: Database.Database } {
  ensureParentDirectory(path);
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  applySchema(sqlite);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

export function createDb(path: string) {
  return createDbWithHandle(path).db;
}

export type Db = ReturnType<typeof createDb>;
