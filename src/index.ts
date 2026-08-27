import { loadEnv } from './env';
import { createDb } from './db/client';
import { createResendClient } from './mail/resendClient';
import { createServer } from './web/server';
import { createBotClient, createDiscordPoster } from './bot/client';

// Defence in depth: the discord.js event handlers catch their own errors, but a stray
// rejection anywhere else must not take the whole process (bot + webhook server) down.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

async function main() {
  const env = loadEnv();
  const db = createDb(env.DB_PATH);
  const resend = createResendClient(env.RESEND_API_KEY);

  const bot = createBotClient(db, resend);
  const poster = createDiscordPoster(bot);
  const server = createServer(db, resend, poster, env.RESEND_WEBHOOK_SECRET);

  await bot.login(env.DISCORD_BOT_TOKEN);
  await server.listen({ host: '0.0.0.0', port: env.PORT });

  console.log(`mailcord listening on :${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
