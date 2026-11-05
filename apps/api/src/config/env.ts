import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\//;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => POSTGRES_URL_PATTERN.test(value), {
      message: 'DATABASE_URL must start with postgresql:// or postgres://',
    }),
});

export type Env = z.infer<typeof envSchema>;

const envBoolean = z.preprocess((value) => {
  if (value === undefined || value === '') {
    return false;
  }

  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') {
      return true;
    }

    if (value.toLowerCase() === 'false') {
      return false;
    }
  }

  return value;
}, z.boolean());

export const agentEnvSchema = envSchema
  .extend({
    PAYPAL_ENV: z.literal('sandbox').default('sandbox'),
    PAYPAL_CLIENT_ID: z.string().trim().min(1, 'PAYPAL_CLIENT_ID is required'),
    PAYPAL_CLIENT_SECRET: z
      .string()
      .trim()
      .min(1, 'PAYPAL_CLIENT_SECRET is required'),
    GOOGLE_GENERATIVE_AI_API_KEY: z
      .string()
      .trim()
      .min(1, 'GOOGLE_GENERATIVE_AI_API_KEY is required'),
    GOOGLE_MODEL: z.string().trim().min(1).default('gemini-2.5-flash'),
    STOREFRONT_PROVIDER: z.enum(['mock', 'channel3']).default('mock'),
    CHANNEL3_API_KEY: z.string().trim().min(1).optional(),
    CHANNEL3_BASE_URL: z.string().url().default('https://api.trychannel3.com'),
    CHANNEL3_CACHE_DIR: z.string().trim().min(1).default('.channel3-cache'),
    CHANNEL3_OFFLINE: envBoolean,
    AGENT_MAX_STEPS: z.coerce.number().int().positive().max(20).default(8),
    INTENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(60_000)
      .default(5_000),
  })
  .superRefine((environment, context) => {
    if (
      environment.STOREFRONT_PROVIDER === 'channel3' &&
      !environment.CHANNEL3_OFFLINE &&
      environment.CHANNEL3_API_KEY === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CHANNEL3_API_KEY'],
        message: 'CHANNEL3_API_KEY is required when STOREFRONT_PROVIDER=channel3',
      });
    }
  });

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export const serverEnvSchema = envSchema.extend({
  PAYPAL_ENV: z.literal('sandbox').default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().trim().min(1, 'PAYPAL_CLIENT_ID is required'),
  PAYPAL_CLIENT_SECRET: z
    .string()
    .trim()
    .min(1, 'PAYPAL_CLIENT_SECRET is required'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

function envError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  return new Error(
    `Invalid environment variables:\n${details}\n\nCopy .env.example to .env and fill in the required values.`,
  );
}

export function parseEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(input);

  if (!result.success) {
    throw envError(result.error);
  }

  return result.data;
}

export function parseAgentEnv(
  input: NodeJS.ProcessEnv = process.env,
): AgentEnv {
  const result = agentEnvSchema.safeParse(input);

  if (!result.success) {
    throw envError(result.error);
  }

  return result.data;
}

export function parseServerEnv(
  input: NodeJS.ProcessEnv = process.env,
): ServerEnv {
  const result = serverEnvSchema.safeParse(input);

  if (!result.success) {
    throw envError(result.error);
  }

  return result.data;
}

export function loadEnv(): Env {
  const workingDirectory = process.cwd();

  dotenv.config({
    path: [
      path.resolve(workingDirectory, '.env'),
      path.resolve(workingDirectory, '../../.env'),
    ],
  });

  return parseEnv(process.env);
}

export function loadAgentEnv(): AgentEnv {
  const workingDirectory = process.cwd();

  dotenv.config({
    path: [
      path.resolve(workingDirectory, '.env'),
      path.resolve(workingDirectory, '../../.env'),
    ],
  });

  return parseAgentEnv(process.env);
}

export function loadServerEnv(): ServerEnv {
  const workingDirectory = process.cwd();

  dotenv.config({
    path: [
      path.resolve(workingDirectory, '.env'),
      path.resolve(workingDirectory, '../../.env'),
    ],
  });

  return parseServerEnv(process.env);
}
