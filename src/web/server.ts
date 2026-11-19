import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import type { DiscordPoster } from '../services/inboundEmailService';
import type { GmailProvider } from '../services/outboundEmailService';
import { handleInboundEmail } from '../services/inboundEmailService';
import { consumeOauthState } from '../services/oauthStateService';
import { createBinding, resolveBindingByAddress, resolveBindingByChannel } from '../services/bindingService';
import { createGmailAccount } from '../services/gmailAccountService';

const HOME_PAGE = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>mailcord</title>
<body style="font-family: sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.7;">
<h1>mailcord</h1>
<p>mailcord は、メールの通知をユーザー自身が管理する Discord サーバーへ転送する個人用ツールです。</p>
<p>Gmail 連携ではメタデータ（件名・差出人など）のみを扱い、本文や添付ファイルにはアクセスしません。</p>
<p><a href="/privacy">プライバシーポリシー</a> ／ <a href="https://github.com/takoyakidath/mailcord">GitHub リポジトリ</a></p>
</body></html>`;

const PRIVACY_PAGE = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>プライバシーポリシー — mailcord</title>
<body style="font-family: sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.7;">
<h1>プライバシーポリシー — mailcord</h1>
<p>最終更新日: 2026-11-19</p>
<p>mailcord は、メールの通知をユーザー自身が管理する Discord サーバーへ転送する個人用ツールです。本ポリシーでは、本アプリケーションがアクセスするデータとその利用方法を説明します。</p>
<h2>アクセスするデータ</h2>
<p>ユーザーが Discord の <code>/mail bind-gmail</code> コマンドで Gmail アカウントを連携すると、mailcord は Gmail API の <code>gmail.metadata</code> スコープでアカウントにアクセスします。このスコープで取得できるのは、件名、差出人アドレス、日時などのヘッダー情報、Gmail 上のメッセージへのリンクといったメタデータのみです。</p>
<p>メール本文や添付ファイルにアクセス・ダウンロード・保存することはありません。メタデータのみのスコープにより、そのようなアクセスは技術的に不可能になっています。</p>
<p>ユーザーが所有するドメイン宛に Resend 経由で届くメールについては、ユーザーが設定した Discord チャンネルへ配送するためにのみ内容を処理します。</p>
<h2>データの利用方法</h2>
<ul>
<li>新着メールのメタデータを、ユーザーが指定した Discord チャンネルへ転送します。</li>
<li>OAuth リフレッシュトークンは、連携を維持するためだけに、アプリケーションのローカルデータベースへ暗号化して保存します。</li>
<li>データを第三者へ販売したり、マーケティングや広告目的で共有したりすることはありません。</li>
</ul>
<h2>データの保持と削除</h2>
<p>ユーザーは Discord の連携解除コマンドでいつでも Gmail 連携を解除でき、その時点で保存されたトークンは削除され、すべてのアクセスが停止します。Google アカウントの権限ページからアクセスを取り消した場合も、即座にアクセスは停止します。</p>
<h2>お問い合わせ</h2>
<p>本ポリシーに関するお問い合わせは、<a href="https://github.com/takoyakidath/mailcord">GitHub リポジトリ</a>からリポジトリ所有者へご連絡ください。</p>
</body></html>`;

function htmlPage(message: string): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>mailcord</title>
<body style="font-family: sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<p>${message}</p>
</body></html>`;
}

export function createServer(
  db: Db,
  resend: ResendClient,
  poster: DiscordPoster,
  webhookSecret: string,
  spamChannelId: string | undefined,
  gmail: GmailProvider | null,
): FastifyInstance {
  const app = Fastify({ logger: true });

  // Keep the raw request body so the Resend/Svix signature can be verified byte-for-byte.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  // Public pages: the OAuth consent screen requires a homepage and a privacy
  // policy URL on an authorized domain (octo.jp), served by the app itself.
  app.get('/', async (_request, reply) => {
    reply.code(200).type('text/html').send(HOME_PAGE);
  });

  app.get('/privacy', async (_request, reply) => {
    reply.code(200).type('text/html').send(PRIVACY_PAGE);
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
      // Spec: reject with 401 and log only (no Discord notification).
      request.log.warn({ svixId: request.headers['svix-id'] }, 'invalid webhook signature');
      reply.code(401).send({ error: 'invalid signature' });
      return;
    }

    if (event.type !== 'email.received') {
      request.log.info({ type: event.type }, 'ignoring non-inbound webhook event');
      reply.code(200).send({ ok: true, handled: false });
      return;
    }

    let result;
    try {
      result = await handleInboundEmail(db, resend, poster, event.data.email_id, spamChannelId);
    } catch (err) {
      // Surface a 500 so Resend retries rather than treating a failure as delivered.
      request.log.error({ err, emailId: event.data.email_id }, 'inbound email handling failed');
      throw err;
    }

    if (!result.handled) {
      // Spec: mail to an unbound address is logged and discarded.
      request.log.warn({ emailId: event.data.email_id, reason: result.reason }, 'inbound email discarded');
    }

    reply.code(200).send({ ok: true, handled: result.handled });
  });

  // Google's OAuth2 authorization-code callback: a plain browser GET redirect, not a webhook, so
  // errors render an HTML page for the person in the browser rather than a JSON 500 meant for a
  // machine retry.
  app.get('/oauth/gmail/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };

    if (!gmail) {
      reply.code(404).type('text/html').send(htmlPage('Gmail連携は設定されていません。'));
      return;
    }

    if (query.error) {
      request.log.info({ error: query.error }, 'gmail oauth consent denied or cancelled');
      reply.code(200).type('text/html').send(htmlPage('認可がキャンセルされました。Discordで /mail bind-gmail をやり直してください。'));
      return;
    }

    if (!query.code || !query.state) {
      reply.code(400).type('text/html').send(htmlPage('リクエストが不正です。'));
      return;
    }

    const stateRow = await consumeOauthState(db, query.state);
    if (!stateRow) {
      reply
        .code(400)
        .type('text/html')
        .send(htmlPage('リンクが無効か期限切れです。Discordで /mail bind-gmail をやり直してください。'));
      return;
    }

    let tokens;
    let profile;
    try {
      tokens = await gmail.client.exchangeCodeForTokens(query.code);
      profile = await gmail.client.getProfile(tokens.accessToken);
    } catch (err) {
      request.log.error({ err }, 'gmail oauth token exchange failed');
      reply.code(502).type('text/html').send(htmlPage('Googleとの認可処理に失敗しました。もう一度 /mail bind-gmail からやり直してください。'));
      return;
    }

    // Re-check the same invariants /mail bind enforces — time has passed since the command was
    // run, so another binding could have been created in the meantime.
    if (await resolveBindingByAddress(db, profile.emailAddress)) {
      reply
        .code(409)
        .type('text/html')
        .send(htmlPage(`\`${profile.emailAddress}\` は既に別のチャンネルにバインドされています。`));
      return;
    }
    if (await resolveBindingByChannel(db, stateRow.discordChannelId)) {
      reply.code(409).type('text/html').send(htmlPage('このチャンネルは既に別のアドレスにバインドされています。'));
      return;
    }

    const binding = await createBinding(db, {
      emailAddress: profile.emailAddress,
      discordGuildId: stateRow.discordGuildId,
      discordChannelId: stateRow.discordChannelId,
      createdBy: stateRow.requestedBy,
      provider: 'gmail',
    });
    await createGmailAccount(db, gmail.tokenEncryptionKey, {
      bindingId: binding.id,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      historyId: profile.historyId,
      permission: stateRow.permission,
    });

    // Best-effort: the person completing this OAuth redirect is looking at their browser, not
    // necessarily Discord, so confirm in-channel too rather than relying only on this page.
    try {
      await poster.postSystemMessage(stateRow.discordChannelId, `このチャンネルは \`${profile.emailAddress}\` (Gmail) にバインドされました。`);
    } catch (err) {
      request.log.error({ err }, 'failed to post gmail bind confirmation to discord');
    }

    reply
      .code(200)
      .type('text/html')
      .send(htmlPage(`\`${profile.emailAddress}\` をこのDiscordチャンネルにバインドしました。このタブは閉じて構いません。`));
  });

  return app;
}
