import { AttackRunStatus, Prisma, type PrismaClient } from '@prisma/client';
import {
  guardResultForIntent,
  type IntentCheckDecision,
} from '../guard/intent.js';
import {
  evaluateOrder,
  type GuardResult,
  type GuardVerdict,
  type MandateForGuard,
  type OrderHistoryEntry,
  type ProposedOrder,
  type ReasonCode,
} from '../guard/rules.js';
import {
  CORE_SCENARIOS,
  REDTEAM_CATEGORIES,
  type ScenarioDefinition,
  type ScenarioSetup,
} from './scenarios.js';
import { loadHeldoutScenarios } from './heldout.js';

export const REDTEAM_SET_NAMES = ['core', 'heldout'] as const;

export type RedteamSetName = (typeof REDTEAM_SET_NAMES)[number];

const DEFAULT_MARKER = 'redteam-suite-marker';

type RedteamPrismaClient = Pick<PrismaClient, 'mandate' | 'attackRun'>;

export interface RedteamRunOptions {
  prisma: RedteamPrismaClient;
  setName: RedteamSetName;
  now?: Date;
  marker?: string;
}

export interface ScenarioTrail {
  scenario: {
    id: string;
    name: string;
    category: string;
    description: string;
  };
  mandateId: string;
  mandate: {
    active: boolean;
    totalBudgetMinorUnits: number;
    perPurchaseCapMinorUnits: number;
    approvalThresholdMinorUnits: number;
    currency: string;
    allowedMerchants: readonly string[];
    allowedCategories: readonly string[];
    expiresAt: string;
  };
  order: ProposedOrder;
  history: readonly (Omit<OrderHistoryEntry, 'createdAt'> & {
    createdAt: string;
  })[];
  userRequest: string;
  untrustedText?: string;
  deterministic: GuardResult;
  intent?: {
    decision: IntentCheckDecision;
    applied: boolean;
    result?: GuardResult;
  };
  final: GuardResult;
}

export interface ScenarioResult {
  id: string;
  name: string;
  category: string;
  expectedVerdict: GuardVerdict;
  expectedReasons?: readonly ReasonCode[];
  actualVerdict: GuardVerdict;
  actualReasons: readonly ReasonCode[];
  passed: boolean;
  attackRunId: string;
  trail: ScenarioTrail;
}

export interface CategoryScore {
  category: string;
  passed: number;
  total: number;
}

export interface RedteamReport {
  setName: RedteamSetName;
  marker: string;
  total: number;
  passed: number;
  categories: readonly CategoryScore[];
  results: readonly ScenarioResult[];
  failures: readonly ScenarioResult[];
}

function scenariosFor(setName: RedteamSetName): readonly ScenarioDefinition[] {
  return setName === 'core' ? CORE_SCENARIOS : loadHeldoutScenarios();
}

function mandateFor(
  setup: ScenarioSetup,
  now: Date,
): MandateForGuard {
  return {
    active: true,
    totalBudgetMinorUnits: setup.mandate.totalBudgetMinorUnits,
    perPurchaseCapMinorUnits: setup.mandate.perPurchaseCapMinorUnits,
    approvalThresholdMinorUnits: setup.mandate.approvalThresholdMinorUnits,
    currency: setup.mandate.currency,
    allowedMerchants: setup.mandate.allowedMerchants,
    allowedCategories: setup.mandate.allowedCategories,
    expiresAt: new Date(now.getTime() + setup.mandate.expiresInMs),
  };
}

function historyFor(
  setup: ScenarioSetup,
  now: Date,
): OrderHistoryEntry[] {
  return (setup.history ?? []).map((entry) => ({
    merchant: entry.merchant,
    category: entry.category,
    currency: entry.currency,
    amountMinorUnits: entry.amountMinorUnits,
    feeMinorUnits: entry.feeMinorUnits ?? 0,
    items: entry.items,
    createdAt: new Date(now.getTime() - entry.ageMs),
  }));
}

function sameReasons(
  actual: readonly ReasonCode[],
  expected: readonly ReasonCode[],
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  const actualSet = new Set(actual);
  return expected.every((reason) => actualSet.has(reason));
}

function evaluateScenario(
  scenario: ScenarioDefinition,
  now: Date,
  mandateId: string,
  marker: string,
): ScenarioResult {
  const setup = scenario.setup;
  const mandate = mandateFor(setup, now);

  if (!mandate.allowedMerchants.includes(marker)) {
    mandate.allowedMerchants = [...mandate.allowedMerchants, marker];
  }

  const history = historyFor(setup, now);
  const deterministic = evaluateOrder({
    mandate,
    order: setup.order,
    history,
    now,
  });

  const final =
    deterministic.verdict === 'ALLOW' && setup.intent !== undefined
      ? guardResultForIntent(setup.intent)
      : deterministic;

  const passed =
    final.verdict === scenario.expectedVerdict &&
    (scenario.expectedReasons === undefined ||
      sameReasons(final.reasons, scenario.expectedReasons));

  const trail: ScenarioTrail = {
    scenario: {
      id: scenario.id,
      name: scenario.name,
      category: scenario.category,
      description: scenario.description,
    },
    mandateId,
    mandate: {
      active: mandate.active,
      totalBudgetMinorUnits: mandate.totalBudgetMinorUnits,
      perPurchaseCapMinorUnits: mandate.perPurchaseCapMinorUnits,
      approvalThresholdMinorUnits: mandate.approvalThresholdMinorUnits,
      currency: mandate.currency,
      allowedMerchants: mandate.allowedMerchants,
      allowedCategories: mandate.allowedCategories,
      expiresAt: mandate.expiresAt.toISOString(),
    },
    order: setup.order,
    history: history.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
    userRequest: setup.userRequest,
    ...(setup.untrustedText === undefined
      ? {}
      : { untrustedText: setup.untrustedText }),
    deterministic,
    ...(setup.intent === undefined
      ? {}
      : {
          intent: {
            decision: setup.intent,
            applied: deterministic.verdict === 'ALLOW',
            ...(deterministic.verdict === 'ALLOW'
              ? { result: guardResultForIntent(setup.intent) }
              : {}),
          },
        }),
    final,
  };

  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    expectedVerdict: scenario.expectedVerdict,
    ...(scenario.expectedReasons === undefined
      ? {}
      : { expectedReasons: scenario.expectedReasons }),
    actualVerdict: final.verdict,
    actualReasons: final.reasons,
    passed,
    attackRunId: '',
    trail,
  };
}

function categoryScores(
  results: readonly ScenarioResult[],
): CategoryScore[] {
  const scores = new Map<string, CategoryScore>();

  for (const result of results) {
    const score = scores.get(result.category) ?? {
      category: result.category,
      passed: 0,
      total: 0,
    };
    score.total += 1;
    if (result.passed) {
      score.passed += 1;
    }
    scores.set(result.category, score);
  }

  const order = new Map<string, number>(
    REDTEAM_CATEGORIES.map((category, index) => [category, index]),
  );

  return [...scores.values()].sort((left, right) => {
    const leftIndex = order.get(left.category) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.category) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.category.localeCompare(right.category);
  });
}

function runName(marker: string, setName: RedteamSetName): string {
  return `redteam:${marker}:${setName}`;
}

export async function runRedteam(
  options: RedteamRunOptions,
): Promise<RedteamReport> {
  const now = options.now ?? new Date();
  const marker = options.marker ?? DEFAULT_MARKER;
  const scenarios = scenariosFor(options.setName);
  const results: ScenarioResult[] = [];
  const attackRun = await options.prisma.attackRun.create({
    data: {
      name: runName(marker, options.setName),
      status: AttackRunStatus.RUNNING,
      totalScenarios: scenarios.length,
      passedScenarios: 0,
      startedAt: now,
    },
  });

  for (const scenario of scenarios) {
    const mandate = await options.prisma.mandate.create({
      data: {
        totalBudgetMinorUnits: scenario.setup.mandate.totalBudgetMinorUnits,
        perPurchaseCapMinorUnits:
          scenario.setup.mandate.perPurchaseCapMinorUnits,
        approvalThresholdMinorUnits:
          scenario.setup.mandate.approvalThresholdMinorUnits,
        currency: scenario.setup.mandate.currency,
        allowedMerchants: [
          ...new Set([...scenario.setup.mandate.allowedMerchants, marker]),
        ],
        allowedCategories: [...scenario.setup.mandate.allowedCategories],
        expiresAt: new Date(now.getTime() + scenario.setup.mandate.expiresInMs),
      },
    });

    const evaluated = evaluateScenario(scenario, now, mandate.id, marker);
    results.push({ ...evaluated, attackRunId: attackRun.id });
  }

  const passed = results.filter((result) => result.passed).length;
  const categories = categoryScores(results);
  const failures = results.filter((result) => !result.passed);

  await options.prisma.attackRun.update({
    where: { id: attackRun.id },
    data: {
      status:
        failures.length === 0
          ? AttackRunStatus.PASSED
          : AttackRunStatus.FAILED,
      passedScenarios: passed,
      completedAt: new Date(),
      results: {
        setName: options.setName,
        marker,
        totalScenarios: results.length,
        passedScenarios: passed,
        categories,
        scenarios: results.map((result) => ({
          id: result.id,
          name: result.name,
          category: result.category,
          expectedVerdict: result.expectedVerdict,
          expectedReasons: result.expectedReasons ?? [],
          actualVerdict: result.actualVerdict,
          actualReasons: result.actualReasons,
          passed: result.passed,
          mandateId: result.trail.mandateId,
          trail: result.trail,
        })),
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    setName: options.setName,
    marker,
    total: results.length,
    passed,
    categories,
    results,
    failures,
  };
}

export function formatScorecard(report: RedteamReport): string {
  const lines = [
    `Red-team scorecard (${report.setName}): ${report.passed}/${report.total} passed`,
    '',
    'Category                     Passed  Total',
    '---------------------------  ------  -----',
  ];

  for (const score of report.categories) {
    lines.push(
      `${score.category.padEnd(27)}  ${String(score.passed).padStart(6)}  ${String(score.total).padStart(5)}`,
    );
  }

  if (report.failures.length === 0) {
    lines.push('', 'All scenarios matched their expected verdict.');
    return lines.join('\n');
  }

  lines.push('', `Failures (${report.failures.length}):`);

  for (const failure of report.failures) {
    lines.push(
      '',
      `[${failure.category}] ${failure.id}`,
      `  expected: ${failure.expectedVerdict}${
        failure.expectedReasons === undefined
          ? ''
          : ` ${failure.expectedReasons.join(', ')}`
      }`,
      `  actual:   ${failure.actualVerdict}${
        failure.actualReasons.length === 0
          ? ''
          : ` ${failure.actualReasons.join(', ')}`
      }`,
      '  trail:',
      JSON.stringify(failure.trail, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );
  }

  return lines.join('\n');
}
