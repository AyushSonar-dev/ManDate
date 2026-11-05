import {
  generateText,
  type LanguageModel,
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
import { createStorefrontOrderContextResolver } from './order-context.js';

const DEFAULT_MAX_STEPS = 8;
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
  model: LanguageModel;
  tools: ToolSet;
  system: string;
  prompt: string;
  maxSteps: number;
  temperature: number;
}

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
  model: LanguageModel;
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
    'Use search_catalog to find products and get_item to inspect the full product page.',
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

function defaultGenerate(
  request: ShoppingAgentRequest,
): Promise<ShoppingAgentGeneration> {
  return generateText(
    request as unknown as Parameters<typeof generateText>[0],
  ) as unknown as Promise<ShoppingAgentGeneration>;
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
  const tools = {
    ...createStorefrontTools(options.provider),
    ...guardedToolkitTools,
  } as unknown as ToolSet;
  const system = buildSystemPrompt(mandate);
  const generate = options.generate ?? defaultGenerate;
  const generation = await generate({
    model: options.model,
    tools,
    system,
    prompt: options.prompt,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
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
