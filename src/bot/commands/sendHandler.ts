import type { Db } from '../../db/client';
import type { OutboundAttachment } from '../../mail/resendClient';
import { sendNewEmail, type OutboundProviders } from '../../services/outboundEmailService';
import type { CommandResult } from './types';

export interface SendCommandInput {
  discordChannelId: string;
  discordMessageId: string;
  to: string;
  subject: string;
  body: string;
  attachments?: OutboundAttachment[];
}

export async function handleSendCommand(db: Db, providers: OutboundProviders, input: SendCommandInput): Promise<CommandResult> {
  const result = await sendNewEmail(db, providers, input);
  if (!result.ok) {
    return { replyText: `送信に失敗しました: ${result.error}` };
  }
  return { replyText: `送信しました(${input.to} 宛)。` };
}
