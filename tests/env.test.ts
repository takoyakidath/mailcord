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
});
