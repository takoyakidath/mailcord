import type { Db } from '../../db/client';
import { blockSender, unblockSender, listBlockedSenders } from '../../services/blocklistService';
import { isValidEmailAddress } from '../../mail/address';
import type { CommandResult } from './types';

export type { CommandResult };

export interface BlockAddInput {
  emailAddress: string;
  requestedBy: string;
}

export async function handleBlockAddCommand(db: Db, input: BlockAddInput): Promise<CommandResult> {
  const emailAddress = input.emailAddress.trim().toLowerCase();
  if (!isValidEmailAddress(emailAddress)) {
    return { replyText: `\`${input.emailAddress}\` は有効なメールアドレスの形式ではありません。` };
  }
  await blockSender(db, { emailAddress, createdBy: input.requestedBy });
  return { replyText: `\`${emailAddress}\` をブロックしました。このアドレスからの受信メールは迷惑メールチャンネルに転送されます。` };
}

export interface BlockRemoveInput {
  emailAddress: string;
}

export async function handleBlockRemoveCommand(db: Db, input: BlockRemoveInput): Promise<CommandResult> {
  const emailAddress = input.emailAddress.trim().toLowerCase();
  const removed = await unblockSender(db, emailAddress);
  return { replyText: removed ? `\`${emailAddress}\` のブロックを解除しました。` : `\`${emailAddress}\` はブロックされていません。` };
}

export async function handleBlockListCommand(db: Db): Promise<CommandResult> {
  const blocked = await listBlockedSenders(db);
  if (blocked.length === 0) {
    return { replyText: 'ブロック中の送信者はいません。' };
  }
  const lines = blocked.map((b) => `\`${b.emailAddress}\``);
  return { replyText: lines.join('\n') };
}
