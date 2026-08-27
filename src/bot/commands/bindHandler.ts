import type { Db } from '../../db/client';
import {
  createBinding,
  removeBinding,
  listBindingsForGuild,
  resolveBindingByChannel,
  resolveBindingByAddress,
} from '../../services/bindingService';

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
  const emailAddress = input.emailAddress.trim().toLowerCase();

  // `address_bindings.email_address` is UNIQUE, so binding an address that another channel
  // already owns would throw at the DB level. Detect it first and answer with a friendly message.
  const boundElsewhere = await resolveBindingByAddress(db, emailAddress);
  if (boundElsewhere && boundElsewhere.discordChannelId !== input.discordChannelId) {
    return {
      replyText: `\`${emailAddress}\` は既に <#${boundElsewhere.discordChannelId}> にバインドされています。先にそのチャンネルで \`/mail unbind\` を実行してください。`,
    };
  }

  const existing = await resolveBindingByChannel(db, input.discordChannelId);
  if (existing) {
    await removeBinding(db, input.discordChannelId);
  }
  await createBinding(db, {
    emailAddress,
    discordGuildId: input.discordGuildId,
    discordChannelId: input.discordChannelId,
    createdBy: input.requestedBy,
  });
  return { replyText: `このチャンネルを \`${emailAddress}\` にバインドしました。` };
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
