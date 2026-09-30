import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const addressBindings = sqliteTable('address_bindings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  emailAddress: text('email_address').notNull().unique(),
  discordGuildId: text('discord_guild_id').notNull(),
  discordChannelId: text('discord_channel_id').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  // 'resend' bindings are on a self-owned domain and go through the Resend webhook/send API.
  // 'gmail' bindings are a personal Gmail account authorized via OAuth2 and polled/sent via the
  // Gmail API. Default keeps every pre-existing row (and every insert that doesn't care) Resend.
  provider: text('provider', { enum: ['resend', 'gmail'] }).notNull().default('resend'),
});

// Tracks Resend inbound email ids we've already handled, so a webhook redelivery (e.g. Resend
// retrying after the process was down or a handler error) doesn't double-post to Discord.
export const processedInboundEmails = sqliteTable('processed_inbound_emails', {
  resendEmailId: text('resend_email_id').primaryKey(),
  createdAt: text('created_at').notNull(),
});

// Sender addresses an admin has explicitly blocked; matching inbound mail is redirected to the
// spam-review channel instead of the bound channel.
export const blockedSenders = sqliteTable('blocked_senders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  emailAddress: text('email_address').notNull().unique(),
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
  // Gmail's own thread id (distinct from the Message-ID chain above), so outbound Gmail replies
  // can be sent with `threadId` set and land in the same native Gmail thread. Null for Resend rows.
  gmailThreadId: text('gmail_thread_id'),
});

// 1:1 with a provider='gmail' address_bindings row. Holds the OAuth credentials and the Gmail
// History API cursor used for polling. Refresh/access tokens are stored encrypted (AES-256-GCM,
// see gmailAccountService.ts) since they grant standing access to someone's personal inbox.
export const gmailAccounts = sqliteTable('gmail_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bindingId: integer('binding_id').notNull().unique().references(() => addressBindings.id),
  encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
  encryptedAccessToken: text('encrypted_access_token'),
  accessTokenExpiresAt: text('access_token_expires_at'),
  // Gmail returns historyId as a large decimal string (can exceed safe JS integer range), so
  // this is stored as TEXT and passed through opaquely rather than parsed as a number.
  historyId: text('history_id').notNull(),
  lastPolledAt: text('last_polled_at'),
  createdAt: text('created_at').notNull(),
});

// Short-lived CSRF state for the Gmail OAuth2 authorization-code flow. Each row maps a random
// state token to the Discord context that started the flow, so the callback (a bare HTTP
// redirect with no Discord session of its own) knows which channel to bind and can reject
// forged/expired/replayed callbacks. Rows are deleted on first use (success or failure) and
// opportunistically swept for expiry on every callback hit, since this project has no cron.
export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  discordGuildId: text('discord_guild_id').notNull(),
  discordChannelId: text('discord_channel_id').notNull(),
  requestedBy: text('requested_by').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

// Dedup for the Gmail polling loop, mirroring processed_inbound_emails: if the process crashes
// after posting to Discord but before persisting the advanced historyId, the next tick must not
// re-post the same message.
export const processedGmailMessages = sqliteTable('processed_gmail_messages', {
  gmailMessageId: text('gmail_message_id').primaryKey(),
  createdAt: text('created_at').notNull(),
});
