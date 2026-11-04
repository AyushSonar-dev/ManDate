import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { REASON_CODES } from '../src/guard/rules.js';
import { PrismaGuardStore } from '../src/guard/store.js';
import type { GuardDecisionInput, GuardOrderInput } from '../src/guard/store.js';

const store = new PrismaGuardStore(prisma);
const testMerchant = 'guard-store-test-merchant';

async function cleanup(): Promise<void> {
  await prisma.mandate.deleteMany({
    where: { allowedMerchants: { has: testMerchant } },
  });
}

async function createMandate(): Promise<string> {
  const mandate = await prisma.mandate.create({
    data: {
      totalBudgetMinorUnits: 100_000,
      perPurchaseCapMinorUnits: 20_000,
      approvalThresholdMinorUnits: 10_000,
      currency: 'USD',
      allowedMerchants: [testMerchant],
      allowedCategories: ['books'],
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  return mandate.id;
}

function order(mandateId: string, idempotencyKey: string): GuardOrderInput {
  return {
    mandateId,
    merchant: testMerchant,
    category: 'books',
    amountMinorUnits: 2_000,
    feeMinorUnits: 0,
    currency: 'USD',
    items: [{ name: 'A Book', quantity: 2, unitAmountMinorUnits: 1_000 }],
    idempotencyKey,
  };
}

function decision(
  mandateId: string,
  verdict: GuardDecisionInput['verdict'],
): GuardDecisionInput {
  return {
    mandateId,
    verdict,
    reasons:
      verdict === 'ALLOW' ? [] : [REASON_CODES.VELOCITY_SMALL_ORDERS],
    toolName: 'create_order',
    requestPayload: { test: true },
  };
}

beforeAll(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('PrismaGuardStore', () => {
  it('persists an allowed order and its decision, then returns it as history', async () => {
    const mandateId = await createMandate();

    const saved = await store.saveAllowedOrder({
      order: order(mandateId, 'guard-store-allow-1'),
      decision: decision(mandateId, 'ALLOW'),
    });
    await store.finalizeOrder(saved.orderId, {
      paypalOrderId: 'PAYPAL-GUARD-STORE-1',
      approvalLink: 'https://example.test/approve',
    });

    const history = await store.loadHistory(mandateId);
    const persistedDecision = await prisma.decision.findUnique({
      where: { id: saved.decisionId },
    });

    expect(history).toEqual([
      expect.objectContaining({
        merchant: testMerchant,
        amountMinorUnits: 2_000,
        items: [{ name: 'A Book', quantity: 2, unitAmountMinorUnits: 1_000 }],
      }),
    ]);
    expect(persistedDecision?.verdict).toBe('ALLOW');
    expect(persistedDecision?.orderId).toBe(saved.orderId);
  });

  it('persists a pending approval and excludes that order from history', async () => {
    const mandateId = await createMandate();

    const pending = await store.savePendingApproval({
      order: order(mandateId, 'guard-store-pending-1'),
      reason: 'needs approval',
      decision: decision(mandateId, 'REQUIRE_APPROVAL'),
    });

    const history = await store.loadHistory(mandateId);
    const approval = await prisma.approval.findUnique({
      where: { id: pending.approvalId },
    });

    expect(history).toEqual([]);
    expect(approval).toMatchObject({
      orderId: pending.orderId,
      status: 'PENDING',
      reason: 'needs approval',
    });
  });

  it('excludes a failed order from history', async () => {
    const mandateId = await createMandate();

    const saved = await store.saveAllowedOrder({
      order: order(mandateId, 'guard-store-failed-1'),
      decision: decision(mandateId, 'ALLOW'),
    });
    await store.markOrderFailed(saved.orderId);

    expect(await store.loadHistory(mandateId)).toEqual([]);
  });
});
