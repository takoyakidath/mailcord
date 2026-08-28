import type { Db } from '../../db/client';
import type { ResendClient, OutboundAttachment } from '../../mail/resendClient';
import { sendNewEmail } from '../../services/outboundEmailService';
import type { CommandResult } from './types';

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
