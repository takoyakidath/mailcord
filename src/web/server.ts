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
): FastifyInstance {
  const app = Fastify();

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
      reply.code(401).send({ error: 'invalid signature' });
      return;
    }

    if (event.type !== 'email.received') {
      reply.code(200).send({ ok: true, handled: false });
      return;
    }

    const result = await handleInboundEmail(db, resend, poster, event.data.email_id);
    reply.code(200).send({ ok: true, handled: result.handled });
  });

  return app;
}
