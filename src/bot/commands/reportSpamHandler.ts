import type { Db } from '../../db/client';
import { resolveThreadByDiscordMessageId } from '../../services/threadService';
import { blockSender } from '../../services/blocklistService';

export interface ReportSpamInput {
  discordMessageId: string;
  requestedBy: string;
}

export type ReportSpamResult =
  | { ok: true; emailAddress: string; replyText: string }
  | { ok: false; replyText: string };

/**
 * Backs the "迷惑メールとして報告" message context menu: blocks the sender of the mail that the
 * right-clicked Discord message represents. Moving the message itself to the spam channel is left
 * to the caller, which owns the Discord client.
 */
export async function handleReportSpamCommand(db: Db, input: ReportSpamInput): Promise<ReportSpamResult> {
  const thread = await resolveThreadByDiscordMessageId(db, input.discordMessageId);
  if (!thread || thread.direction !== 'inbound') {
    return { ok: false, replyText: 'このメッセージは受信メールではないため、迷惑メールとして報告できません。' };
  }

  const blocked = await blockSender(db, { emailAddress: thread.externalAddress, createdBy: input.requestedBy });
  return {
    ok: true,
    emailAddress: blocked.emailAddress,
    replyText: `\`${blocked.emailAddress}\` を迷惑メールとして報告し、ブロックしました。今後このアドレスからの受信メールは迷惑メールチャンネルに転送されます。`,
  };
}
