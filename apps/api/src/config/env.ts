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

export function parseEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(input);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment variables:\n${details}\n\nCopy .env.example to .env and fill in the required values.`,
    );
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
