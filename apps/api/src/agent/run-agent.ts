import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type {
  GuardStore,
} from '../guard/store.js';
import type { IntentChecker } from '../guard/intent.js';
import {
  wrapToolkitTools,
  type ToolkitTool,
} from '../guard/tool-wrapper.js';
import type { StorefrontProvider } from '../storefront/types.js';
import { createStorefrontTools } from '../storefront/tools.js';
import { isFallbackEligibleProviderError, type AgentModelEntry } from './llm.js';
import { createStorefrontOrderContextResolver } from './order-context.js';

const DEFAULT_MAX_STEPS = 5;
const MAX_AGENT_STEPS = 5;
const EXPOSED_PAYPAL_TOOLS = new Set(['create_order', 'get_order']);

interface GenerationToolCall {
  toolName: string;
  toolCallId: string;
  args: unknown;
}

interface GenerationToolResult {
  toolName: string;
  toolCallId: string;
  result: unknown;
}

interface GenerationStep {
  text?: string;
  finishReason?: string;
  toolCalls?: GenerationToolCall[];
  toolResults?: GenerationToolResult[];
}

export interface ShoppingAgentGeneration {
  text: string;
  steps: GenerationStep[];
}

export interface ShoppingAgentRequest {
  model?: LanguageModel;
  tools: ToolSet;
  system: string;
  prompt: string;
  maxSteps: number;
  temperature: number;
}

interface RawChainStep {
  text?: string;
  finishReason?: string;
  toolCalls: Array<{
    toolName: string;
    toolCallId: string;
    input: unknown;
  }>;
  toolResults: Array<{
    toolName: string;
    toolCallId: string;
    output: unknown;
  }>;
}

interface ModelChainTextResult {
  text: string;
  steps: RawChainStep[];
  response: {
    messages: ModelMessage[];
  };
}

export type ModelChainTextGenerator = (options: {
  model: LanguageModel;
  tools: ToolSet;
  system: string;
  messages: ModelMessage[];
  temperature: number;
  maxRetries: number;
  stopWhen: ReturnType<typeof stepCountIs>;
}) => Promise<ModelChainTextResult>;

export interface AgentToolCallLog {
  toolName: string;
  toolCallId: string;
  args: unknown;
}

export interface AgentToolResultLog {
  toolName: string;
  toolCallId: string;
  result: unknown;
}

export interface AgentStepLog {
  stepNumber: number;
  text: string;
  finishReason: string;
  toolCalls: AgentToolCallLog[];
  toolResults: AgentToolResultLog[];
}

export interface ShoppingAgentResult {
  text: string;
  steps: AgentStepLog[];
}

export interface ShoppingAgentOptions {
  mandateId: string;
  prompt: string;
  model?: LanguageModel;
  models?: readonly AgentModelEntry[];
  provider: StorefrontProvider;
  store: GuardStore;
  toolkitTools: Record<string, ToolkitTool>;
  intentChecker: IntentChecker;
  maxSteps?: number;
  onStep?: (step: AgentStepLog) => void;
  generate?: (
    request: ShoppingAgentRequest,
  ) => Promise<ShoppingAgentGeneration>;
}

function formatMinorUnits(minorUnits: number, currency: string): string {
  const sign = minorUnits < 0 ? '-' : '';
  const absolute = Math.abs(minorUnits);
  return `${sign}${currency} ${Math.floor(absolute / 100)}.${String(
    absolute % 100,
  ).padStart(2, '0')}`;
}

function buildSystemPrompt(input: {
  totalBudgetMinorUnits: number;
  perPurchaseCapMinorUnits: number;
  approvalThresholdMinorUnits: number;
  currency: string;
  allowedMerchants: readonly string[];
  allowedCategories: readonly string[];
  expiresAt: Date;
}): string {
  return [
    'You are a shopping agent that buys products for a user under a spending mandate.',
    'Use search_catalog to find products. Each call returns up to 3 full product pages with descriptions and reviews.',
    'Use the exact product title returned by the catalog as the item name when calling create_order.',
    'When calling create_order, provide quantity, itemCost, taxPercent, and itemTotal in major currency units.',
    'Do not invent products, prices, merchants, or categories.',
    'If the guard blocks an order or requires approval, explain the result to the user.',
    'PayPal runs in sandbox mode.',
    'Mandate:',
    `- Total budget: ${formatMinorUnits(input.totalBudgetMinorUnits, input.currency)}`,
    `- Per-purchase cap: ${formatMinorUnits(input.perPurchaseCapMinorUnits, input.currency)}`,
    `- Approval threshold: ${formatMinorUnits(input.approvalThresholdMinorUnits, input.currency)}`,
    `- Allowed merchants: ${input.allowedMerchants.join(', ')}`,
    `- Allowed categories: ${input.allowedCategories.join(', ')}`,
    `- Expires at: ${input.expiresAt.toISOString()}`,
  ].join('\n');
}

function toSdkToolkitTools(tools: Record<string, ToolkitTool>): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, toolkitTool]) => [
      toolName,
      tool({
        description: toolkitTool.description ?? toolName,
        inputSchema: toolkitTool.parameters as never,
        execute: toolkitTool.execute as never,
      }),
    ]),
  ) as ToolSet;
}

async function defaultGenerate(
  request: ShoppingAgentRequest,
): Promise<ShoppingAgentGeneration> {
  if (!request.model) {
    throw new Error('A language model is required when no model chain is configured');
  }

  const result = await generateText({
    model: request.model,
    tools: request.tools,
    system: request.system,
    prompt: request.prompt,
    temperature: request.temperature,
    stopWhen: stepCountIs(request.maxSteps),
  });

  return {
    text: result.text,
    steps: result.steps.map((step) => ({
      text: step.text,
      finishReason: step.finishReason,
      toolCalls: step.toolCalls.map((call) => ({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        args: call.input,
      })),
      toolResults: step.toolResults.map((toolResult) => ({
        toolName: toolResult.toolName,
        toolCallId: toolResult.toolCallId,
        result: toolResult.output,
      })),
    })),
  };
}

const defaultChainTextGenerator: ModelChainTextGenerator = async (options) => {
  const result = await generateText(options);
  return result;
};

function trackToolExecutions(tools: ToolSet): {
  tools: ToolSet;
  hasExecuted: () => boolean;
} {
  let executed = false;

  const tracked = Object.fromEntries(
    Object.entries(tools).map(([toolName, current]) => {
      const execute = (current as { execute?: (...args: unknown[]) => unknown })
        .execute;

      if (typeof execute !== 'function') {
        return [toolName, current];
      }

      return [
        toolName,
        {
          ...current,
          execute: async (...args: unknown[]) => {
            executed = true;
            return execute(...args);
          },
        },
      ];
    }),
  ) as ToolSet;

  return { tools: tracked, hasExecuted: () => executed };
}

function mapChainStep(step: RawChainStep): GenerationStep {
  return {
    ...(step.text === undefined ? {} : { text: step.text }),
    ...(step.finishReason === undefined
      ? {}
      : { finishReason: step.finishReason }),
    toolCalls: step.toolCalls.map((call) => ({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      args: call.input,
    })),
    toolResults: step.toolResults.map((toolResult) => ({
      toolName: toolResult.toolName,
      toolCallId: toolResult.toolCallId,
      result: toolResult.output,
    })),
  };
}

async function generateWithEntry(
  entry: AgentModelEntry,
  request: ShoppingAgentRequest,
  textGenerator: ModelChainTextGenerator,
): Promise<ShoppingAgentGeneration> {
  const messages: ModelMessage[] = [{ role: 'user', content: request.prompt }];
  const steps: GenerationStep[] = [];
  let text = '';

  for (let stepNumber = 0; stepNumber < request.maxSteps; stepNumber += 1) {
    const result = await textGenerator({
      model: entry.model,
      tools: request.tools,
      system: request.system,
      messages,
      temperature: request.temperature,
      maxRetries: 1,
      stopWhen: stepCountIs(1),
    });

    steps.push(...result.steps.map(mapChainStep));
    messages.push(...result.response.messages);
    text = result.text;

    const lastStep = result.steps.at(-1);

    if (
      !lastStep ||
      lastStep.finishReason !== 'tool-calls' ||
      lastStep.toolCalls.length === 0
    ) {
      break;
    }
  }

  return { text, steps };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function generateWithModelChain(
  request: ShoppingAgentRequest,
  entries: readonly AgentModelEntry[],
  textGenerator: ModelChainTextGenerator = defaultChainTextGenerator,
): Promise<ShoppingAgentGeneration> {
  if (entries.length === 0) {
    throw new Error('At least one model is required');
  }

  const tracked = trackToolExecutions(request.tools);
  const chainRequest: ShoppingAgentRequest = {
    ...request,
    tools: tracked.tools,
  };
  let lastError: unknown;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;

    try {
      return await generateWithEntry(entry, chainRequest, textGenerator);
    } catch (error) {
      lastError = error;

      if (tracked.hasExecuted()) {
        throw new Error(
          `Model ${entry.label} failed after a tool call; not retrying. ${errorMessage(error)}`,
          { cause: error },
        );
      }

      const hasNext = index < entries.length - 1;

      if (!hasNext || !isFallbackEligibleProviderError(error)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error('The model chain produced no result');
}

function mapStep(step: GenerationStep, stepNumber: number): AgentStepLog {
  return {
    stepNumber,
    text: typeof step.text === 'string' ? step.text : '',
    finishReason:
      typeof step.finishReason === 'string' ? step.finishReason : 'unknown',
    toolCalls: (step.toolCalls ?? []).map((call) => ({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      args: call.args,
    })),
    toolResults: (step.toolResults ?? []).map((result) => ({
      toolName: result.toolName,
      toolCallId: result.toolCallId,
      result: result.result,
    })),
  };
}

export async function runShoppingAgent(
  options: ShoppingAgentOptions,
): Promise<ShoppingAgentResult> {
  const mandate = await options.store.loadMandate(options.mandateId);

  if (!mandate) {
    throw new Error(`Mandate ${options.mandateId} was not found`);
  }

  if (!options.toolkitTools.create_order) {
    throw new Error('The PayPal create_order tool is required');
  }

  const exposedToolkitTools = Object.fromEntries(
    Object.entries(options.toolkitTools).filter(([toolName]) =>
      EXPOSED_PAYPAL_TOOLS.has(toolName),
    ),
  );
  const guardedToolkitTools = wrapToolkitTools(exposedToolkitTools, {
    context: createStorefrontOrderContextResolver(
      options.provider,
      options.mandateId,
    ),
    store: options.store,
    intentChecker: options.intentChecker,
    userRequest: options.prompt,
  });
  const tools: ToolSet = {
    ...createStorefrontTools(options.provider),
    ...toSdkToolkitTools(guardedToolkitTools),
  };
  const system = buildSystemPrompt(mandate);
  const models = options.models;
  const generate =
    options.generate ??
    (models && models.length > 0
      ? (request: ShoppingAgentRequest) =>
          generateWithModelChain(request, models)
      : defaultGenerate);
  const requestedMaxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxSteps = Math.min(
    Math.max(1, requestedMaxSteps),
    MAX_AGENT_STEPS,
  );
  const generation = await generate({
    ...(options.model === undefined ? {} : { model: options.model }),
    tools,
    system,
    prompt: options.prompt,
    maxSteps,
    temperature: 0,
  });
  const steps = generation.steps.map((step, index) => mapStep(step, index + 1));

  for (const step of steps) {
    options.onStep?.(step);
  }

  return {
    text: generation.text,
    steps,
  };
}
