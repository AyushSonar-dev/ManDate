import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

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
