import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const addressBindings = sqliteTable('address_bindings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  emailAddress: text('email_address').notNull().unique(),
  discordGuildId: text('discord_guild_id').notNull(),
  discordChannelId: text('discord_channel_id').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

// Tracks Resend inbound email ids we've already handled, so a webhook redelivery (e.g. Resend
// retrying after the process was down or a handler error) doesn't double-post to Discord.
export const processedInboundEmails = sqliteTable('processed_inbound_emails', {
  resendEmailId: text('resend_email_id').primaryKey(),
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
