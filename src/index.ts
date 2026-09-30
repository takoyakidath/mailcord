import 'dotenv/config';
import { loadEnv } from './env';
import { createDbWithHandle } from './db/client';
import { createResendClient } from './mail/resendClient';
import { createGmailClient } from './mail/gmailClient';
import type { GmailProvider } from './services/outboundEmailService';
import { pollAllGmailBindings } from './services/gmailPollingService';
import { createServer } from './web/server';
import { createBotClient, createDiscordPoster } from './bot/client';

// Defence in depth: the discord.js event handlers catch their own errors, but a stray
// rejection anywhere else must not take the whole process (bot + webhook server) down.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

async function main() {
  const env = loadEnv();
  const { db, sqlite } = createDbWithHandle(env.DB_PATH);
  const resend = createResendClient(env.RESEND_API_KEY);

  const gmail: GmailProvider | null = env.GMAIL_CLIENT_ID
    ? {
        client: createGmailClient(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET!, env.GMAIL_OAUTH_REDIRECT_URI!),
        tokenEncryptionKey: env.GMAIL_TOKEN_ENCRYPTION_KEY!,
      }
    : null;

  const bot = createBotClient(db, resend, gmail);
  const poster = createDiscordPoster(bot);
  const server = createServer(db, resend, poster, env.RESEND_WEBHOOK_SECRET, env.SPAM_CHANNEL_ID, gmail);

  await bot.login(env.DISCORD_BOT_TOKEN);
  await server.listen({ host: '0.0.0.0', port: env.PORT });

  console.log(`mailcord listening on :${env.PORT}`);

  // This project has no other scheduled jobs; Gmail inbound uses polling rather than Pub/Sub
  // push specifically so it doesn't need any infrastructure beyond this in-process interval.
  let pollTimer: NodeJS.Timeout | null = null;
  if (gmail) {
    pollTimer = setInterval(() => {
      pollAllGmailBindings(db, gmail.client, gmail.tokenEncryptionKey, poster).catch((err) => {
        console.error('gmail polling tick failed:', err);
      });
    }, env.GMAIL_POLL_INTERVAL_MS);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    if (pollTimer) clearInterval(pollTimer);
    try {
      await server.close();
    } catch (err) {
      console.error('error closing HTTP server:', err);
    }
    try {
      bot.destroy();
    } catch (err) {
      console.error('error destroying Discord client:', err);
    }
    try {
      sqlite.close();
    } catch (err) {
      console.error('error closing database:', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
