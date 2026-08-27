# mailcord Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users send and receive email on a custom domain from Discord, using Resend for both outbound sending and inbound receiving.

**Architecture:** A single Node.js/TypeScript process runs both a discord.js bot (Gateway connection) and a Fastify HTTP server (Resend inbound webhook receiver). All state (address↔channel bindings, email-thread↔Discord-message links) lives in one SQLite file accessed via Drizzle ORM. Deployed with Docker Compose (`app` + `caddy` for automatic TLS) on the user's existing VPS.

**Tech Stack:** TypeScript, Node.js 20, discord.js v14, fastify, drizzle-orm + better-sqlite3, `resend` SDK, zod, vitest, tsx, Docker Compose, Caddy.

**Spec:** `docs/superpowers/specs/2026-08-27-mailcord-design.md`

## Global Constraints

- Language/runtime: Node.js + TypeScript (per spec §概要).
- Email provider: Resend for both outbound send (Send API) and inbound receive (Inbound Webhook) — no other provider.
- Persistence: single SQLite file via Drizzle ORM — no external DB server.
- Deployment: Docker Compose on the existing VPS; Caddy provides automatic TLS on a dedicated subdomain.
- A Discord channel represents **our own sending address**, not the external counterpart (per spec §用語・前提). One channel binds to exactly one address.
- Replying to an email requires using Discord's message-reply feature — thread/recipient resolution is reply-based, not "last sender" based (per spec §メールフロー).
- A brand-new outbound email (not a reply) is only sent via the `/mail send` slash command — plain channel messages with no reply target are never sent as email (per spec §メールフロー, "Bot以外の通常投稿").
- Attachments are supported both directions in v1 (per spec §添付ファイル decision).
- Out of scope for v1: CC/BCC, HTML rendering beyond plain-text/body-preview, notifying an unbound-address inbox, multiple bindings per channel (per spec §スコープ外).

## Resend API shapes used in this plan (verified against current Resend docs)

```ts
// Sending (resend.emails.send)
type SendEmailRequest = {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer | string; content_type?: string }[];
};
// returns { data: { id: string } | null, error: { message: string } | null }

// Inbound webhook body (event type "email.received")
type EmailReceivedWebhook = {
  type: 'email.received';
  created_at: string;
  data: { email_id: string; from: string; to: string[]; subject: string };
};
// Webhook headers: svix-id, svix-timestamp, svix-signature
// Verified via resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret })
// which throws on invalid signature and otherwise returns the parsed event.

// Full email content (resend.emails.receiving.get(emailId))
type ReceivedEmail = {
  email_id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>; // includes Message-Id / In-Reply-To / References
  created_at: string;
  attachments: { id: string; filename: string; content_type: string; size: number }[];
};
// returns { data: ReceivedEmail | null, error: { message: string } | null }

// Attachment download (resend.emails.receiving.attachments.get({ emailId, attachmentId }))
// returns { data: { download_url: string; expires_at: string } | null, error }
```

Note: the webhook payload carries **metadata only** — the body and attachment content must be fetched separately via `receiving.get()` and `receiving.attachments.get()`.

---

## File Structure

```
mailcord/
  package.json
  tsconfig.json
  vitest.config.ts
  .env.example
  Dockerfile
  docker-compose.yml
  Caddyfile
  src/
    env.ts                          # zod-validated env loader
    db/
      schema.ts                     # Drizzle table defs
      client.ts                     # createDb() -> Drizzle instance, auto-applies schema
    mail/
      headers.ts                    # pure: references-chain / reply-headers / reply-subject
      address.ts                    # pure: extractEmailAddress
      resendClient.ts                # ResendClient: send, receiving.get, attachment url, webhook verify
    util/
      stripHtml.ts                  # pure: strip HTML tags for fallback body preview
      fetchBuffer.ts                # fetchAsBuffer(url) -> Buffer
    services/
      bindingService.ts             # address<->channel binding CRUD/resolution
      threadService.ts              # email_threads CRUD/resolution
      outboundEmailService.ts       # sendNewEmail / sendReplyEmail orchestration
      inboundEmailService.ts        # handleInboundEmail orchestration
    web/
      server.ts                     # Fastify app + POST /webhooks/resend/inbound
    bot/
      commands/
        bindHandler.ts              # pure: handleBindCommand/handleUnbindCommand/handleListCommand
        sendHandler.ts              # pure: handleSendCommand
        definitions.ts              # SlashCommandBuilder definitions
      replyDetection.ts             # pure: classifyIncomingMessage
      registerCommands.ts           # REST registration of slash commands
      registerCommandsCli.ts        # CLI entrypoint for the above
      client.ts                     # discord.js Client wiring + createDiscordPoster
    index.ts                        # process entrypoint
  tests/
    db/client.test.ts
    env.test.ts
    mail/headers.test.ts
    mail/address.test.ts
    mail/resendClient.test.ts
    util/stripHtml.test.ts
    util/fetchBuffer.test.ts
    services/bindingService.test.ts
    services/threadService.test.ts
    services/outboundEmailService.test.ts
    services/inboundEmailService.test.ts
    web/server.test.ts
    bot/commands/bindHandler.test.ts
    bot/commands/sendHandler.test.ts
    bot/replyDetection.test.ts
```

---

### Task 1: Project scaffolding, env loader, DB schema & client

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/env.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`
- Test: `tests/env.test.ts`, `tests/db/client.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?: NodeJS.ProcessEnv): Env` where
  `Env = { DISCORD_BOT_TOKEN: string; DISCORD_APPLICATION_ID: string; RESEND_API_KEY: string; RESEND_WEBHOOK_SECRET: string; DB_PATH: string; PORT: number }`
- Produces: `createDb(path: string): Db` (Drizzle instance, schema already applied)
- Produces: `addressBindings`, `emailThreads` (Drizzle table objects) from `src/db/schema.ts`

- [ ] **Step 1: Init project and install dependencies**

```bash
cd /Users/takoyaki/ghq/github.com/takoyakidath/mailcord
npm init -y
npm install discord.js fastify drizzle-orm better-sqlite3 resend zod dotenv
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
npx tsc --init
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Add scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "register-commands": "tsx src/bot/registerCommandsCli.ts"
  }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
data/
.env
```

- [ ] **Step 6: Write the failing test for `loadEnv`**

`tests/env.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/env';

const validEnv = {
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_APPLICATION_ID: 'app-id',
  RESEND_API_KEY: 're_key',
  RESEND_WEBHOOK_SECRET: 'whsec_abc',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(validEnv);
    expect(env.DISCORD_BOT_TOKEN).toBe('token');
    expect(env.DB_PATH).toBe('./data/mailcord.db');
    expect(env.PORT).toBe(8787);
  });

  it('throws when a required var is missing', () => {
    const { DISCORD_BOT_TOKEN, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/env.test.ts`
Expected: FAIL (`src/env.ts` does not exist)

- [ ] **Step 8: Implement `src/env.ts`**

```ts
import { z } from 'zod';

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  RESEND_WEBHOOK_SECRET: z.string().min(1),
  DB_PATH: z.string().default('./data/mailcord.db'),
  PORT: z.coerce.number().default(8787),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run tests/env.test.ts`
Expected: PASS

- [ ] **Step 10: Write `src/db/schema.ts`**

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const addressBindings = sqliteTable('address_bindings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  emailAddress: text('email_address').notNull().unique(),
  discordGuildId: text('discord_guild_id').notNull(),
  discordChannelId: text('discord_channel_id').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const emailThreads = sqliteTable('email_threads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  discordMessageId: text('discord_message_id').notNull().unique(),
  bindingId: integer('binding_id').notNull().references(() => addressBindings.id),
  externalAddress: text('external_address').notNull(),
  subject: text('subject').notNull(),
  emailMessageId: text('email_message_id').notNull(),
  inReplyTo: text('in_reply_to'),
  referencesChain: text('references_chain'),
  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  createdAt: text('created_at').notNull(),
});
```

(`subject` is not listed as its own column in the spec's data model sketch, but is required to send a reply email — Resend requires a `subject` on every send. Added here as a necessary completion of the spec, not a deviation from it.)

- [ ] **Step 11: Write the failing test for the DB client**

`tests/db/client.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/db/client';
import { addressBindings } from '../../src/db/schema';

describe('createDb', () => {
  it('creates tables and allows insert/read round-trip', async () => {
    const db = createDb(':memory:');
    await db.insert(addressBindings).values({
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
      createdAt: new Date().toISOString(),
    });
    const rows = await db.select().from(addressBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0].emailAddress).toBe('tako@octo.jp');
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `npx vitest run tests/db/client.test.ts`
Expected: FAIL (`src/db/client.ts` does not exist)

- [ ] **Step 13: Implement `src/db/client.ts`**

```ts
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

export function createDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  applySchema(sqlite);
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
```

- [ ] **Step 14: Run test to verify it passes**

Run: `npx vitest run tests/db/client.test.ts`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/env.ts src/db/schema.ts src/db/client.ts tests/env.test.ts tests/db/client.test.ts
git commit -m "feat: scaffold project, env loader, and DB schema/client"
```

---

### Task 2: Pure utility functions (email headers, address parsing, HTML strip, buffer fetch)

**Files:**
- Create: `src/mail/headers.ts`
- Create: `src/mail/address.ts`
- Create: `src/util/stripHtml.ts`
- Create: `src/util/fetchBuffer.ts`
- Test: `tests/mail/headers.test.ts`, `tests/mail/address.test.ts`, `tests/util/stripHtml.test.ts`, `tests/util/fetchBuffer.test.ts`

**Interfaces:**
- Produces: `appendToReferencesChain(existingChain: string | null, messageId: string): string`
- Produces: `buildReplyHeaders(originalMessageId: string, existingReferencesChain: string | null): { inReplyTo: string; references: string }`
- Produces: `buildReplySubject(originalSubject: string): string`
- Produces: `extractEmailAddress(raw: string): string`
- Produces: `stripHtml(html: string): string`
- Produces: `fetchAsBuffer(url: string): Promise<Buffer>`

- [ ] **Step 1: Write the failing tests for `mail/headers.ts`**

`tests/mail/headers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { appendToReferencesChain, buildReplyHeaders, buildReplySubject } from '../../src/mail/headers';

describe('appendToReferencesChain', () => {
  it('starts a new chain when there is none', () => {
    expect(appendToReferencesChain(null, '<msg1@x>')).toBe('<msg1@x>');
  });

  it('appends to an existing chain', () => {
    expect(appendToReferencesChain('<msg1@x>', '<msg2@x>')).toBe('<msg1@x> <msg2@x>');
  });
});

describe('buildReplyHeaders', () => {
  it('sets In-Reply-To and extends References', () => {
    const result = buildReplyHeaders('<msg1@x>', '<msg0@x>');
    expect(result.inReplyTo).toBe('<msg1@x>');
    expect(result.references).toBe('<msg0@x> <msg1@x>');
  });
});

describe('buildReplySubject', () => {
  it('prefixes with Re: when not already present', () => {
    expect(buildReplySubject('Hello')).toBe('Re: Hello');
  });

  it('does not double-prefix', () => {
    expect(buildReplySubject('Re: Hello')).toBe('Re: Hello');
    expect(buildReplySubject('re: Hello')).toBe('re: Hello');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mail/headers.test.ts`
Expected: FAIL (`src/mail/headers.ts` does not exist)

- [ ] **Step 3: Implement `src/mail/headers.ts`**

```ts
export function appendToReferencesChain(existingChain: string | null, messageId: string): string {
  const ids = existingChain ? existingChain.split(' ').filter(Boolean) : [];
  ids.push(messageId);
  return ids.join(' ');
}

export interface ReplyHeaders {
  inReplyTo: string;
  references: string;
}

export function buildReplyHeaders(
  originalMessageId: string,
  existingReferencesChain: string | null,
): ReplyHeaders {
  return {
    inReplyTo: originalMessageId,
    references: appendToReferencesChain(existingReferencesChain, originalMessageId),
  };
}

export function buildReplySubject(originalSubject: string): string {
  return originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mail/headers.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for `mail/address.ts`**

`tests/mail/address.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { extractEmailAddress } from '../../src/mail/address';

describe('extractEmailAddress', () => {
  it('extracts the address from a "Name <addr>" string', () => {
    expect(extractEmailAddress('Acme <noreply@acme.com>')).toBe('noreply@acme.com');
  });

  it('returns a bare address unchanged', () => {
    expect(extractEmailAddress('noreply@acme.com')).toBe('noreply@acme.com');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/mail/address.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement `src/mail/address.ts`**

```ts
export function extractEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1] : raw.trim();
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/mail/address.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing test for `util/stripHtml.ts`**

`tests/util/stripHtml.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { stripHtml } from '../../src/util/stripHtml';

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>World</b></p>')).toBe('Hello World');
  });

  it('handles plain text unchanged', () => {
    expect(stripHtml('Hello World')).toBe('Hello World');
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run tests/util/stripHtml.test.ts`
Expected: FAIL

- [ ] **Step 11: Implement `src/util/stripHtml.ts`**

```ts
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run tests/util/stripHtml.test.ts`
Expected: PASS

- [ ] **Step 13: Write the failing test for `util/fetchBuffer.ts`**

`tests/util/fetchBuffer.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAsBuffer } from '../../src/util/fetchBuffer';

describe('fetchAsBuffer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a Buffer of the response body', async () => {
    const bytes = new TextEncoder().encode('hello');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    }));

    const buf = await fetchAsBuffer('https://example.com/file.txt');
    expect(buf.toString('utf8')).toBe('hello');
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchAsBuffer('https://example.com/missing')).rejects.toThrow();
  });
});
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npx vitest run tests/util/fetchBuffer.test.ts`
Expected: FAIL

- [ ] **Step 15: Implement `src/util/fetchBuffer.ts`**

```ts
export async function fetchAsBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npx vitest run tests/util/fetchBuffer.test.ts`
Expected: PASS

- [ ] **Step 17: Commit**

```bash
git add src/mail/headers.ts src/mail/address.ts src/util/stripHtml.ts src/util/fetchBuffer.ts tests/mail/headers.test.ts tests/mail/address.test.ts tests/util/stripHtml.test.ts tests/util/fetchBuffer.test.ts
git commit -m "feat: add pure email header, address, and fetch utilities"
```

---

### Task 3: bindingService (address ⇔ channel binding)

**Files:**
- Create: `src/services/bindingService.ts`
- Test: `tests/services/bindingService.test.ts`

**Interfaces:**
- Consumes: `createDb(':memory:'): Db` from Task 1; `addressBindings` from Task 1's `src/db/schema.ts`
- Produces:
  - `interface Binding { id: number; emailAddress: string; discordGuildId: string; discordChannelId: string; createdBy: string; createdAt: string }`
  - `createBinding(db: Db, params: { emailAddress: string; discordGuildId: string; discordChannelId: string; createdBy: string }): Promise<Binding>`
  - `removeBinding(db: Db, discordChannelId: string): Promise<boolean>`
  - `listBindingsForGuild(db: Db, discordGuildId: string): Promise<Binding[]>`
  - `resolveBindingByChannel(db: Db, discordChannelId: string): Promise<Binding | null>`
  - `resolveBindingByAddress(db: Db, emailAddress: string): Promise<Binding | null>`

- [ ] **Step 1: Write the failing tests**

`tests/services/bindingService.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import {
  createBinding,
  removeBinding,
  listBindingsForGuild,
  resolveBindingByChannel,
  resolveBindingByAddress,
} from '../../src/services/bindingService';

describe('bindingService', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('creates and resolves a binding by channel and by address', async () => {
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });

    const byChannel = await resolveBindingByChannel(db, 'chan-1');
    expect(byChannel?.emailAddress).toBe('tako@octo.jp');

    const byAddress = await resolveBindingByAddress(db, 'tako@octo.jp');
    expect(byAddress?.discordChannelId).toBe('chan-1');
  });

  it('returns null when no binding matches', async () => {
    expect(await resolveBindingByChannel(db, 'missing')).toBeNull();
    expect(await resolveBindingByAddress(db, 'missing@x.com')).toBeNull();
  });

  it('lists bindings for a guild', async () => {
    await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'guild-1', discordChannelId: 'chan-1', createdBy: 'u1' });
    await createBinding(db, { emailAddress: 'tai@octo.jp', discordGuildId: 'guild-1', discordChannelId: 'chan-2', createdBy: 'u1' });
    await createBinding(db, { emailAddress: 'other@x.com', discordGuildId: 'guild-2', discordChannelId: 'chan-3', createdBy: 'u1' });

    const list = await listBindingsForGuild(db, 'guild-1');
    expect(list).toHaveLength(2);
  });

  it('removes a binding, returning whether one existed', async () => {
    await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'guild-1', discordChannelId: 'chan-1', createdBy: 'u1' });

    expect(await removeBinding(db, 'chan-1')).toBe(true);
    expect(await resolveBindingByChannel(db, 'chan-1')).toBeNull();
    expect(await removeBinding(db, 'chan-1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/bindingService.test.ts`
Expected: FAIL (`src/services/bindingService.ts` does not exist)

- [ ] **Step 3: Implement `src/services/bindingService.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { addressBindings } from '../db/schema';

export interface Binding {
  id: number;
  emailAddress: string;
  discordGuildId: string;
  discordChannelId: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateBindingParams {
  emailAddress: string;
  discordGuildId: string;
  discordChannelId: string;
  createdBy: string;
}

export async function createBinding(db: Db, params: CreateBindingParams): Promise<Binding> {
  const createdAt = new Date().toISOString();
  const rows = await db
    .insert(addressBindings)
    .values({ ...params, createdAt })
    .returning();
  return rows[0] as Binding;
}

export async function removeBinding(db: Db, discordChannelId: string): Promise<boolean> {
  const existing = await resolveBindingByChannel(db, discordChannelId);
  if (!existing) return false;
  await db.delete(addressBindings).where(eq(addressBindings.discordChannelId, discordChannelId));
  return true;
}

export async function listBindingsForGuild(db: Db, discordGuildId: string): Promise<Binding[]> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.discordGuildId, discordGuildId));
  return rows as Binding[];
}

export async function resolveBindingByChannel(db: Db, discordChannelId: string): Promise<Binding | null> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.discordChannelId, discordChannelId))
    .limit(1);
  return (rows[0] as Binding) ?? null;
}

export async function resolveBindingByAddress(db: Db, emailAddress: string): Promise<Binding | null> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.emailAddress, emailAddress))
    .limit(1);
  return (rows[0] as Binding) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/bindingService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/bindingService.ts tests/services/bindingService.test.ts
git commit -m "feat: add bindingService for address<->channel mapping"
```

---

### Task 4: threadService (email_threads CRUD/resolution)

**Files:**
- Create: `src/services/threadService.ts`
- Test: `tests/services/threadService.test.ts`

**Interfaces:**
- Consumes: `createDb`, `Db` from Task 1; `emailThreads`, `addressBindings` from Task 1's schema; `createBinding` from Task 3 (test setup only)
- Produces:
  - `interface ThreadRecord { id: number; discordMessageId: string; bindingId: number; externalAddress: string; subject: string; emailMessageId: string; inReplyTo: string | null; referencesChain: string | null; direction: 'inbound' | 'outbound'; createdAt: string }`
  - `recordThreadMessage(db: Db, params: Omit<ThreadRecord, 'id' | 'createdAt'>): Promise<ThreadRecord>`
  - `resolveThreadByDiscordMessageId(db: Db, discordMessageId: string): Promise<ThreadRecord | null>`

- [ ] **Step 1: Write the failing tests**

`tests/services/threadService.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import { recordThreadMessage, resolveThreadByDiscordMessageId } from '../../src/services/threadService';

describe('threadService', () => {
  let db: Db;
  let bindingId: number;

  beforeEach(async () => {
    db = createDb(':memory:');
    const binding = await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });
    bindingId = binding.id;
  });

  it('records an inbound message and resolves it by Discord message id', async () => {
    await recordThreadMessage(db, {
      discordMessageId: 'discord-msg-1',
      bindingId,
      externalAddress: 'friend@example.com',
      subject: 'Hello',
      emailMessageId: '<mail1@example.com>',
      inReplyTo: null,
      referencesChain: null,
      direction: 'inbound',
    });

    const resolved = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
    expect(resolved?.externalAddress).toBe('friend@example.com');
    expect(resolved?.direction).toBe('inbound');
  });

  it('returns null when no thread matches', async () => {
    expect(await resolveThreadByDiscordMessageId(db, 'missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/threadService.test.ts`
Expected: FAIL (`src/services/threadService.ts` does not exist)

- [ ] **Step 3: Implement `src/services/threadService.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { emailThreads } from '../db/schema';

export interface ThreadRecord {
  id: number;
  discordMessageId: string;
  bindingId: number;
  externalAddress: string;
  subject: string;
  emailMessageId: string;
  inReplyTo: string | null;
  referencesChain: string | null;
  direction: 'inbound' | 'outbound';
  createdAt: string;
}

export async function recordThreadMessage(
  db: Db,
  params: Omit<ThreadRecord, 'id' | 'createdAt'>,
): Promise<ThreadRecord> {
  const createdAt = new Date().toISOString();
  const rows = await db
    .insert(emailThreads)
    .values({ ...params, createdAt })
    .returning();
  return rows[0] as ThreadRecord;
}

export async function resolveThreadByDiscordMessageId(
  db: Db,
  discordMessageId: string,
): Promise<ThreadRecord | null> {
  const rows = await db
    .select()
    .from(emailThreads)
    .where(eq(emailThreads.discordMessageId, discordMessageId))
    .limit(1);
  return (rows[0] as ThreadRecord) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/threadService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/threadService.ts tests/services/threadService.test.ts
git commit -m "feat: add threadService for email<->Discord message linkage"
```

---

### Task 5: resendClient (Resend SDK wrapper)

**Files:**
- Create: `src/mail/resendClient.ts`
- Test: `tests/mail/resendClient.test.ts`

**Interfaces:**
- Produces:
  - `interface OutboundAttachment { filename: string; content: Buffer; contentType?: string }`
  - `interface SendEmailParams { from: string; to: string; subject: string; text: string; headers?: Record<string, string>; attachments?: OutboundAttachment[] }`
  - `interface ReceivedEmail { emailId: string; from: string; to: string[]; subject: string; text: string; html: string; headers: Record<string, string>; attachments: { id: string; filename: string; contentType: string; size: number }[] }`
  - `interface WebhookEvent { type: string; data: { email_id: string; from: string; to: string[]; subject: string } }`
  - `interface ResendClient { sendEmail(params: SendEmailParams): Promise<{ id: string }>; getReceivedEmail(emailId: string): Promise<ReceivedEmail>; getAttachmentDownloadUrl(emailId: string, attachmentId: string): Promise<string>; verifyWebhookSignature(payload: string, headers: { id: string; timestamp: string; signature: string }, secret: string): Promise<WebhookEvent | null> }`
  - `createResendClient(apiKey: string): ResendClient`

- [ ] **Step 1: Write the failing test**

`tests/mail/resendClient.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
const receivingGetMock = vi.fn();
const attachmentsGetMock = vi.fn();
const webhooksVerifyMock = vi.fn();

vi.mock('resend', () => {
  return {
    Resend: vi.fn().mockImplementation(() => ({
      emails: {
        send: sendMock,
        receiving: {
          get: receivingGetMock,
          attachments: { get: attachmentsGetMock },
        },
      },
      webhooks: { verify: webhooksVerifyMock },
    })),
  };
});

import { createResendClient } from '../../src/mail/resendClient';

describe('resendClient', () => {
  beforeEach(() => {
    sendMock.mockReset();
    receivingGetMock.mockReset();
    attachmentsGetMock.mockReset();
    webhooksVerifyMock.mockReset();
  });

  it('sendEmail maps params and returns the new id', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email-123' }, error: null });
    const client = createResendClient('re_test');

    const result = await client.sendEmail({
      from: 'tako@octo.jp',
      to: 'friend@example.com',
      subject: 'Hi',
      text: 'Hello',
      headers: { 'In-Reply-To': '<a@x>' },
      attachments: [{ filename: 'a.txt', content: Buffer.from('x') }],
    });

    expect(result.id).toBe('email-123');
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      from: 'tako@octo.jp',
      to: 'friend@example.com',
      subject: 'Hi',
      text: 'Hello',
      headers: { 'In-Reply-To': '<a@x>' },
    }));
  });

  it('sendEmail throws when Resend returns an error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'bad request' } });
    const client = createResendClient('re_test');

    await expect(client.sendEmail({ from: 'a@x', to: 'b@x', subject: 's', text: 't' })).rejects.toThrow('bad request');
  });

  it('getReceivedEmail maps the Resend response shape', async () => {
    receivingGetMock.mockResolvedValue({
      data: {
        email_id: 'email-1',
        from: 'Friend <friend@example.com>',
        to: ['tako@octo.jp'],
        subject: 'Hi',
        text: 'body',
        html: '<p>body</p>',
        headers: { 'Message-Id': '<m1@x>' },
        attachments: [{ id: 'att-1', filename: 'a.pdf', content_type: 'application/pdf', size: 10 }],
      },
      error: null,
    });
    const client = createResendClient('re_test');

    const email = await client.getReceivedEmail('email-1');
    expect(email.emailId).toBe('email-1');
    expect(email.attachments[0]).toEqual({ id: 'att-1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 });
  });

  it('getAttachmentDownloadUrl returns the download_url', async () => {
    attachmentsGetMock.mockResolvedValue({ data: { download_url: 'https://x/y', expires_at: 'later' }, error: null });
    const client = createResendClient('re_test');

    const url = await client.getAttachmentDownloadUrl('email-1', 'att-1');
    expect(url).toBe('https://x/y');
    expect(attachmentsGetMock).toHaveBeenCalledWith({ emailId: 'email-1', attachmentId: 'att-1' });
  });

  it('verifyWebhookSignature returns the parsed event on success', async () => {
    webhooksVerifyMock.mockResolvedValue({ type: 'email.received', data: { email_id: 'email-1', from: 'a@x', to: ['b@x'], subject: 's' } });
    const client = createResendClient('re_test');

    const event = await client.verifyWebhookSignature('{}', { id: 'id', timestamp: 'ts', signature: 'sig' }, 'whsec_x');
    expect(event?.type).toBe('email.received');
  });

  it('verifyWebhookSignature returns null when verification throws', async () => {
    webhooksVerifyMock.mockRejectedValue(new Error('bad signature'));
    const client = createResendClient('re_test');

    const event = await client.verifyWebhookSignature('{}', { id: 'id', timestamp: 'ts', signature: 'sig' }, 'whsec_x');
    expect(event).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mail/resendClient.test.ts`
Expected: FAIL (`src/mail/resendClient.ts` does not exist)

- [ ] **Step 3: Implement `src/mail/resendClient.ts`**

```ts
import { Resend } from 'resend';

export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
}

export interface ReceivedEmail {
  emailId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments: { id: string; filename: string; contentType: string; size: number }[];
}

export interface WebhookEvent {
  type: string;
  data: { email_id: string; from: string; to: string[]; subject: string };
}

export interface ResendClient {
  sendEmail(params: SendEmailParams): Promise<{ id: string }>;
  getReceivedEmail(emailId: string): Promise<ReceivedEmail>;
  getAttachmentDownloadUrl(emailId: string, attachmentId: string): Promise<string>;
  verifyWebhookSignature(
    payload: string,
    headers: { id: string; timestamp: string; signature: string },
    secret: string,
  ): Promise<WebhookEvent | null>;
}

export function createResendClient(apiKey: string): ResendClient {
  const resend = new Resend(apiKey);

  return {
    async sendEmail(params) {
      const { data, error } = await resend.emails.send({
        from: params.from,
        to: params.to,
        subject: params.subject,
        text: params.text,
        headers: params.headers,
        attachments: params.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          content_type: a.contentType,
        })),
      });
      if (error) throw new Error(`Resend send failed: ${error.message}`);
      return { id: data!.id };
    },

    async getReceivedEmail(emailId) {
      const { data, error } = await resend.emails.receiving.get(emailId);
      if (error) throw new Error(`Resend receiving.get failed: ${error.message}`);
      return {
        emailId: data!.email_id,
        from: data!.from,
        to: data!.to,
        subject: data!.subject,
        text: data!.text,
        html: data!.html,
        headers: data!.headers,
        attachments: data!.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          contentType: a.content_type,
          size: a.size,
        })),
      };
    },

    async getAttachmentDownloadUrl(emailId, attachmentId) {
      const { data, error } = await resend.emails.receiving.attachments.get({ emailId, attachmentId });
      if (error) throw new Error(`Resend attachment fetch failed: ${error.message}`);
      return data!.download_url;
    },

    async verifyWebhookSignature(payload, headers, secret) {
      try {
        return (await resend.webhooks.verify({ payload, headers, webhookSecret: secret })) as WebhookEvent;
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mail/resendClient.test.ts`
Expected: PASS

Note: if `resend.emails.receiving` or `resend.webhooks.verify` are not present on the installed `resend` package version, run `npm ls resend` and check `node_modules/resend/package.json` version plus `node_modules/resend/dist/*.d.ts` for the actual method names/shapes, and adjust the implementation (not the test's intent) to match — the inbound-receiving feature is newer than the core send API and method names may have shifted since this plan was written.

- [ ] **Step 5: Commit**

```bash
git add src/mail/resendClient.ts tests/mail/resendClient.test.ts
git commit -m "feat: add Resend SDK wrapper (send, receive, webhook verify)"
```

---

### Task 6: outboundEmailService (send new / send reply)

**Files:**
- Create: `src/services/outboundEmailService.ts`
- Test: `tests/services/outboundEmailService.test.ts`

**Interfaces:**
- Consumes: `Db`, `createDb` (Task 1); `resolveBindingByChannel` (Task 3); `recordThreadMessage`, `resolveThreadByDiscordMessageId` (Task 4); `ResendClient`, `OutboundAttachment` (Task 5); `buildReplyHeaders`, `buildReplySubject` (Task 2)
- Produces:
  - `type OutboundResult = { ok: true; emailId: string } | { ok: false; error: string }`
  - `interface SendNewEmailInput { discordChannelId: string; discordMessageId: string; to: string; subject: string; body: string; attachments?: OutboundAttachment[] }`
  - `sendNewEmail(db: Db, resend: ResendClient, input: SendNewEmailInput): Promise<OutboundResult>`
  - `interface SendReplyEmailInput { discordChannelId: string; discordMessageId: string; repliedToDiscordMessageId: string; body: string; attachments?: OutboundAttachment[] }`
  - `sendReplyEmail(db: Db, resend: ResendClient, input: SendReplyEmailInput): Promise<OutboundResult>`

- [ ] **Step 1: Write the failing tests**

`tests/services/outboundEmailService.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import { recordThreadMessage, resolveThreadByDiscordMessageId } from '../../src/services/threadService';
import { sendNewEmail, sendReplyEmail } from '../../src/services/outboundEmailService';
import type { ResendClient } from '../../src/mail/resendClient';

function fakeResend(overrides: Partial<ResendClient> = {}): ResendClient {
  return {
    sendEmail: vi.fn().mockResolvedValue({ id: '<sent@x>' }),
    getReceivedEmail: vi.fn(),
    getAttachmentDownloadUrl: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    ...overrides,
  };
}

describe('outboundEmailService', () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb(':memory:');
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });
  });

  describe('sendNewEmail', () => {
    it('sends via Resend and records an outbound thread row', async () => {
      const resend = fakeResend();
      const result = await sendNewEmail(db, resend, {
        discordChannelId: 'chan-1',
        discordMessageId: 'discord-msg-1',
        to: 'friend@example.com',
        subject: 'Hi',
        body: 'Hello there',
      });

      expect(result).toEqual({ ok: true, emailId: '<sent@x>' });
      expect(resend.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        from: 'tako@octo.jp',
        to: 'friend@example.com',
        subject: 'Hi',
        text: 'Hello there',
      }));

      const thread = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
      expect(thread?.direction).toBe('outbound');
      expect(thread?.externalAddress).toBe('friend@example.com');
    });

    it('fails when the channel has no binding', async () => {
      const resend = fakeResend();
      const result = await sendNewEmail(db, resend, {
        discordChannelId: 'unbound-chan',
        discordMessageId: 'discord-msg-2',
        to: 'friend@example.com',
        subject: 'Hi',
        body: 'Hello',
      });
      expect(result.ok).toBe(false);
      expect(resend.sendEmail).not.toHaveBeenCalled();
    });

    it('returns an error result when Resend throws', async () => {
      const resend = fakeResend({ sendEmail: vi.fn().mockRejectedValue(new Error('rate limited')) });
      const result = await sendNewEmail(db, resend, {
        discordChannelId: 'chan-1',
        discordMessageId: 'discord-msg-3',
        to: 'friend@example.com',
        subject: 'Hi',
        body: 'Hello',
      });
      expect(result).toEqual({ ok: false, error: 'rate limited' });
    });
  });

  describe('sendReplyEmail', () => {
    it('resolves the original thread, sets reply headers, and records a new row', async () => {
      const binding = await createBinding(db, {
        emailAddress: 'tai@octo.jp',
        discordGuildId: 'guild-1',
        discordChannelId: 'chan-2',
        createdBy: 'user-1',
      });
      await recordThreadMessage(db, {
        discordMessageId: 'inbound-msg-1',
        bindingId: binding.id,
        externalAddress: 'friend@example.com',
        subject: 'Original subject',
        emailMessageId: '<orig@x>',
        inReplyTo: null,
        referencesChain: null,
        direction: 'inbound',
      });

      const resend = fakeResend();
      const result = await sendReplyEmail(db, resend, {
        discordChannelId: 'chan-2',
        discordMessageId: 'discord-reply-1',
        repliedToDiscordMessageId: 'inbound-msg-1',
        body: 'Thanks!',
      });

      expect(result).toEqual({ ok: true, emailId: '<sent@x>' });
      expect(resend.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        from: 'tai@octo.jp',
        to: 'friend@example.com',
        subject: 'Re: Original subject',
        text: 'Thanks!',
        headers: { 'In-Reply-To': '<orig@x>', References: '<orig@x>' },
      }));

      const newThread = await resolveThreadByDiscordMessageId(db, 'discord-reply-1');
      expect(newThread?.referencesChain).toBe('<orig@x>');
    });

    it('fails when the replied-to message has no known thread', async () => {
      const resend = fakeResend();
      const result = await sendReplyEmail(db, resend, {
        discordChannelId: 'chan-1',
        discordMessageId: 'discord-reply-2',
        repliedToDiscordMessageId: 'unknown-msg',
        body: 'Thanks!',
      });
      expect(result.ok).toBe(false);
      expect(resend.sendEmail).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/outboundEmailService.test.ts`
Expected: FAIL (`src/services/outboundEmailService.ts` does not exist)

- [ ] **Step 3: Implement `src/services/outboundEmailService.ts`**

```ts
import type { Db } from '../db/client';
import type { ResendClient, OutboundAttachment } from '../mail/resendClient';
import { resolveBindingByChannel } from './bindingService';
import { resolveThreadByDiscordMessageId, recordThreadMessage } from './threadService';
import { buildReplyHeaders, buildReplySubject } from '../mail/headers';

export type OutboundResult = { ok: true; emailId: string } | { ok: false; error: string };

export interface SendNewEmailInput {
  discordChannelId: string;
  discordMessageId: string;
  to: string;
  subject: string;
  body: string;
  attachments?: OutboundAttachment[];
}

export async function sendNewEmail(db: Db, resend: ResendClient, input: SendNewEmailInput): Promise<OutboundResult> {
  const binding = await resolveBindingByChannel(db, input.discordChannelId);
  if (!binding) {
    return { ok: false, error: 'このチャンネルはメールアドレスにバインドされていません。/mail bind で設定してください。' };
  }

  try {
    const { id } = await resend.sendEmail({
      from: binding.emailAddress,
      to: input.to,
      subject: input.subject,
      text: input.body,
      attachments: input.attachments,
    });

    await recordThreadMessage(db, {
      discordMessageId: input.discordMessageId,
      bindingId: binding.id,
      externalAddress: input.to,
      subject: input.subject,
      emailMessageId: id,
      inReplyTo: null,
      referencesChain: null,
      direction: 'outbound',
    });

    return { ok: true, emailId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SendReplyEmailInput {
  discordChannelId: string;
  discordMessageId: string;
  repliedToDiscordMessageId: string;
  body: string;
  attachments?: OutboundAttachment[];
}

export async function sendReplyEmail(db: Db, resend: ResendClient, input: SendReplyEmailInput): Promise<OutboundResult> {
  const binding = await resolveBindingByChannel(db, input.discordChannelId);
  if (!binding) {
    return { ok: false, error: 'このチャンネルはメールアドレスにバインドされていません。' };
  }

  const originalThread = await resolveThreadByDiscordMessageId(db, input.repliedToDiscordMessageId);
  if (!originalThread) {
    return { ok: false, error: '返信先のメールスレッドが見つかりませんでした。' };
  }

  const { inReplyTo, references } = buildReplyHeaders(originalThread.emailMessageId, originalThread.referencesChain);
  const subject = buildReplySubject(originalThread.subject);

  try {
    const { id } = await resend.sendEmail({
      from: binding.emailAddress,
      to: originalThread.externalAddress,
      subject,
      text: input.body,
      headers: { 'In-Reply-To': inReplyTo, References: references },
      attachments: input.attachments,
    });

    await recordThreadMessage(db, {
      discordMessageId: input.discordMessageId,
      bindingId: binding.id,
      externalAddress: originalThread.externalAddress,
      subject,
      emailMessageId: id,
      inReplyTo,
      referencesChain: references,
      direction: 'outbound',
    });

    return { ok: true, emailId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/outboundEmailService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/outboundEmailService.ts tests/services/outboundEmailService.test.ts
git commit -m "feat: add outboundEmailService for new/reply sends"
```

---

### Task 7: inboundEmailService (Resend → Discord)

**Files:**
- Create: `src/services/inboundEmailService.ts`
- Test: `tests/services/inboundEmailService.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 1); `resolveBindingByAddress`, `Binding` (Task 3); `recordThreadMessage` (Task 4); `ResendClient`, `ReceivedEmail` (Task 5); `extractEmailAddress` (Task 2); `stripHtml` (Task 2); `fetchAsBuffer` (Task 2)
- Produces:
  - `interface DiscordAttachmentInput { filename: string; content: Buffer }`
  - `interface DiscordPoster { postEmailMessage(channelId: string, params: { from: string; subject: string; bodyPreview: string; attachments: DiscordAttachmentInput[] }): Promise<{ discordMessageId: string }> }`
  - `handleInboundEmail(db: Db, resend: ResendClient, poster: DiscordPoster, emailId: string): Promise<{ handled: boolean; reason?: string }>`

- [ ] **Step 1: Write the failing tests**

`tests/services/inboundEmailService.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import { resolveThreadByDiscordMessageId } from '../../src/services/threadService';
import { handleInboundEmail, type DiscordPoster } from '../../src/services/inboundEmailService';
import type { ResendClient } from '../../src/mail/resendClient';

vi.mock('../../src/util/fetchBuffer', () => ({
  fetchAsBuffer: vi.fn().mockResolvedValue(Buffer.from('file-bytes')),
}));

function fakeResend(overrides: Partial<ResendClient> = {}): ResendClient {
  return {
    sendEmail: vi.fn(),
    getReceivedEmail: vi.fn(),
    getAttachmentDownloadUrl: vi.fn().mockResolvedValue('https://download/att-1'),
    verifyWebhookSignature: vi.fn(),
    ...overrides,
  };
}

describe('handleInboundEmail', () => {
  let db: Db;
  let poster: DiscordPoster;

  beforeEach(async () => {
    db = createDb(':memory:');
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });
    poster = { postEmailMessage: vi.fn().mockResolvedValue({ discordMessageId: 'discord-msg-1' }) };
  });

  it('posts to the bound channel and records the thread', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-1',
        from: 'Friend <friend@example.com>',
        to: ['tako@octo.jp'],
        subject: 'Hello',
        text: 'Body text',
        html: '<p>Body text</p>',
        headers: { 'Message-Id': '<orig@x>' },
        attachments: [{ id: 'att-1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 }],
      }),
    });

    const result = await handleInboundEmail(db, resend, poster, 'email-1');

    expect(result.handled).toBe(true);
    expect(poster.postEmailMessage).toHaveBeenCalledWith('chan-1', expect.objectContaining({
      from: 'Friend <friend@example.com>',
      subject: 'Hello',
      bodyPreview: 'Body text',
      attachments: [{ filename: 'a.pdf', content: Buffer.from('file-bytes') }],
    }));

    const thread = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
    expect(thread?.externalAddress).toBe('friend@example.com');
    expect(thread?.emailMessageId).toBe('<orig@x>');
    expect(thread?.direction).toBe('inbound');
  });

  it('falls back to a stripped HTML preview when text is empty', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-2',
        from: 'friend@example.com',
        to: ['tako@octo.jp'],
        subject: 'Hello',
        text: '',
        html: '<p>HTML only</p>',
        headers: { 'Message-Id': '<orig2@x>' },
        attachments: [],
      }),
    });

    await handleInboundEmail(db, resend, poster, 'email-2');

    expect(poster.postEmailMessage).toHaveBeenCalledWith('chan-1', expect.objectContaining({
      bodyPreview: 'HTML only',
    }));
  });

  it('reports unhandled when no binding matches any recipient', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-3',
        from: 'friend@example.com',
        to: ['unbound@octo.jp'],
        subject: 'Hello',
        text: 'Body',
        html: '',
        headers: {},
        attachments: [],
      }),
    });

    const result = await handleInboundEmail(db, resend, poster, 'email-3');
    expect(result.handled).toBe(false);
    expect(poster.postEmailMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/inboundEmailService.test.ts`
Expected: FAIL (`src/services/inboundEmailService.ts` does not exist)

- [ ] **Step 3: Implement `src/services/inboundEmailService.ts`**

```ts
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import { resolveBindingByAddress } from './bindingService';
import { recordThreadMessage } from './threadService';
import { extractEmailAddress } from '../mail/address';
import { stripHtml } from '../util/stripHtml';
import { fetchAsBuffer } from '../util/fetchBuffer';

export interface DiscordAttachmentInput {
  filename: string;
  content: Buffer;
}

export interface DiscordPoster {
  postEmailMessage(
    channelId: string,
    params: { from: string; subject: string; bodyPreview: string; attachments: DiscordAttachmentInput[] },
  ): Promise<{ discordMessageId: string }>;
}

const BODY_PREVIEW_MAX_LENGTH = 1800;

export async function handleInboundEmail(
  db: Db,
  resend: ResendClient,
  poster: DiscordPoster,
  emailId: string,
): Promise<{ handled: boolean; reason?: string }> {
  const email = await resend.getReceivedEmail(emailId);

  let binding = null;
  for (const address of email.to) {
    binding = await resolveBindingByAddress(db, address);
    if (binding) break;
  }
  if (!binding) {
    return { handled: false, reason: `no binding for recipients: ${email.to.join(', ')}` };
  }

  const attachments: DiscordAttachmentInput[] = [];
  for (const att of email.attachments) {
    const url = await resend.getAttachmentDownloadUrl(email.emailId, att.id);
    const content = await fetchAsBuffer(url);
    attachments.push({ filename: att.filename, content });
  }

  const rawBody = email.text || stripHtml(email.html) || '';
  const bodyPreview = rawBody.slice(0, BODY_PREVIEW_MAX_LENGTH);

  const { discordMessageId } = await poster.postEmailMessage(binding.discordChannelId, {
    from: email.from,
    subject: email.subject,
    bodyPreview,
    attachments,
  });

  const messageIdHeader =
    email.headers['Message-Id'] ?? email.headers['Message-ID'] ?? email.headers['message-id'] ?? emailId;

  await recordThreadMessage(db, {
    discordMessageId,
    bindingId: binding.id,
    externalAddress: extractEmailAddress(email.from),
    subject: email.subject,
    emailMessageId: messageIdHeader,
    inReplyTo: email.headers['In-Reply-To'] ?? null,
    referencesChain: email.headers['References'] ?? null,
    direction: 'inbound',
  });

  return { handled: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/inboundEmailService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/inboundEmailService.ts tests/services/inboundEmailService.test.ts
git commit -m "feat: add inboundEmailService for Resend->Discord forwarding"
```

---

### Task 8: Fastify web server + inbound webhook route

**Files:**
- Create: `src/web/server.ts`
- Test: `tests/web/server.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 1); `ResendClient` (Task 5); `DiscordPoster`, `handleInboundEmail` (Task 7)
- Produces: `createServer(db: Db, resend: ResendClient, poster: DiscordPoster, webhookSecret: string): FastifyInstance`

- [ ] **Step 1: Install fastify's Node test helper (already have `fastify`; add nothing extra — `fastify.inject()` is built in)**

- [ ] **Step 2: Write the failing test**

`tests/web/server.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from '../../src/web/server';
import type { ResendClient } from '../../src/mail/resendClient';
import type { DiscordPoster } from '../../src/services/inboundEmailService';
import { createDb } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';

// Resend webhook signatures follow the Svix scheme: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${payload}`)),
// with the secret being the base64 payload after the `whsec_` prefix.
function signSvix(secret: string, id: string, timestamp: string, payload: string): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${payload}`;
  const sig = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('POST /webhooks/resend/inbound', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

  it('returns 401 when the signature is invalid', async () => {
    const db = createDb(':memory:');
    const resend = { verifyWebhookSignature: vi.fn().mockResolvedValue(null) } as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn() } as unknown as DiscordPoster;
    const app = createServer(db, resend, poster, secret);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend/inbound',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': '1700000000',
        'svix-signature': 'v1,invalid',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('verifies a genuine Svix-style signature and invokes the inbound handler', async () => {
    const db = createDb(':memory:');
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });

    const payload = JSON.stringify({
      type: 'email.received',
      created_at: '2026-08-27T00:00:00.000Z',
      data: { email_id: 'email-1', from: 'friend@example.com', to: ['tako@octo.jp'], subject: 'Hi' },
    });
    const id = 'msg_1';
    const timestamp = '1700000000';
    const signature = signSvix(secret, id, timestamp, payload);

    const { Resend } = await import('resend');
    const realResend = new Resend('re_test');
    // Exercise the real Resend SDK's verification against our manually-built signature.
    // If this throws, the manual signing above no longer matches the SDK's algorithm —
    // inspect node_modules/resend's webhooks implementation and adjust `signSvix`.
    await expect(
      realResend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret: secret }),
    ).resolves.toMatchObject({ type: 'email.received' });

    const resend = {
      verifyWebhookSignature: vi.fn().mockResolvedValue({
        type: 'email.received',
        data: { email_id: 'email-1', from: 'friend@example.com', to: ['tako@octo.jp'], subject: 'Hi' },
      }),
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-1',
        from: 'friend@example.com',
        to: ['tako@octo.jp'],
        subject: 'Hi',
        text: 'body',
        html: '',
        headers: {},
        attachments: [],
      }),
      getAttachmentDownloadUrl: vi.fn(),
      sendEmail: vi.fn(),
    } as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn().mockResolvedValue({ discordMessageId: 'discord-msg-1' }) } as unknown as DiscordPoster;
    const app = createServer(db, resend, poster, secret);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend/inbound',
      payload,
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': signature,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(poster.postEmailMessage).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/web/server.test.ts`
Expected: FAIL (`src/web/server.ts` does not exist)

- [ ] **Step 4: Implement `src/web/server.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import type { DiscordPoster } from '../services/inboundEmailService';
import { handleInboundEmail } from '../services/inboundEmailService';

export function createServer(
  db: Db,
  resend: ResendClient,
  poster: DiscordPoster,
  webhookSecret: string,
): FastifyInstance {
  const app = Fastify();

  // Keep the raw request body so the Resend/Svix signature can be verified byte-for-byte.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/webhooks/resend/inbound', async (request, reply) => {
    const rawBody = request.body as string;

    const event = await resend.verifyWebhookSignature(
      rawBody,
      {
        id: request.headers['svix-id'] as string,
        timestamp: request.headers['svix-timestamp'] as string,
        signature: request.headers['svix-signature'] as string,
      },
      webhookSecret,
    );

    if (!event) {
      reply.code(401).send({ error: 'invalid signature' });
      return;
    }

    if (event.type !== 'email.received') {
      reply.code(200).send({ ok: true, handled: false });
      return;
    }

    const result = await handleInboundEmail(db, resend, poster, event.data.email_id);
    reply.code(200).send({ ok: true, handled: result.handled });
  });

  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/web/server.test.ts`
Expected: PASS

If the "genuine signature" test fails at the `realResend.webhooks.verify(...)` assertion (not at the route-level assertions), the manually-implemented `signSvix` helper doesn't match the installed `resend` package's algorithm — read `node_modules/resend/dist/**/webhooks*.js` to find the actual signing scheme and fix `signSvix` accordingly; do not weaken the route implementation to work around it.

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts tests/web/server.test.ts
git commit -m "feat: add Fastify server with verified Resend inbound webhook route"
```

---

### Task 9: Bot command handlers (bind / unbind / list / send)

**Files:**
- Create: `src/bot/commands/bindHandler.ts`
- Create: `src/bot/commands/sendHandler.ts`
- Test: `tests/bot/commands/bindHandler.test.ts`, `tests/bot/commands/sendHandler.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 1); `createBinding`, `removeBinding`, `listBindingsForGuild`, `resolveBindingByChannel` (Task 3); `ResendClient` (Task 5); `sendNewEmail` (Task 6)
- Produces:
  - `interface CommandResult { replyText: string }`
  - `handleBindCommand(db: Db, input: { discordGuildId: string; discordChannelId: string; emailAddress: string; requestedBy: string }): Promise<CommandResult>`
  - `handleUnbindCommand(db: Db, input: { discordChannelId: string }): Promise<CommandResult>`
  - `handleListCommand(db: Db, input: { discordGuildId: string }): Promise<CommandResult>`
  - `handleSendCommand(db: Db, resend: ResendClient, input: { discordChannelId: string; discordMessageId: string; to: string; subject: string; body: string; attachments?: OutboundAttachment[] }): Promise<CommandResult>`

- [ ] **Step 1: Write the failing tests for bind/unbind/list**

`tests/bot/commands/bindHandler.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../../src/db/client';
import { handleBindCommand, handleUnbindCommand, handleListCommand } from '../../../src/bot/commands/bindHandler';

describe('bind/unbind/list command handlers', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('binds a channel to an address', async () => {
    const result = await handleBindCommand(db, {
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      emailAddress: 'tako@octo.jp',
      requestedBy: 'user-1',
    });
    expect(result.replyText).toContain('tako@octo.jp');
  });

  it('rebinding a channel replaces the previous binding', async () => {
    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tako@octo.jp', requestedBy: 'u1' });
    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tai@octo.jp', requestedBy: 'u1' });

    const list = await handleListCommand(db, { discordGuildId: 'g1' });
    expect(list.replyText).toContain('tai@octo.jp');
    expect(list.replyText).not.toContain('tako@octo.jp');
  });

  it('unbind reports whether a binding existed', async () => {
    const notBound = await handleUnbindCommand(db, { discordChannelId: 'chan-1' });
    expect(notBound.replyText).toContain('バインドされていません');

    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tako@octo.jp', requestedBy: 'u1' });
    const bound = await handleUnbindCommand(db, { discordChannelId: 'chan-1' });
    expect(bound.replyText).toContain('解除');
  });

  it('list reports when there are no bindings', async () => {
    const result = await handleListCommand(db, { discordGuildId: 'empty-guild' });
    expect(result.replyText).toContain('ありません');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bot/commands/bindHandler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/bot/commands/bindHandler.ts`**

```ts
import type { Db } from '../../db/client';
import { createBinding, removeBinding, listBindingsForGuild, resolveBindingByChannel } from '../../services/bindingService';

export interface CommandResult {
  replyText: string;
}

export interface BindInput {
  discordGuildId: string;
  discordChannelId: string;
  emailAddress: string;
  requestedBy: string;
}

export async function handleBindCommand(db: Db, input: BindInput): Promise<CommandResult> {
  const existing = await resolveBindingByChannel(db, input.discordChannelId);
  if (existing) {
    await removeBinding(db, input.discordChannelId);
  }
  await createBinding(db, {
    emailAddress: input.emailAddress,
    discordGuildId: input.discordGuildId,
    discordChannelId: input.discordChannelId,
    createdBy: input.requestedBy,
  });
  return { replyText: `このチャンネルを \`${input.emailAddress}\` にバインドしました。` };
}

export interface UnbindInput {
  discordChannelId: string;
}

export async function handleUnbindCommand(db: Db, input: UnbindInput): Promise<CommandResult> {
  const removed = await removeBinding(db, input.discordChannelId);
  return { replyText: removed ? 'バインドを解除しました。' : 'このチャンネルはバインドされていません。' };
}

export interface ListInput {
  discordGuildId: string;
}

export async function handleListCommand(db: Db, input: ListInput): Promise<CommandResult> {
  const bindings = await listBindingsForGuild(db, input.discordGuildId);
  if (bindings.length === 0) {
    return { replyText: 'このサーバーにはバインドがありません。' };
  }
  const lines = bindings.map((b) => `<#${b.discordChannelId}> ⇔ \`${b.emailAddress}\``);
  return { replyText: lines.join('\n') };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bot/commands/bindHandler.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for send**

`tests/bot/commands/sendHandler.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, type Db } from '../../../src/db/client';
import { createBinding } from '../../../src/services/bindingService';
import { handleSendCommand } from '../../../src/bot/commands/sendHandler';
import type { ResendClient } from '../../../src/mail/resendClient';

describe('handleSendCommand', () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb(':memory:');
    await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'g1', discordChannelId: 'chan-1', createdBy: 'u1' });
  });

  it('reports success when the send succeeds', async () => {
    const resend = { sendEmail: vi.fn().mockResolvedValue({ id: '<x@y>' }) } as unknown as ResendClient;
    const result = await handleSendCommand(db, resend, {
      discordChannelId: 'chan-1',
      discordMessageId: 'discord-msg-1',
      to: 'friend@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(result.replyText).toContain('friend@example.com');
  });

  it('reports the error when the send fails', async () => {
    const resend = { sendEmail: vi.fn().mockRejectedValue(new Error('rate limited')) } as unknown as ResendClient;
    const result = await handleSendCommand(db, resend, {
      discordChannelId: 'chan-1',
      discordMessageId: 'discord-msg-2',
      to: 'friend@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(result.replyText).toContain('rate limited');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/bot/commands/sendHandler.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement `src/bot/commands/sendHandler.ts`**

```ts
import type { Db } from '../../db/client';
import type { ResendClient, OutboundAttachment } from '../../mail/resendClient';
import { sendNewEmail } from '../../services/outboundEmailService';
import type { CommandResult } from './bindHandler';

export interface SendCommandInput {
  discordChannelId: string;
  discordMessageId: string;
  to: string;
  subject: string;
  body: string;
  attachments?: OutboundAttachment[];
}

export async function handleSendCommand(db: Db, resend: ResendClient, input: SendCommandInput): Promise<CommandResult> {
  const result = await sendNewEmail(db, resend, input);
  if (!result.ok) {
    return { replyText: `送信に失敗しました: ${result.error}` };
  }
  return { replyText: `送信しました(${input.to} 宛)。` };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/bot/commands/sendHandler.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/bot/commands/bindHandler.ts src/bot/commands/sendHandler.ts tests/bot/commands/bindHandler.test.ts tests/bot/commands/sendHandler.test.ts
git commit -m "feat: add slash command handlers for bind/unbind/list/send"
```

---

### Task 10: Discord message reply classification

**Files:**
- Create: `src/bot/replyDetection.ts`
- Test: `tests/bot/replyDetection.test.ts`

**Interfaces:**
- Produces:
  - `interface IncomingDiscordMessage { channelId: string; messageId: string; authorIsBot: boolean; content: string; referencedMessageId: string | null; attachments: { filename: string; url: string }[] }`
  - `type MessageIntent = { kind: 'ignore' } | { kind: 'reply'; repliedToDiscordMessageId: string; body: string; attachments: { filename: string; url: string }[] }`
  - `classifyIncomingMessage(msg: IncomingDiscordMessage): MessageIntent`

- [ ] **Step 1: Write the failing test**

`tests/bot/replyDetection.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { classifyIncomingMessage } from '../../src/bot/replyDetection';

describe('classifyIncomingMessage', () => {
  it('ignores messages from bots', () => {
    const result = classifyIncomingMessage({
      channelId: 'c1', messageId: 'm1', authorIsBot: true, content: 'hi', referencedMessageId: null, attachments: [],
    });
    expect(result.kind).toBe('ignore');
  });

  it('ignores plain messages with no reply target', () => {
    const result = classifyIncomingMessage({
      channelId: 'c1', messageId: 'm1', authorIsBot: false, content: 'hi', referencedMessageId: null, attachments: [],
    });
    expect(result.kind).toBe('ignore');
  });

  it('classifies a reply message with its target and body', () => {
    const result = classifyIncomingMessage({
      channelId: 'c1', messageId: 'm1', authorIsBot: false, content: 'Thanks!', referencedMessageId: 'orig-1',
      attachments: [{ filename: 'a.png', url: 'https://x/a.png' }],
    });
    expect(result).toEqual({
      kind: 'reply',
      repliedToDiscordMessageId: 'orig-1',
      body: 'Thanks!',
      attachments: [{ filename: 'a.png', url: 'https://x/a.png' }],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bot/replyDetection.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/bot/replyDetection.ts`**

```ts
export interface IncomingDiscordMessage {
  channelId: string;
  messageId: string;
  authorIsBot: boolean;
  content: string;
  referencedMessageId: string | null;
  attachments: { filename: string; url: string }[];
}

export type MessageIntent =
  | { kind: 'ignore' }
  | { kind: 'reply'; repliedToDiscordMessageId: string; body: string; attachments: { filename: string; url: string }[] };

export function classifyIncomingMessage(msg: IncomingDiscordMessage): MessageIntent {
  if (msg.authorIsBot) return { kind: 'ignore' };
  if (!msg.referencedMessageId) return { kind: 'ignore' };
  return {
    kind: 'reply',
    repliedToDiscordMessageId: msg.referencedMessageId,
    body: msg.content,
    attachments: msg.attachments,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bot/replyDetection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/replyDetection.ts tests/bot/replyDetection.test.ts
git commit -m "feat: add reply-vs-ignore classification for incoming Discord messages"
```

---

### Task 11: Discord.js wiring (client, slash command registration, event handlers)

**Files:**
- Create: `src/bot/commands/definitions.ts`
- Create: `src/bot/registerCommands.ts`
- Create: `src/bot/registerCommandsCli.ts`
- Create: `src/bot/client.ts`

**Interfaces:**
- Consumes: `Db` (Task 1); `ResendClient` (Task 5); `handleBindCommand`, `handleUnbindCommand`, `handleListCommand` (Task 9); `handleSendCommand` (Task 9); `classifyIncomingMessage` (Task 10); `sendReplyEmail` (Task 6); `fetchAsBuffer` (Task 2); `DiscordPoster` (Task 7); `loadEnv` (Task 1)
- Produces:
  - `createBotClient(db: Db, resend: ResendClient): Client` (discord.js `Client`)
  - `createDiscordPoster(client: Client): DiscordPoster`
  - `registerCommands(applicationId: string, token: string): Promise<void>`

This task is Discord.js SDK glue code with no meaningful pure-function surface to unit test — its correctness is verified by type-checking against discord.js's types and by the manual end-to-end check in Task 12. Each step below is still committed independently so a reviewer can inspect it in isolation.

- [ ] **Step 1: Write `src/bot/commands/definitions.ts`**

```ts
import { SlashCommandBuilder } from 'discord.js';

export const mailCommand = new SlashCommandBuilder()
  .setName('mail')
  .setDescription('メールをDiscordで送受信する')
  .addSubcommand((sub) =>
    sub
      .setName('bind')
      .setDescription('このチャンネルをメールアドレスにバインドする')
      .addStringOption((opt) => opt.setName('address').setDescription('メールアドレス').setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName('unbind').setDescription('このチャンネルのバインドを解除する'))
  .addSubcommand((sub) => sub.setName('list').setDescription('このサーバーのバインド一覧を表示する'))
  .addSubcommand((sub) =>
    sub
      .setName('send')
      .setDescription('新規メールを送信する')
      .addStringOption((opt) => opt.setName('to').setDescription('宛先メールアドレス').setRequired(true))
      .addStringOption((opt) => opt.setName('subject').setDescription('件名').setRequired(true))
      .addStringOption((opt) => opt.setName('body').setDescription('本文').setRequired(true))
      .addAttachmentOption((opt) => opt.setName('attachment').setDescription('添付ファイル').setRequired(false)),
  );
```

- [ ] **Step 2: Write `src/bot/registerCommands.ts`**

```ts
import { REST, Routes } from 'discord.js';
import { mailCommand } from './commands/definitions';

export async function registerCommands(applicationId: string, token: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), {
    body: [mailCommand.toJSON()],
  });
}
```

- [ ] **Step 3: Write `src/bot/registerCommandsCli.ts`**

```ts
import { loadEnv } from '../env';
import { registerCommands } from './registerCommands';

const env = loadEnv();

registerCommands(env.DISCORD_APPLICATION_ID, env.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log('Slash commands registered.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

- [ ] **Step 4: Write `src/bot/client.ts`**

```ts
import { Client, GatewayIntentBits, Events, EmbedBuilder, TextChannel } from 'discord.js';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import type { DiscordPoster } from '../services/inboundEmailService';
import { handleBindCommand, handleUnbindCommand, handleListCommand } from './commands/bindHandler';
import { handleSendCommand } from './commands/sendHandler';
import { classifyIncomingMessage } from './replyDetection';
import { sendReplyEmail } from '../services/outboundEmailService';
import { fetchAsBuffer } from '../util/fetchBuffer';

export function createBotClient(db: Db, resend: ResendClient): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'mail') return;

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();

    if (sub === 'bind') {
      const address = interaction.options.getString('address', true);
      const result = await handleBindCommand(db, {
        discordGuildId: interaction.guildId!,
        discordChannelId: interaction.channelId,
        emailAddress: address,
        requestedBy: interaction.user.id,
      });
      await interaction.editReply(result.replyText);
      return;
    }

    if (sub === 'unbind') {
      const result = await handleUnbindCommand(db, { discordChannelId: interaction.channelId });
      await interaction.editReply(result.replyText);
      return;
    }

    if (sub === 'list') {
      const result = await handleListCommand(db, { discordGuildId: interaction.guildId! });
      await interaction.editReply(result.replyText);
      return;
    }

    if (sub === 'send') {
      const to = interaction.options.getString('to', true);
      const subject = interaction.options.getString('subject', true);
      const body = interaction.options.getString('body', true);
      const attachment = interaction.options.getAttachment('attachment');
      const attachments = attachment
        ? [{ filename: attachment.name, content: await fetchAsBuffer(attachment.url) }]
        : [];

      const reply = await interaction.editReply('送信中...');
      const result = await handleSendCommand(db, resend, {
        discordChannelId: interaction.channelId,
        discordMessageId: reply.id,
        to,
        subject,
        body,
        attachments,
      });
      await interaction.editReply(result.replyText);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const intent = classifyIncomingMessage({
      channelId: message.channelId,
      messageId: message.id,
      authorIsBot: message.author.bot,
      content: message.content,
      referencedMessageId: message.reference?.messageId ?? null,
      attachments: [...message.attachments.values()].map((a) => ({ filename: a.name, url: a.url })),
    });

    if (intent.kind === 'ignore') return;

    const attachments = await Promise.all(
      intent.attachments.map(async (a) => ({ filename: a.filename, content: await fetchAsBuffer(a.url) })),
    );

    const result = await sendReplyEmail(db, resend, {
      discordChannelId: message.channelId,
      discordMessageId: message.id,
      repliedToDiscordMessageId: intent.repliedToDiscordMessageId,
      body: intent.body,
      attachments,
    });

    if (result.ok) {
      await message.react('✅');
    } else {
      await message.react('❌');
      await message.reply(`送信に失敗しました: ${result.error}`);
    }
  });

  return client;
}

export function createDiscordPoster(client: Client): DiscordPoster {
  return {
    async postEmailMessage(channelId, params) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error(`channel ${channelId} is not a text channel`);
      }
      const embed = new EmbedBuilder()
        .setTitle(params.subject || '(件名なし)')
        .setAuthor({ name: params.from })
        .setDescription(params.bodyPreview || '(本文なし)');
      const message = await channel.send({
        embeds: [embed],
        files: params.attachments.map((a) => ({ attachment: a.content, name: a.filename })),
      });
      return { discordMessageId: message.id };
    },
  };
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If discord.js's types differ from what's used here (e.g. `interaction.options.getAttachment` signature, `TextChannel` import path), fix the code in this file to match the installed discord.js version's types — check `node_modules/discord.js/typings/index.d.ts` for the exact signatures.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/definitions.ts src/bot/registerCommands.ts src/bot/registerCommandsCli.ts src/bot/client.ts
git commit -m "feat: wire discord.js client, slash commands, and message handling"
```

---

### Task 12: App entrypoint, Docker deployment, and manual end-to-end verification

**Files:**
- Create: `src/index.ts`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `Caddyfile`
- Create: `.env.example`

**Interfaces:**
- Consumes: everything produced by Tasks 1–11.

- [ ] **Step 1: Write `src/index.ts`**

```ts
import { loadEnv } from './env';
import { createDb } from './db/client';
import { createResendClient } from './mail/resendClient';
import { createServer } from './web/server';
import { createBotClient, createDiscordPoster } from './bot/client';

async function main() {
  const env = loadEnv();
  const db = createDb(env.DB_PATH);
  const resend = createResendClient(env.RESEND_API_KEY);

  const bot = createBotClient(db, resend);
  const poster = createDiscordPoster(bot);
  const server = createServer(db, resend, poster, env.RESEND_WEBHOOK_SECRET);

  await bot.login(env.DISCORD_BOT_TOKEN);
  await server.listen({ host: '0.0.0.0', port: env.PORT });

  console.log(`mailcord listening on :${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(Slash command registration is a separate one-off step via `npm run register-commands`, not run on every boot — Discord's global command registration can take up to an hour to propagate and doesn't need to run per-deploy.)

- [ ] **Step 2: Manual smoke test of the entrypoint**

```bash
cp .env.example .env
# fill in real DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, RESEND_API_KEY, RESEND_WEBHOOK_SECRET in .env
npm run build
DB_PATH=./data/smoke-test.db node -r dotenv/config dist/index.js
```

Expected: process logs `mailcord listening on :8787` and does not crash. Stop with Ctrl+C, then `rm ./data/smoke-test.db`.

- [ ] **Step 3: Write `.env.example`**

```
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
DB_PATH=./data/mailcord.db
PORT=8787
```

- [ ] **Step 4: Write `Dockerfile`**

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
```

- [ ] **Step 5: Write `docker-compose.yml`**

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    environment:
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - DISCORD_APPLICATION_ID=${DISCORD_APPLICATION_ID}
      - RESEND_API_KEY=${RESEND_API_KEY}
      - RESEND_WEBHOOK_SECRET=${RESEND_WEBHOOK_SECRET}
      - DB_PATH=/app/data/mailcord.db
      - PORT=8787
    volumes:
      - mailcord_data:/app/data
    expose:
      - "8787"

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app

volumes:
  mailcord_data:
  caddy_data:
  caddy_config:
```

- [ ] **Step 6: Write `Caddyfile`**

```
mail-hook.example.com {
  reverse_proxy app:8787
}
```

(Replace `mail-hook.example.com` with the real subdomain used for the Resend inbound webhook URL, and point its DNS A/AAAA record at the VPS before starting Caddy so it can obtain a TLS certificate.)

- [ ] **Step 7: Build and start the stack**

```bash
docker compose build
docker compose up -d
docker compose logs -f app
```

Expected: `app` logs `mailcord listening on :8787` and does not restart-loop. Stop watching with Ctrl+C once confirmed; leave the stack running or `docker compose down` if this was just a build check.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts Dockerfile docker-compose.yml Caddyfile .env.example
git commit -m "feat: add entrypoint and Docker Compose deployment"
```

- [ ] **Step 9: Manual end-to-end verification checklist (post-deploy, real accounts required)**

These steps require a real Discord application/bot, a real Resend account with a verified sending domain, and DNS control — run once the stack above is deployed:

1. In the Discord Developer Portal, enable the **Message Content Intent** for the bot (required for `Events.MessageCreate` to see message text) and invite the bot to a test server with `applications.commands` + `bot` scopes and `Send Messages`/`Read Message History` permissions.
2. Run `npm run register-commands` once (locally or via `docker compose exec app node dist/bot/registerCommandsCli.js` after adjusting the build to include it) and wait for Discord to propagate the `/mail` command.
3. In Resend, verify the sending domain (SPF/DKIM) and configure inbound routing (MX record) plus a webhook pointed at `https://<your-subdomain>/webhooks/resend/inbound` for the `email.received` event, using the same secret as `RESEND_WEBHOOK_SECRET`.
4. In a test channel, run `/mail bind address:you@yourdomain.com`.
5. Send an email from an external mailbox to `you@yourdomain.com`. Confirm it appears as an embed in the bound Discord channel within a few seconds.
6. Reply to that embed message in Discord. Confirm the external mailbox receives a reply in the same email thread (check the `In-Reply-To`/`References` headers in the received email's raw source).
7. Run `/mail send to:<some other address> subject:Test body:Hello` in the bound channel. Confirm the recipient receives it and that it is *not* threaded under an unrelated conversation.
8. Send a plain (non-reply) message in the bound channel. Confirm no email is sent.

---

## Self-Review Notes

- **Spec coverage:** address↔channel binding (Task 3, 9), reply-based thread resolution (Task 4, 6, 10, 11), `/mail send` for new mail (Task 6, 9, 11), inbound webhook + signature verification (Task 5, 8), attachments both directions (Task 5 send/receive paths, Task 7, Task 11's send/messageCreate handlers), error handling via reactions/replies (Task 11), Docker Compose + Caddy deployment (Task 12) — all covered.
- **Added beyond the spec's literal data model:** `email_threads.subject` column (Task 1) — required to send a reply email (Resend requires `subject`); the spec's data model sketch omitted it but nothing in the spec precludes it.
- **Type consistency checked:** `Binding`, `ThreadRecord`, `ResendClient`/`OutboundAttachment`/`ReceivedEmail`, `DiscordPoster`/`DiscordAttachmentInput`, `CommandResult`, `MessageIntent` are defined once (Tasks 1, 3, 4, 5, 7, 9, 10) and reused with matching names/shapes in every later task that consumes them.
