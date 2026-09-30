import { z } from 'zod';

// .env.example (and the README) tell people to leave the GMAIL_* lines blank to disable the
// feature, e.g. `GMAIL_CLIENT_ID=`. dotenv loads that as an empty string, not an absent key, and
// the same happens with `environment: [GMAIL_CLIENT_ID=${GMAIL_CLIENT_ID}]` in docker-compose
// when the host doesn't set it — so "blank" must be treated the same as "unset" here, or every
// deployment that follows that instruction literally would crash at startup on `.min(1)`.
const optionalString = (inner: z.ZodString) => z.preprocess((v) => (v === '' ? undefined : v), inner.optional());

const envSchema = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: z.string().min(1),
    RESEND_API_KEY: z.string().min(1),
    RESEND_WEBHOOK_SECRET: z.string().min(1),
    DB_PATH: z.string().default('./data/mailcord.db'),
    PORT: z.coerce.number().default(8787),
    // Blocked senders and spam-flagged mail are posted here instead of the bound channel.
    SPAM_CHANNEL_ID: z.string().min(1).default('1554435622993661972'),
    // Gmail bind is an add-on feature, not every deployment configures it — these are optional
    // as a group (see the .refine below), unlike the Resend vars above which are always required.
    GMAIL_CLIENT_ID: optionalString(z.string().min(1)),
    GMAIL_CLIENT_SECRET: optionalString(z.string().min(1)),
    GMAIL_OAUTH_REDIRECT_URI: optionalString(z.string().url()),
    GMAIL_TOKEN_ENCRYPTION_KEY: optionalString(z.string().min(1)),
    GMAIL_POLL_INTERVAL_MS: z.coerce.number().default(60_000),
  })
  .refine(
    (env) => {
      const gmailVars = [env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, env.GMAIL_OAUTH_REDIRECT_URI, env.GMAIL_TOKEN_ENCRYPTION_KEY];
      return gmailVars.every((v) => v === undefined) || gmailVars.every((v) => v !== undefined);
    },
    {
      message:
        'GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_OAUTH_REDIRECT_URI, GMAIL_TOKEN_ENCRYPTION_KEY must be all set or all unset',
    },
  )
  .refine((env) => !env.GMAIL_TOKEN_ENCRYPTION_KEY || /^[0-9a-f]{64}$/i.test(env.GMAIL_TOKEN_ENCRYPTION_KEY), {
    message: 'GMAIL_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256), e.g. via `openssl rand -hex 32`',
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
