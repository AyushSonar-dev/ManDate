import { describe, expect, it } from 'vitest';
import { parseAgentEnv, parseEnv } from '../src/config/env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/mandate?schema=public',
};

describe('parseEnv', () => {
  it('parses and coerces valid environment variables', () => {
    const env = parseEnv(validEnvironment);

    expect(env).toEqual({
      NODE_ENV: 'test',
      PORT: 4000,
      DATABASE_URL: validEnvironment.DATABASE_URL,
    });
  });

  it('applies defaults for optional variables', () => {
    const env = parseEnv({ DATABASE_URL: validEnvironment.DATABASE_URL });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('throws a clear error when DATABASE_URL is missing', () => {
    expect(() => parseEnv({})).toThrowError(/DATABASE_URL/);
    expect(() => parseEnv({})).toThrowError(/\.env\.example/);
  });

  it('rejects an invalid port', () => {
    expect(() =>
      parseEnv({ ...validEnvironment, PORT: 'not-a-port' }),
    ).toThrowError(/PORT/);
    expect(() => parseEnv({ ...validEnvironment, PORT: '0' })).toThrowError(/PORT/);
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() =>
      parseEnv({ ...validEnvironment, DATABASE_URL: 'mysql://localhost/mandate' }),
    ).toThrowError(/DATABASE_URL/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() =>
      parseEnv({ ...validEnvironment, NODE_ENV: 'staging' }),
    ).toThrowError(/NODE_ENV/);
  });
});

const validAgentEnvironment = {
  ...validEnvironment,
  PAYPAL_ENV: 'sandbox',
  PAYPAL_CLIENT_ID: 'client-id',
  PAYPAL_CLIENT_SECRET: 'client-secret',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
};

describe('parseAgentEnv', () => {
  it('applies safe agent defaults', () => {
    const env = parseAgentEnv(validAgentEnvironment);

    expect(env).toMatchObject({
      PAYPAL_ENV: 'sandbox',
      STOREFRONT_PROVIDER: 'mock',
      GOOGLE_MODEL: 'gemini-2.5-flash',
      CHANNEL3_BASE_URL: 'https://api.trychannel3.com',
      CHANNEL3_CACHE_DIR: '.channel3-cache',
      CHANNEL3_OFFLINE: false,
      AGENT_MAX_STEPS: 8,
      INTENT_TIMEOUT_MS: 5_000,
    });
  });

  it('rejects PayPal environments other than sandbox', () => {
    expect(() =>
      parseAgentEnv({ ...validAgentEnvironment, PAYPAL_ENV: 'live' }),
    ).toThrowError(/PAYPAL_ENV/);
  });

  it('requires PayPal and Google credentials', () => {
    expect(() =>
      parseAgentEnv({ ...validAgentEnvironment, PAYPAL_CLIENT_ID: '' }),
    ).toThrowError(/PAYPAL_CLIENT_ID/);
    expect(() =>
      parseAgentEnv({
        ...validAgentEnvironment,
        GOOGLE_GENERATIVE_AI_API_KEY: '',
      }),
    ).toThrowError(/GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  it('requires a Channel3 key only when the live provider is selected', () => {
    expect(() =>
      parseAgentEnv({
        ...validAgentEnvironment,
        STOREFRONT_PROVIDER: 'channel3',
      }),
    ).toThrowError(/CHANNEL3_API_KEY/);

    expect(
      parseAgentEnv({
        ...validAgentEnvironment,
        STOREFRONT_PROVIDER: 'channel3',
        CHANNEL3_API_KEY: 'channel3-key',
        CHANNEL3_OFFLINE: 'true',
      }),
    ).toMatchObject({
      STOREFRONT_PROVIDER: 'channel3',
      CHANNEL3_API_KEY: 'channel3-key',
      CHANNEL3_OFFLINE: true,
    });
  });

  it('allows offline Channel3 replay without an API key', () => {
    expect(
      parseAgentEnv({
        ...validAgentEnvironment,
        STOREFRONT_PROVIDER: 'channel3',
        CHANNEL3_OFFLINE: 'true',
      }),
    ).toMatchObject({
      STOREFRONT_PROVIDER: 'channel3',
      CHANNEL3_OFFLINE: true,
    });
  });

  it('rejects invalid agent max steps', () => {
    expect(() =>
      parseAgentEnv({ ...validAgentEnvironment, AGENT_MAX_STEPS: '0' }),
    ).toThrowError(/AGENT_MAX_STEPS/);
  });

  it('rejects invalid intent timeouts', () => {
    expect(() =>
      parseAgentEnv({ ...validAgentEnvironment, INTENT_TIMEOUT_MS: '0' }),
    ).toThrowError(/INTENT_TIMEOUT_MS/);
    expect(() =>
      parseAgentEnv({ ...validAgentEnvironment, INTENT_TIMEOUT_MS: '60001' }),
    ).toThrowError(/INTENT_TIMEOUT_MS/);
  });
});
