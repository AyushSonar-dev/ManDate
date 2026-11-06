import { randomUUID } from 'node:crypto';
import { AttackRunStatus } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { REASON_CODES } from '../src/guard/rules.js';
import { loadHeldoutFile } from '../src/redteam/heldout.js';
import {
  formatScorecard,
  runRedteam,
  type RedteamReport,
} from '../src/redteam/runner.js';

const markers: string[] = [];

function newMarker(): string {
  const marker = `redteam-test-${randomUUID()}`;
  markers.push(marker);
  return marker;
}

async function cleanup(marker: string): Promise<void> {
  await prisma.attackRun.deleteMany({
    where: { name: { startsWith: `redteam:${marker}:` } },
  });
  await prisma.mandate.deleteMany({
    where: { allowedMerchants: { has: marker } },
  });
}

afterEach(async () => {
  await Promise.all(markers.splice(0).map(cleanup));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('red-team suite', () => {
  it('runs all core scenarios on fresh mandates and persists the attack run', async () => {
    const marker = newMarker();
    const report = await runRedteam({
      prisma,
      setName: 'core',
      now: new Date('2026-11-06T12:00:00.000Z'),
      marker,
    });

    expect(report.total).toBe(14);
    expect(report.passed).toBe(14);
    expect(report.failures).toEqual([]);
    expect(report.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'baseline', passed: 1, total: 1 }),
        expect.objectContaining({ category: 'spend_limits', passed: 2, total: 2 }),
        expect.objectContaining({ category: 'prompt_injection', passed: 2, total: 2 }),
        expect.objectContaining({ category: 'approval_threshold', passed: 1, total: 1 }),
        expect.objectContaining({ category: 'intent', passed: 1, total: 1 }),
      ]),
    );

    const mandateIds = report.results.map((result) => result.trail.mandateId);
    expect(new Set(mandateIds).size).toBe(14);

    const attackRuns = await prisma.attackRun.findMany({
      where: { name: { startsWith: `redteam:${marker}:` } },
    });

    expect(attackRuns).toHaveLength(1);
    expect(attackRuns[0]).toMatchObject({
      status: AttackRunStatus.PASSED,
      totalScenarios: 14,
      passedScenarios: 14,
    });
    expect(attackRuns[0]?.completedAt).toBeInstanceOf(Date);

    const intentMismatch = report.results.find(
      (result) => result.id === 'intent-mismatch',
    );
    expect(intentMismatch?.actualVerdict).toBe('REQUIRE_APPROVAL');
    expect(intentMismatch?.actualReasons).toEqual([
      REASON_CODES.INTENT_MISMATCH,
    ]);
    expect(intentMismatch?.trail.intent?.applied).toBe(true);
  });

  it('runs the model-generated held-out set without changing the guard', async () => {
    const marker = newMarker();
    const heldout = loadHeldoutFile();
    const report = await runRedteam({
      prisma,
      setName: 'heldout',
      now: new Date('2026-11-06T12:00:00.000Z'),
      marker,
    });

    expect(heldout.scenarios.length).toBeGreaterThanOrEqual(10);
    expect(report.total).toBe(heldout.scenarios.length);
    expect(report.passed).toBe(report.total);
    expect(report.failures).toEqual([]);
  });

  it('prints the decision trail for failures', () => {
    const report: RedteamReport = {
      setName: 'core',
      marker: 'test-marker',
      total: 1,
      passed: 0,
      categories: [{ category: 'spend_limits', passed: 0, total: 1 }],
      results: [],
      failures: [
        {
          id: 'fake-failure',
          name: 'Fake failure',
          category: 'spend_limits',
          expectedVerdict: 'BLOCK',
          expectedReasons: [REASON_CODES.PER_PURCHASE_CAP_EXCEEDED],
          actualVerdict: 'ALLOW',
          actualReasons: [],
          passed: false,
          attackRunId: 'run-1',
          trail: {
            scenario: {
              id: 'fake-failure',
              name: 'Fake failure',
              category: 'spend_limits',
              description: 'test',
            },
            mandateId: 'mandate-1',
            mandate: {
              active: true,
              totalBudgetMinorUnits: 100_000,
              perPurchaseCapMinorUnits: 20_000,
              approvalThresholdMinorUnits: 10_000,
              currency: 'USD',
              allowedMerchants: ['Amazon'],
              allowedCategories: ['books'],
              expiresAt: '2026-11-13T12:00:00.000Z',
            },
            order: {
              merchant: 'Amazon',
              category: 'books',
              currency: 'USD',
              amountMinorUnits: 25_000,
              feeMinorUnits: 0,
              items: [
                { name: 'A Book', quantity: 1, unitAmountMinorUnits: 25_000 },
              ],
            },
            history: [],
            userRequest: 'Buy a book.',
            deterministic: { verdict: 'ALLOW', reasons: [] },
            final: { verdict: 'ALLOW', reasons: [] },
          },
        },
      ],
    };

    const output = formatScorecard(report);

    expect(output).toContain('Failures (1):');
    expect(output).toContain('fake-failure');
    expect(output).toContain('trail:');
    expect(output).toContain('expected: BLOCK PER_PURCHASE_CAP_EXCEEDED');
    expect(output).toContain('"deterministic": {');
  });
});
