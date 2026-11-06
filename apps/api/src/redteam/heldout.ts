import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { INTENT_MATCHES, type IntentCheckDecision } from '../guard/intent.js';
import {
  GUARD_VERDICTS,
  REASON_CODES,
  type ReasonCode,
} from '../guard/rules.js';
import type {
  ScenarioDefinition,
  ScenarioSetup,
} from './scenarios.js';

const REASON_CODE_VALUES = Object.values(REASON_CODES) as [
  ReasonCode,
  ...ReasonCode[],
];

const lineItemSchema = z.object({
  name: z.string().trim().min(1),
  quantity: z.number().int().positive(),
  unitAmountMinorUnits: z.number().int().nonnegative(),
});

const orderSchema = z.object({
  merchant: z.string().trim().min(1),
  category: z.string().trim().min(1),
  currency: z.string().trim().length(3),
  amountMinorUnits: z.number().int().nonnegative(),
  feeMinorUnits: z.number().int().nonnegative().optional(),
  items: z.array(lineItemSchema).min(1),
});

const mandateSchema = z.object({
  totalBudgetMinorUnits: z.number().int().positive(),
  perPurchaseCapMinorUnits: z.number().int().positive(),
  approvalThresholdMinorUnits: z.number().int().positive(),
  currency: z.string().trim().length(3),
  allowedMerchants: z.array(z.string().trim().min(1)).min(1),
  allowedCategories: z.array(z.string().trim().min(1)).min(1),
  expiresInMs: z.number().int(),
});

const intentSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('checked'),
    match: z.enum(INTENT_MATCHES),
    reasons: z.array(z.string().trim().min(1)).max(10),
  }),
  z.object({
    status: z.literal('failed'),
  }),
]);

const historySchema = orderSchema.extend({
  ageMs: z.number().int().nonnegative(),
});

const setupSchema = z.object({
  mandate: mandateSchema,
  order: orderSchema,
  history: z.array(historySchema).optional(),
  userRequest: z.string().trim().min(1),
  intent: intentSchema.optional(),
  untrustedText: z.string().optional(),
});

const scenarioSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  expectedVerdict: z.enum(GUARD_VERDICTS),
  expectedReasons: z.array(z.enum(REASON_CODE_VALUES)).optional(),
  setup: setupSchema,
});

export const heldoutFileSchema = z.object({
  generatedBy: z.string().trim().min(1),
  generatedAt: z.string().trim().min(1),
  model: z.string().trim().min(1),
  scenarios: z.array(scenarioSchema).min(10),
});

export type HeldoutFile = z.infer<typeof heldoutFileSchema>;

export const HELDOUT_FILE_JSON_SCHEMA = z.toJSONSchema(heldoutFileSchema);

function toIntent(
  intent: z.infer<typeof intentSchema>,
): IntentCheckDecision {
  if (intent.status === 'failed') {
    return {
      status: 'failed',
      reasons: [REASON_CODES.INTENT_CHECK_FAILED],
    };
  }

  return {
    status: 'checked',
    match: intent.match,
    reasons: intent.reasons,
  };
}

function toSetup(setup: z.infer<typeof setupSchema>): ScenarioSetup {
  return {
    mandate: {
      totalBudgetMinorUnits: setup.mandate.totalBudgetMinorUnits,
      perPurchaseCapMinorUnits: setup.mandate.perPurchaseCapMinorUnits,
      approvalThresholdMinorUnits: setup.mandate.approvalThresholdMinorUnits,
      currency: setup.mandate.currency,
      allowedMerchants: setup.mandate.allowedMerchants,
      allowedCategories: setup.mandate.allowedCategories,
      expiresInMs: setup.mandate.expiresInMs,
    },
    order: {
      merchant: setup.order.merchant,
      category: setup.order.category,
      currency: setup.order.currency,
      amountMinorUnits: setup.order.amountMinorUnits,
      feeMinorUnits: setup.order.feeMinorUnits ?? 0,
      items: setup.order.items,
    },
    ...(setup.history === undefined
      ? {}
      : {
          history: setup.history.map((entry) => ({
            merchant: entry.merchant,
            category: entry.category,
            currency: entry.currency,
            amountMinorUnits: entry.amountMinorUnits,
            feeMinorUnits: entry.feeMinorUnits ?? 0,
            items: entry.items,
            ageMs: entry.ageMs,
          })),
        }),
    userRequest: setup.userRequest,
    ...(setup.intent === undefined ? {} : { intent: toIntent(setup.intent) }),
    ...(setup.untrustedText === undefined
      ? {}
      : { untrustedText: setup.untrustedText }),
  };
}

function toScenario(
  scenario: z.infer<typeof scenarioSchema>,
): ScenarioDefinition {
  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    description: scenario.description,
    expectedVerdict: scenario.expectedVerdict,
    ...(scenario.expectedReasons === undefined
      ? {}
      : { expectedReasons: scenario.expectedReasons }),
    setup: toSetup(scenario.setup),
  };
}

let cached: HeldoutFile | null = null;

export function loadHeldoutFile(): HeldoutFile {
  if (cached !== null) {
    return cached;
  }

  const fileUrl = new URL('./heldout.generated.json', import.meta.url);
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(fileUrl, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read held-out scenarios at ${fileUrl.pathname}. Run npm run redteam:generate-heldout first.`,
      { cause: error },
    );
  }

  const parsed = heldoutFileSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      `Held-out scenarios are invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  cached = parsed.data;
  return cached;
}

export function loadHeldoutScenarios(): readonly ScenarioDefinition[] {
  return loadHeldoutFile().scenarios.map(toScenario);
}
