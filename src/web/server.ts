import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import type { DiscordPoster } from '../services/inboundEmailService';
import type { GmailProvider } from '../services/outboundEmailService';
import { handleInboundEmail } from '../services/inboundEmailService';
import { consumeOauthState } from '../services/oauthStateService';
import { createBinding, resolveBindingByAddress, resolveBindingByChannel } from '../services/bindingService';
import { createGmailAccount } from '../services/gmailAccountService';

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
  spamChannelId: string,
  gmail: GmailProvider | null,
): FastifyInstance {
  const app = Fastify({ logger: true });

  // Keep the raw request body so the Resend/Svix signature can be verified byte-for-byte.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
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
