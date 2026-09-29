import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import type { DiscordPoster } from '../services/inboundEmailService';
import { handleInboundEmail } from '../services/inboundEmailService';

export function createServer(
  db: Db,
  resend: ResendClient,
  poster: DiscordPoster,
  webhookSecret: string,
  spamChannelId: string,
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

  return app;
}
