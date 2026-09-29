import { z } from 'zod';

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  RESEND_WEBHOOK_SECRET: z.string().min(1),
  DB_PATH: z.string().default('./data/mailcord.db'),
  PORT: z.coerce.number().default(8787),
  // Blocked senders and spam-flagged mail are posted here instead of the bound channel.
  SPAM_CHANNEL_ID: z.string().min(1).default('1554435622993661972'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
