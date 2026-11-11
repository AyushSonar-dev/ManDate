import path from 'node:path';
import dotenv from 'dotenv';
import { generateText, stepCountIs, tool } from 'ai';
import {
  createLanguageModel,
  parseLlmChain,
  readProviderApiKey,
} from '../apps/api/src/agent/llm.js';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const LIMIT_CENTS = 5_000;

type ToolLike = {
  description?: string;
  parameters: unknown;
  execute?: (args: Record<string, unknown>, options: unknown) => PromiseLike<unknown>;
};

type ToolExchange = {
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: unknown;
};

type GeneratedResult = {
  steps: Array<{
    toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }>;
    toolResults: Array<{ toolName: string; toolCallId: string; output: unknown }>;
  }>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertSandbox(): void {
  const paypalEnv = (process.env.PAYPAL_ENV ?? '').toLowerCase();
  if (paypalEnv !== 'sandbox') {
    throw new Error(`PAYPAL_ENV must be "sandbox"; got "${process.env.PAYPAL_ENV ?? '(unset)'}"`);
  }
}

function toCents(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN;
  }
  return Number.NaN;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function orderTotalCents(args: Record<string, unknown>): number {
  const items = Array.isArray(args.items) ? args.items : [];
  if (items.length === 0) {
    return Number.NaN;
  }

  let subtotal = 0;
  let tax = 0;

  for (const rawItem of items) {
    if (typeof rawItem !== 'object' || rawItem === null) {
      return Number.NaN;
    }

    const item = rawItem as Record<string, unknown>;
    const unitCents = toCents(item.itemCost);
    const quantity = typeof item.quantity === 'number' ? item.quantity : 1;
    const taxPercent = typeof item.taxPercent === 'number' ? item.taxPercent : 0;

    if (!Number.isFinite(unitCents) || !Number.isInteger(quantity) || quantity <= 0) {
      return Number.NaN;
    }
    if (!Number.isFinite(taxPercent) || taxPercent < 0) {
      return Number.NaN;
    }

    const lineCents = unitCents * quantity;
    subtotal += lineCents;
    tax += Math.round((lineCents * taxPercent) / 100);
  }

  const shippingCents = args.shippingCost === undefined ? 0 : toCents(args.shippingCost);
  const discountCents = args.discount === undefined ? 0 : toCents(args.discount);

  if (!Number.isFinite(shippingCents) || !Number.isFinite(discountCents)) {
    return Number.NaN;
  }

  return subtotal + tax + shippingCents - discountCents;
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeOrder(value: unknown): void {
  const payload = parsePayload(value);
  if (typeof payload !== 'object' || payload === null) {
    console.log('Order ID: (not returned)');
    console.log('Order status: (not returned)');
    console.log('Approval link: (not returned)');
    return;
  }

  const order = payload as Record<string, unknown>;
  const links = Array.isArray(order.links) ? order.links : [];
  const approvalLink = links.find((link) => {
    if (typeof link !== 'object' || link === null) {
      return false;
    }
    const rel = (link as Record<string, unknown>).rel;
    return rel === 'approve' || rel === 'payer-action';
  }) as Record<string, unknown> | undefined;

  console.log('Order ID:', order.id ?? '(not returned)');
  console.log('Order status:', order.status ?? '(not returned)');
  console.log('Approval link:', approvalLink?.href ?? '(none)');
}

function collectToolExchanges(result: GeneratedResult): ToolExchange[] {
  const toolResults = result.steps.flatMap((step) => step.toolResults);
  return result.steps.flatMap((step) =>
    step.toolCalls.map((call) => ({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      args: call.input,
      result: toolResults.find((toolResult) => toolResult.toolCallId === call.toolCallId)?.output,
    })),
  );
}

function printToolExchanges(result: GeneratedResult): ToolExchange[] {
  const exchanges = collectToolExchanges(result);
  if (exchanges.length === 0) {
    throw new Error('The model did not make a tool call');
  }

  for (const exchange of exchanges) {
    console.log(`Tool name: ${exchange.toolName}`);
    console.log('Tool call arguments (exact):');
    console.log(JSON.stringify(exchange.args, null, 2));
    console.log('Tool result (exact):');
    if (typeof exchange.result === 'string') {
      console.log(exchange.result);
    } else {
      console.log(JSON.stringify(exchange.result, null, 2));
    }
  }

  return exchanges;
}

async function main(): Promise<void> {
  assertSandbox();
  const clientId = requireEnv('PAYPAL_CLIENT_ID');
  const clientSecret = requireEnv('PAYPAL_CLIENT_SECRET');

  const toolkit = new PayPalAgentToolkit({
    clientId,
    clientSecret,
    configuration: {
      actions: {
        orders: {
          create: true,
          get: true,
          capture: true,
        },
      },
      context: {
        sandbox: true,
      },
    },
  });

  const rawTools = toolkit.getTools() as Record<string, ToolLike>;
  console.log('Available PayPal tool names:', Object.keys(rawTools).sort().join(', '));

  let originalExecuteCalls = 0;
  let getHeadersCalls = 0;

  const client = toolkit.client as unknown as {
    getHeaders: () => Promise<Record<string, string>>;
  };
  const originalGetHeaders = client.getHeaders.bind(client);
  client.getHeaders = async () => {
    getHeadersCalls += 1;
    return originalGetHeaders();
  };

  for (const [toolName, rawTool] of Object.entries(rawTools)) {
    const originalExecute = rawTool.execute;
    if (!originalExecute) {
      continue;
    }

    rawTool.execute = async (args, options) => {
      console.log(`[tool-wrapper] ${toolName} arguments: ${JSON.stringify(args)}`);

      if (toolName === 'create_order') {
        const totalCents = orderTotalCents(args);
        if (!Number.isFinite(totalCents)) {
          const reason = 'Could not determine the order total, so the smoke-test guard failed closed';
          console.log(`[tool-wrapper] BLOCK ${toolName}: ${reason}`);
          return { blocked: true, reason };
        }

        console.log(`[tool-wrapper] ${toolName} calculated total: ${formatCents(totalCents)}`);

        if (totalCents > LIMIT_CENTS) {
          const reason = `Order total ${formatCents(totalCents)} exceeds the ${formatCents(LIMIT_CENTS)} smoke-test limit`;
          console.log(`[tool-wrapper] BLOCK ${toolName}: ${reason}`);
          return { blocked: true, reason };
        }
      }

      originalExecuteCalls += 1;
      console.log(`[tool-wrapper] Calling PayPal for ${toolName}`);
      return originalExecute(args, options);
    };
  }

  const tools = Object.fromEntries(
    Object.entries(rawTools).map(([toolName, rawTool]) => [
      toolName,
      tool({
        description: rawTool.description ?? toolName,
        inputSchema: rawTool.parameters as never,
        execute: rawTool.execute as never,
      }),
    ]),
  );

  const [entry] = parseLlmChain(
    process.env.LLM_CHAIN ?? 'gemini:gemini-2.5-flash',
  );

  if (!entry) {
    throw new Error('LLM_CHAIN must contain at least one provider:model entry');
  }

  const apiKey = readProviderApiKey(process.env, entry.provider);

  if (!apiKey) {
    throw new Error(`Missing API key for LLM provider ${entry.provider}`);
  }

  const model = createLanguageModel({ entry, apiKey });

  console.log('\n=== Scenario 1: create a 20 USD order ===');
  const twentyDollarOrder = await generateText({
    model,
    tools,
    toolChoice: { type: 'tool', toolName: 'create_order' },
    stopWhen: stepCountIs(1),
    temperature: 0,
    prompt:
      'Create a PayPal order for exactly 20.00 USD using the create_order tool. ' +
      'Use one item named "Smoke Test Item", quantity 1, itemCost 20, taxPercent 0, itemTotal 20. ' +
      'Set currencyCode to "USD". Do not call any other tool.',
  });

  const [twentyDollarExchange] = printToolExchanges(twentyDollarOrder);
  summarizeOrder(twentyDollarExchange?.result);

  console.log('\n=== Scenario 2: attempt a 200 USD order ===');
  originalExecuteCalls = 0;
  getHeadersCalls = 0;

  const twoHundredDollarOrder = await generateText({
    model,
    tools,
    toolChoice: { type: 'tool', toolName: 'create_order' },
    stopWhen: stepCountIs(1),
    temperature: 0,
    prompt:
      'Create a PayPal order for exactly 200.00 USD using the create_order tool. ' +
      'Use one item named "Expensive Smoke Test Item", quantity 1, itemCost 200, taxPercent 0, itemTotal 200. ' +
      'Set currencyCode to "USD". Do not call any other tool.',
  });

  printToolExchanges(twoHundredDollarOrder);

  console.log('PayPal tool execute calls during blocked request:', originalExecuteCalls);
  console.log('PayPal client getHeaders calls during blocked request:', getHeadersCalls);

  if (originalExecuteCalls !== 0 || getHeadersCalls !== 0) {
    throw new Error('The blocked order reached PayPal');
  }

  console.log('Verified: the blocked order did not call PayPal.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
