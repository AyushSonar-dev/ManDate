import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  RetryError,
  wrapLanguageModel,
  type LanguageModel,
} from 'ai';
import type { AgentEnv } from '../config/env.js';

export const LLM_PROVIDERS = [
  'groq',
  'cerebras',
  'gemini',
  'openrouter',
  'github',
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

interface LlmProviderConfig {
  keyEnv: string;
  baseURL?: string;
}

export const LLM_PROVIDER_CONFIG: Record<LlmProvider, LlmProviderConfig> = {
  groq: {
    keyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
  },
  cerebras: {
    keyEnv: 'CEREBRAS_API_KEY',
    baseURL: 'https://api.cerebras.ai/v1',
  },
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
  },
  openrouter: {
    keyEnv: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  github: {
    keyEnv: 'GITHUB_MODELS_TOKEN',
    baseURL: 'https://models.github.ai/inference',
  },
} as const satisfies Record<LlmProvider, LlmProviderConfig>;

export interface LlmEntry {
  provider: LlmProvider;
  model: string;
}

export interface AgentModelEntry {
  provider: LlmProvider;
  label: string;
  model: LanguageModel;
}

export type LlmEnvironment = { readonly [key: string]: unknown };

function isLlmProvider(value: string): value is LlmProvider {
  return Object.prototype.hasOwnProperty.call(LLM_PROVIDER_CONFIG, value);
}

export function parseLlmEntry(value: string): LlmEntry {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(':');

  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(
      `Invalid LLM entry "${value}". Expected "provider:model".`,
    );
  }

  const provider = trimmed.slice(0, separator).trim();
  const model = trimmed.slice(separator + 1).trim();

  if (!isLlmProvider(provider)) {
    throw new Error(
      `Unknown LLM provider "${provider}" in "${value}". Supported providers: ${LLM_PROVIDERS.join(', ')}.`,
    );
  }

  if (model.length === 0) {
    throw new Error(`Invalid LLM entry "${value}". Model is required.`);
  }

  return { provider, model };
}

export function parseLlmChain(value: string): LlmEntry[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error('LLM_CHAIN must contain at least one provider:model entry');
  }

  return entries.map(parseLlmEntry);
}

export function formatLlmEntry(entry: LlmEntry): string {
  return `${entry.provider}:${entry.model}`;
}

export function readProviderApiKey(
  environment: LlmEnvironment,
  provider: LlmProvider,
): string | undefined {
  const configured =
    environment[LLM_PROVIDER_CONFIG[provider].keyEnv];

  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }

  if (provider === 'gemini') {
    const legacy = environment.GOOGLE_GENERATIVE_AI_API_KEY;
    return typeof legacy === 'string' && legacy.trim().length > 0
      ? legacy.trim()
      : undefined;
  }

  return undefined;
}

export function providerKeyEnvName(provider: LlmProvider): string {
  return LLM_PROVIDER_CONFIG[provider].keyEnv;
}

export interface TokenBucketOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly requestsPerMinute: number,
    options: TokenBucketOptions = {},
  ) {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new Error('requestsPerMinute must be a positive number');
    }

    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.tokens = requestsPerMinute;
    this.lastRefill = this.now();
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const millisecondsNeeded = Math.ceil(
        ((1 - this.tokens) / this.requestsPerMinute) * 60_000,
      );
      await this.sleep(Math.max(1, millisecondsNeeded));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;

    if (elapsed <= 0) {
      return;
    }

    this.tokens = Math.min(
      this.requestsPerMinute,
      this.tokens + (elapsed / 60_000) * this.requestsPerMinute,
    );
    this.lastRefill = now;
  }
}

export class ProviderRateLimiter {
  private readonly buckets = new Map<LlmProvider, TokenBucket>();

  constructor(
    requestsPerMinute: Partial<Record<LlmProvider, number>>,
    options: TokenBucketOptions = {},
  ) {
    for (const provider of LLM_PROVIDERS) {
      const rpm = requestsPerMinute[provider];

      if (rpm !== undefined) {
        this.buckets.set(provider, new TokenBucket(rpm, options));
      }
    }
  }

  async acquire(provider: LlmProvider): Promise<void> {
    await this.buckets.get(provider)?.acquire();
  }
}

function isFallbackStatus(statusCode: number | undefined): boolean {
  return statusCode === 429 || (statusCode !== undefined && statusCode >= 500);
}

export function providerErrorStatus(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 6; depth += 1) {
    if (current === undefined || current === null || seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    if (APICallError.isInstance(current)) {
      return current.statusCode;
    }

    if (RetryError.isInstance(current)) {
      current = current.lastError ?? current.errors.at(-1);
      continue;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    const candidate = current as {
      statusCode?: unknown;
      lastError?: unknown;
      errors?: unknown;
      cause?: unknown;
    };

    if (typeof candidate.statusCode === 'number') {
      return candidate.statusCode;
    }

    if (candidate.lastError !== undefined) {
      current = candidate.lastError;
      continue;
    }

    if (Array.isArray(candidate.errors)) {
      current = candidate.errors.at(-1);
      continue;
    }

    if (candidate.cause !== undefined) {
      current = candidate.cause;
      continue;
    }

    return undefined;
  }

  return undefined;
}

export function describeProviderError(
  error: unknown,
  provider: LlmProvider,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = providerErrorStatus(error);

  if (provider === 'github' && (status === 401 || status === 403)) {
    return `${message} (HTTP ${status}: check that GITHUB_MODELS_TOKEN has the Models read-only permission)`;
  }

  return message;
}

export function isFallbackEligibleProviderError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 6; depth += 1) {
    if (current === undefined || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);

    if (APICallError.isInstance(current)) {
      return isFallbackStatus(current.statusCode);
    }

    if (RetryError.isInstance(current)) {
      current = current.lastError ?? current.errors.at(-1);
      continue;
    }

    if (typeof current !== 'object') {
      return false;
    }

    const candidate = current as {
      statusCode?: unknown;
      lastError?: unknown;
      errors?: unknown;
      cause?: unknown;
    };

    if (typeof candidate.statusCode === 'number') {
      return isFallbackStatus(candidate.statusCode);
    }

    if (candidate.lastError !== undefined) {
      current = candidate.lastError;
      continue;
    }

    if (Array.isArray(candidate.errors)) {
      current = candidate.errors.at(-1);
      continue;
    }

    if (candidate.cause !== undefined) {
      current = candidate.cause;
      continue;
    }

    return false;
  }

  return false;
}

export function createLanguageModel(input: {
  entry: LlmEntry;
  apiKey: string;
  rateLimiter?: ProviderRateLimiter;
}): LanguageModel {
  const config = LLM_PROVIDER_CONFIG[input.entry.provider];
  const baseModel =
    input.entry.provider === 'gemini'
      ? createGoogleGenerativeAI({ apiKey: input.apiKey })(input.entry.model)
      : (() => {
          if (!config.baseURL) {
            throw new Error(
              `Missing base URL for provider ${input.entry.provider}`,
            );
          }

          return createOpenAICompatible({
            name: input.entry.provider,
            baseURL: config.baseURL,
            apiKey: input.apiKey,
          })(input.entry.model);
        })();

  if (!input.rateLimiter && input.entry.provider !== 'github') {
    return baseModel;
  }

  const rateLimiter = input.rateLimiter;
  const provider = input.entry.provider;

  return wrapLanguageModel({
    model: baseModel,
    middleware: {
      middlewareVersion: 'v2',
      wrapGenerate: async ({ doGenerate }) => {
        await rateLimiter?.acquire(provider);

        try {
          return await doGenerate();
        } catch (error) {
          const message = describeProviderError(error, provider);
          const original =
            error instanceof Error ? error.message : String(error);

          if (message !== original) {
            throw new Error(message, { cause: error });
          }

          throw error;
        }
      },
    },
  });
}

function requireProviderApiKey(
  environment: LlmEnvironment,
  provider: LlmProvider,
): string {
  const apiKey = readProviderApiKey(environment, provider);

  if (!apiKey) {
    throw new Error(
      `${providerKeyEnvName(provider)} is required for LLM provider ${provider}`,
    );
  }

  return apiKey;
}

function rateLimitConfig(environment: AgentEnv): Partial<
  Record<LlmProvider, number>
> {
  const config: Partial<Record<LlmProvider, number>> = {};

  if (environment.LLM_RPM_GROQ !== undefined) {
    config.groq = environment.LLM_RPM_GROQ;
  }

  if (environment.LLM_RPM_CEREBRAS !== undefined) {
    config.cerebras = environment.LLM_RPM_CEREBRAS;
  }

  if (environment.LLM_RPM_GEMINI !== undefined) {
    config.gemini = environment.LLM_RPM_GEMINI;
  }

  if (environment.LLM_RPM_OPENROUTER !== undefined) {
    config.openrouter = environment.LLM_RPM_OPENROUTER;
  }

  if (environment.LLM_RPM_GITHUB !== undefined) {
    config.github = environment.LLM_RPM_GITHUB;
  }

  return config;
}

export interface AgentLlmRuntime {
  entries: AgentModelEntry[];
  intentModel: LanguageModel;
}

export function createAgentLlmRuntime(environment: AgentEnv): AgentLlmRuntime {
  const chain = parseLlmChain(environment.LLM_CHAIN);
  const rateLimiter = new ProviderRateLimiter(rateLimitConfig(environment));

  const createEntry = (entry: LlmEntry): AgentModelEntry => ({
    provider: entry.provider,
    label: formatLlmEntry(entry),
    model: createLanguageModel({
      entry,
      apiKey: requireProviderApiKey(environment, entry.provider),
      rateLimiter,
    }),
  });

  const entries = chain.map(createEntry);
  const intentEntry =
    environment.INTENT_MODEL === undefined
      ? chain[0]
      : parseLlmEntry(environment.INTENT_MODEL);

  if (!intentEntry) {
    throw new Error('LLM_CHAIN must contain at least one provider:model entry');
  }

  const intentModel =
    environment.INTENT_MODEL === undefined
      ? entries[0]!.model
      : createEntry(intentEntry).model;

  return { entries, intentModel };
}
