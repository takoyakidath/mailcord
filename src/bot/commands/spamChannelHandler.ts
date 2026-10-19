import type { Db } from '../../db/client';
import { getSpamChannelId, setSpamChannelId } from '../../services/guildSettingsService';
import type { CommandResult } from './types';

export interface SpamChannelSetInput {
  discordGuildId: string;
  channelId: string;
  requestedBy: string;
}

export async function handleSpamChannelSetCommand(db: Db, input: SpamChannelSetInput): Promise<CommandResult> {
  await setSpamChannelId(db, input.discordGuildId, input.channelId, input.requestedBy);
  return { replyText: `<#${input.channelId}> を迷惑メールチャンネルに設定しました。ブロック済み送信者のメールと報告されたメールはここに転送されます。` };
}

export async function handleSpamChannelClearCommand(db: Db, input: { discordGuildId: string; requestedBy: string }): Promise<CommandResult> {
  await setSpamChannelId(db, input.discordGuildId, null, input.requestedBy);
  return { replyText: '迷惑メールチャンネルの設定を解除しました。' };
}

export async function handleSpamChannelShowCommand(db: Db, input: { discordGuildId: string; fallbackChannelId?: string }): Promise<CommandResult> {
  const configured = await getSpamChannelId(db, input.discordGuildId);
  if (configured) return { replyText: `迷惑メールチャンネル: <#${configured}>` };
  if (input.fallbackChannelId) return { replyText: `迷惑メールチャンネル: <#${input.fallbackChannelId}>(環境変数 SPAM_CHANNEL_ID の既定値)` };
  return { replyText: '迷惑メールチャンネルは未設定です。`/mail spam-channel set` で設定してください。' };
}
