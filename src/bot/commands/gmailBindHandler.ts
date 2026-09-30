import type { Db } from '../../db/client';
import type { GmailProvider } from '../../services/outboundEmailService';
import { resolveBindingByChannel } from '../../services/bindingService';
import { createOauthState } from '../../services/oauthStateService';
import type { CommandResult } from './types';

export interface BindGmailInput {
  discordGuildId: string;
  discordChannelId: string;
  requestedBy: string;
}

export async function handleBindGmailCommand(db: Db, gmail: GmailProvider | null, input: BindGmailInput): Promise<CommandResult> {
  if (!gmail) {
    return { replyText: 'Gmail連携は設定されていません(管理者による環境変数の設定が必要です)。' };
  }

  // Unlike /mail bind, there's no `force` option here: at command time we don't yet know which
  // Gmail address the user will authorize, so overwriting an existing binding mid-flow would be
  // premature. The user unbinds first, then starts the OAuth flow.
  const existing = await resolveBindingByChannel(db, input.discordChannelId);
  if (existing) {
    return {
      replyText: `このチャンネルは既に \`${existing.emailAddress}\` にバインドされています。変更する場合は先に \`/mail unbind\` を実行してください。`,
    };
  }

  const state = await createOauthState(db, {
    discordGuildId: input.discordGuildId,
    discordChannelId: input.discordChannelId,
    requestedBy: input.requestedBy,
  });
  const authUrl = gmail.client.buildAuthUrl(state);

  return {
    replyText: `以下のリンクからGoogleアカウントを認可してください(10分間有効・あなただけが使えるリンクです):\n${authUrl}`,
  };
}
