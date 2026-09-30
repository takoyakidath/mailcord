import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/env';

const validEnv = {
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_APPLICATION_ID: 'app-id',
  RESEND_API_KEY: 're_key',
  RESEND_WEBHOOK_SECRET: 'whsec_abc',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(validEnv);
    expect(env.DISCORD_BOT_TOKEN).toBe('token');
    expect(env.DB_PATH).toBe('./data/mailcord.db');
    expect(env.PORT).toBe(8787);
    expect(env.SPAM_CHANNEL_ID).toBe('1554435622993661972');
  });

  it('throws when a required var is missing', () => {
    const { DISCORD_BOT_TOKEN, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow();
  });

  it('coerces PORT from a string, as real process.env values arrive', () => {
    const env = loadEnv({ ...validEnv, PORT: '3000' });
    expect(env.PORT).toBe(3000);
  });

  it('leaves Gmail unconfigured (all undefined) when none of the GMAIL_* vars are set', () => {
    const env = loadEnv(validEnv);
    expect(env.GMAIL_CLIENT_ID).toBeUndefined();
    expect(env.GMAIL_POLL_INTERVAL_MS).toBe(60_000);
  });

  it('treats blank GMAIL_* values (as dotenv loads `KEY=` with nothing after it) the same as unset', () => {
    // .env.example and docker-compose's `${VAR}` substitution both produce '' rather than an
    // absent key when the operator leaves these blank — must not crash on .min(1)/.url().
    const env = loadEnv({
      ...validEnv,
      GMAIL_CLIENT_ID: '',
      GMAIL_CLIENT_SECRET: '',
      GMAIL_OAUTH_REDIRECT_URI: '',
      GMAIL_TOKEN_ENCRYPTION_KEY: '',
    });
    expect(env.GMAIL_CLIENT_ID).toBeUndefined();
  });

  it('accepts a fully-configured Gmail setup', () => {
    const key = '0'.repeat(64);
    const env = loadEnv({
      ...validEnv,
      GMAIL_CLIENT_ID: 'client-id',
      GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_OAUTH_REDIRECT_URI: 'https://example.com/oauth/gmail/callback',
      GMAIL_TOKEN_ENCRYPTION_KEY: key,
    });
    expect(env.GMAIL_CLIENT_ID).toBe('client-id');
  });

  it('rejects a half-configured Gmail setup', () => {
    expect(() => loadEnv({ ...validEnv, GMAIL_CLIENT_ID: 'client-id' })).toThrow();
  });

  it('rejects a GMAIL_TOKEN_ENCRYPTION_KEY that is not 64 hex characters', () => {
    expect(() =>
      loadEnv({
        ...validEnv,
        GMAIL_CLIENT_ID: 'client-id',
        GMAIL_CLIENT_SECRET: 'client-secret',
        GMAIL_OAUTH_REDIRECT_URI: 'https://example.com/oauth/gmail/callback',
        GMAIL_TOKEN_ENCRYPTION_KEY: 'too-short',
      }),
    ).toThrow();
  });
});
