import 'dotenv/config';
import { jsonSchema, wrapLanguageModel } from 'ai';
import type { IntentChecker } from '../apps/api/src/guard/intent.js';
import type {
  MandateForGuard,
  OrderHistoryEntry,
} from '../apps/api/src/guard/rules.js';
import type {
  GuardDecisionInput,
  GuardOrderInput,
  GuardStore,
} from '../apps/api/src/guard/store.js';
import type { ToolkitTool } from '../apps/api/src/guard/tool-wrapper.js';
import {
  createLanguageModel,
  describeProviderError,
  parseLlmChain,
  ProviderRateLimiter,
  readProviderApiKey,
  type LlmProvider,
} from '../apps/api/src/agent/llm.js';
import { runShoppingAgent } from '../apps/api/src/agent/run-agent.js';
import { MockStorefrontProvider } from '../apps/api/src/storefront/mock-provider.js';

const DEFAULT_RUNS = 2;
const RUN_DELAY_MS = 2_000;
const MANDATE_ID = 'model-check';
const PROMPT =
  'Buy the Aurora Wireless Headphones if they cost at most 40 dollars.';

const mandate: MandateForGuard = {
  active: true,
  totalBudgetMinorUnits: 100_000,
  perPurchaseCapMinorUnits: 20_000,
  approvalThresholdMinorUnits: 10_000,
  currency: 'USD',
  allowedMerchants: ['soundhouse'],
  allowedCategories: ['electronics'],
  expiresAt: new Date('2030-07-01T00:00:00.000Z'),
};

class ModelCheckStore implements GuardStore {
  async loadMandate(): Promise<MandateForGuard> {
    return mandate;
  }

  async loadHistory(): Promise<OrderHistoryEntry[]> {
    return [];
  }

  async saveDecision(input: GuardDecisionInput): Promise<{ id: string }> {
    return { id: `decision-${input.verdict}` };
  }

  async saveAllowedOrder(): Promise<{ orderId: string; decisionId: string }> {
    return { orderId: 'local-order-1', decisionId: 'decision-ALLOW' };
  }

  async savePendingApproval(): Promise<{
    orderId: string;
    approvalId: string;
    decisionId: string;
  }> {
    return {
      orderId: 'local-order-1',
      approvalId: 'approval-1',
      decisionId: 'decision-REQUIRE_APPROVAL',
    };
  }

  async finalizeOrder(): Promise<void> {}

  async markOrderFailed(): Promise<void> {}
}

const intentChecker: IntentChecker = {
  async check() {
    return { status: 'checked', match: 'match', reasons: [] };
  },
};

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRuns(argv: readonly string[]): number {
  let runs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--runs') {
      const value = argv[index + 1];
      const parsed = positiveInteger(value);

      if (parsed === undefined) {
        throw new Error('--runs requires a positive integer');
      }

      runs = parsed;
      index += 1;
      continue;
    }

    if (argument?.startsWith('--runs=')) {
      const parsed = positiveInteger(argument.slice('--runs='.length));

      if (parsed === undefined) {
        throw new Error('--runs requires a positive integer');
      }

      runs = parsed;
      continue;
    }

    if (argument?.startsWith('--')) {
      throw new Error(`Unknown option ${argument}`);
    }
  }

  return runs ?? DEFAULT_RUNS;
}

function rateLimits(): Partial<Record<LlmProvider, number>> {
  const limits: Partial<Record<LlmProvider, number>> = {};
  const groq = positiveInteger(process.env.LLM_RPM_GROQ);
  const cerebras = positiveInteger(process.env.LLM_RPM_CEREBRAS);
  const gemini = positiveInteger(process.env.LLM_RPM_GEMINI);
  const openrouter = positiveInteger(process.env.LLM_RPM_OPENROUTER);
  const github = positiveInteger(process.env.LLM_RPM_GITHUB) ?? 10;

  if (groq !== undefined) {
    limits.groq = groq;
  }

  if (cerebras !== undefined) {
    limits.cerebras = cerebras;
  }

  if (gemini !== undefined) {
    limits.gemini = gemini;
  }

  if (openrouter !== undefined) {
    limits.openrouter = openrouter;
  }

  limits.github = github;

  return limits;
}

function validOrderShape(args: Record<string, unknown> | undefined): boolean {
  if (!args || args.currencyCode !== 'USD' || !Array.isArray(args.items)) {
    return false;
  }

  if (args.items.length === 0) {
    return false;
  }

  return args.items.every((rawItem) => {
    if (typeof rawItem !== 'object' || rawItem === null) {
      return false;
    }

    const item = rawItem as Record<string, unknown>;

    return (
      typeof item.name === 'string' &&
      item.name.trim().length > 0 &&
      typeof item.quantity === 'number' &&
      Number.isInteger(item.quantity) &&
      item.quantity > 0 &&
      typeof item.itemCost === 'number' &&
      Number.isFinite(item.itemCost) &&
      item.itemCost > 0 &&
      typeof item.taxPercent === 'number' &&
      Number.isFinite(item.taxPercent) &&
      item.taxPercent >= 0 &&
      typeof item.itemTotal === 'number' &&
      Number.isFinite(item.itemTotal) &&
      item.itemTotal > 0
    );
  });
}

async function runEntry(input: {
  label: string;
  provider: LlmProvider;
  model: ReturnType<typeof createLanguageModel>;
  runs: number;
}): Promise<void> {
  let requestsThisRun = 0;
  let createOrderArgs: Record<string, unknown> | undefined;
  let createOrderCalls = 0;

  const countedModel = wrapLanguageModel({
    model: input.model as never,
    middleware: {
      middlewareVersion: 'v2',
      wrapGenerate: async ({ doGenerate }) => {
        requestsThisRun += 1;
        return doGenerate();
      },
    },
  });

  const toolkitTools: Record<string, ToolkitTool> = {
    create_order: {
      description: 'PayPal create_order spy used by model-check',
      parameters: jsonSchema({
        type: 'object',
        additionalProperties: true,
      }),
      execute: async (args) => {
        createOrderCalls += 1;
        createOrderArgs = args;
        return {
          id: 'PAYPAL-ORDER-SPY',
          status: 'CREATED',
          links: [
            {
              rel: 'approve',
              href: 'https://www.sandbox.paypal.com/checkoutnow?token=spy',
            },
          ],
        };
      },
    },
  };
  const provider = new MockStorefrontProvider();
  let completed = 0;
  let correctShape = 0;
  let totalRequests = 0;
  const failures: string[] = [];

  for (let run = 1; run <= input.runs; run += 1) {
    requestsThisRun = 0;
    createOrderArgs = undefined;
    createOrderCalls = 0;

    try {
      const result = await runShoppingAgent({
        mandateId: MANDATE_ID,
        prompt: PROMPT,
        models: [
          {
            provider: input.provider,
            label: input.label,
            model: countedModel,
          },
        ],
        provider,
        store: new ModelCheckStore(),
        toolkitTools,
        intentChecker,
        maxSteps: 5,
      });
      const toolNames = result.steps.flatMap((step) =>
        step.toolCalls.map((call) => call.toolName),
      );

      completed += 1;

      if (
        toolNames.includes('search_catalog') &&
        createOrderCalls > 0 &&
        validOrderShape(createOrderArgs)
      ) {
        correctShape += 1;
      } else {
        failures.push(
          `run ${run}: expected search_catalog then a valid create_order shape`,
        );
      }
    } catch (error) {
      failures.push(
        `run ${run}: ${describeProviderError(error, input.provider)}`,
      );
    } finally {
      totalRequests += requestsThisRun;
    }

    if (run < input.runs) {
      await new Promise((resolve) => setTimeout(resolve, RUN_DELAY_MS));
    }
  }

  console.log(`\n${input.label}`);
  console.log(`  runs completed: ${completed}/${input.runs}`);
  console.log(`  correct tool call shape: ${correctShape}/${input.runs}`);
  console.log(`  requests used: ${totalRequests}`);

  for (const failure of failures) {
    console.log(`  ${failure}`);
  }

  if (completed < input.runs || correctShape < input.runs) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const runs = parseRuns(process.argv.slice(2));
  const chain = parseLlmChain(
    process.env.LLM_CHAIN ?? 'gemini:gemini-2.5-flash',
  );
  const rateLimiter = new ProviderRateLimiter(rateLimits());

  console.log(
    `Model chain check (mock storefront, PayPal create_order spy, ${runs} run${runs === 1 ? '' : 's'} per entry)`,
  );

  for (const entry of chain) {
    const apiKey = readProviderApiKey(process.env, entry.provider);

    if (!apiKey) {
      throw new Error(
        `Missing API key for ${entry.provider}. Set the provider key environment variable or remove it from LLM_CHAIN.`,
      );
    }

    const model = createLanguageModel({
      entry,
      apiKey,
      rateLimiter,
    });

    await runEntry({
      label: `${entry.provider}:${entry.model}`,
      provider: entry.provider,
      model,
      runs,
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
