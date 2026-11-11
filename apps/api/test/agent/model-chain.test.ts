import {
  APICallError,
  RetryError,
  jsonSchema,
  tool,
  type ToolSet,
} from 'ai';
import { describe, expect, it } from 'vitest';
import {
  isFallbackEligibleProviderError,
  parseLlmChain,
  parseLlmEntry,
  TokenBucket,
  type AgentModelEntry,
} from '../../src/agent/llm.js';
import {
  generateWithModelChain,
  type ModelChainTextGenerator,
  type ShoppingAgentRequest,
} from '../../src/agent/run-agent.js';

type ChainResult = Awaited<ReturnType<ModelChainTextGenerator>>;
type ExecuteTool = {
  execute?: (
    args: Record<string, unknown>,
    options: unknown,
  ) => PromiseLike<unknown>;
};

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider responded with ${statusCode}`,
    url: 'https://provider.example/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

function entry(label: string): AgentModelEntry {
  return {
    provider: 'groq',
    label,
    model: { modelId: label } as never,
  };
}

function tools(): ToolSet {
  return {
    search_catalog: tool({
      description: 'test search',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async () => ({ resultCount: 1, results: [] }),
    }),
  };
}

function request(): ShoppingAgentRequest {
  return {
    tools: tools(),
    system: 'system',
    prompt: 'buy headphones',
    maxSteps: 5,
    temperature: 0,
  };
}

const stopResult: ChainResult = {
  text: 'done',
  steps: [
    {
      text: 'done',
      finishReason: 'stop',
      toolCalls: [],
      toolResults: [],
    },
  ],
  response: { messages: [] },
};

const toolCallResult: ChainResult = {
  text: '',
  steps: [
    {
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        {
          toolName: 'search_catalog',
          toolCallId: 'call-1',
          input: { query: 'headphones' },
        },
      ],
      toolResults: [
        {
          toolName: 'search_catalog',
          toolCallId: 'call-1',
          output: { resultCount: 1, results: [] },
        },
      ],
    },
  ],
  response: { messages: [] },
};

async function executeTool(
  activeTools: ToolSet,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const selected = activeTools[toolName] as ExecuteTool | undefined;

  if (!selected?.execute) {
    throw new Error(`Missing test tool ${toolName}`);
  }

  await selected.execute(args, {} as never);
}

describe('LLM chain parsing and error handling', () => {
  it('parses provider:model entries and keeps model colons intact', () => {
    expect(parseLlmChain('groq:llama-3.3-70b,groq:meta-llama/llama-4')).toEqual([
      { provider: 'groq', model: 'llama-3.3-70b' },
      { provider: 'groq', model: 'meta-llama/llama-4' },
    ]);
    expect(parseLlmEntry('openrouter:vendor/model:free')).toEqual({
      provider: 'openrouter',
      model: 'vendor/model:free',
    });
  });

  it('rejects malformed entries and unknown providers', () => {
    expect(() => parseLlmEntry('gemini')).toThrowError(/provider:model/);
    expect(() => parseLlmEntry('unknown:model')).toThrowError(
      /Unknown LLM provider/,
    );
    expect(() => parseLlmChain('')).toThrowError(/at least one/);
  });

  it('treats only 429 and 5xx responses as fallback eligible', () => {
    expect(isFallbackEligibleProviderError(apiError(429))).toBe(true);
    expect(isFallbackEligibleProviderError(apiError(500))).toBe(true);
    expect(isFallbackEligibleProviderError(apiError(503))).toBe(true);
    expect(isFallbackEligibleProviderError(apiError(400))).toBe(false);
    expect(isFallbackEligibleProviderError(new Error('network'))).toBe(false);

    const retryError = new RetryError({
      message: 'retries exhausted',
      reason: 'maxRetriesExceeded',
      errors: [apiError(502)],
    });

    expect(isFallbackEligibleProviderError(retryError)).toBe(true);
  });
});

describe('TokenBucket', () => {
  it('waits instead of exceeding the configured requests per minute', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(2, {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBe(30_000);
  });
});

describe('generateWithModelChain', () => {
  it('falls back to the next provider on a 429 before any tool call', async () => {
    const models = [entry('primary'), entry('secondary')];
    const visited: string[] = [];
    const generate: ModelChainTextGenerator = async (options) => {
      const modelId = (options.model as { modelId?: string }).modelId ?? '';
      visited.push(modelId);

      if (modelId === 'primary') {
        throw apiError(429);
      }

      return stopResult;
    };

    const result = await generateWithModelChain(request(), models, generate);

    expect(visited).toEqual(['primary', 'secondary']);
    expect(result.text).toBe('done');
  });

  it('does not fall back after a tool call has executed', async () => {
    const models = [entry('primary'), entry('secondary')];
    const visited: string[] = [];
    let calls = 0;
    const generate: ModelChainTextGenerator = async (options) => {
      const modelId = (options.model as { modelId?: string }).modelId ?? '';
      visited.push(modelId);
      calls += 1;

      if (calls === 1) {
        await executeTool(options.tools, 'search_catalog', {
          query: 'headphones',
        });
        return toolCallResult;
      }

      throw apiError(503);
    };

    await expect(
      generateWithModelChain(request(), models, generate),
    ).rejects.toThrowError(/failed after a tool call; not retrying/);
    expect(visited).toEqual(['primary', 'primary']);
    expect(visited).not.toContain('secondary');
  });

  it('does not fall back on a non-retryable provider error', async () => {
    const models = [entry('primary'), entry('secondary')];
    const visited: string[] = [];
    const generate: ModelChainTextGenerator = async (options) => {
      visited.push((options.model as { modelId?: string }).modelId ?? '');
      throw apiError(400);
    };

    await expect(
      generateWithModelChain(request(), models, generate),
    ).rejects.toThrowError(/400/);
    expect(visited).toEqual(['primary']);
  });
});
