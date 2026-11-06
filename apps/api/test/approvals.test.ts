import type { PaypalOrderSnapshot, PaypalOrders } from '../src/paypal/orders.js';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { PrismaGuardStore } from '../src/guard/store.js';

const store = new PrismaGuardStore(prisma);
const testMerchant = 'approvals-test-merchant';

function snapshot(
  overrides: Partial<PaypalOrderSnapshot> = {},
): PaypalOrderSnapshot {
  return {
    paypalOrderId: 'PAYPAL-ORDER-1',
    status: 'CREATED',
    captured: false,
    raw: {},
    ...overrides,
  };
}

interface FakePaypal extends PaypalOrders {
  calls: {
    create: number;
    get: number;
    capture: number;
  };
  setGets(results: PaypalOrderSnapshot[]): void;
  setCapture(result: PaypalOrderSnapshot): void;
}

function fakePaypal(): FakePaypal {
  let gets = [snapshot()];
  let capture = snapshot({
    status: 'COMPLETED',
    captured: true,
    captureId: 'CAPTURE-1',
    captureStatus: 'COMPLETED',
  });
  const calls = { create: 0, get: 0, capture: 0 };

  return {
    calls,
    setGets(results) {
      gets = results;
    },
    setCapture(result) {
      capture = result;
    },
    async createOrder() {
      calls.create += 1;
      return snapshot({
        paypalOrderId: 'PAYPAL-ORDER-1',
        status: 'CREATED',
        approvalLink: 'https://sandbox.paypal.test/approve',
      });
    },
    async getOrder(paypalOrderId) {
      const result = gets[Math.min(calls.get, gets.length - 1)] ?? snapshot();
      calls.get += 1;
      return { ...result, paypalOrderId };
    },
    async captureOrder(paypalOrderId) {
      calls.capture += 1;
      return { ...capture, paypalOrderId };
    },
  };
}

async function cleanup(): Promise<void> {
  await prisma.mandate.deleteMany({
    where: { allowedMerchants: { has: testMerchant } },
  });
}

async function createPendingApproval(input: {
  amountMinorUnits?: number;
  idempotencyKey: string;
}) {
  const amountMinorUnits = input.amountMinorUnits ?? 15_000;
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
  const pending = await store.savePendingApproval({
    order: {
      mandateId: mandate.id,
      merchant: testMerchant,
      category: 'books',
      amountMinorUnits,
      feeMinorUnits: 0,
      currency: 'USD',
      items: [
        { name: 'A Book', quantity: 1, unitAmountMinorUnits: amountMinorUnits },
      ],
      idempotencyKey: input.idempotencyKey,
    },
    reason: 'Purchase above approval threshold',
    decision: {
      mandateId: mandate.id,
      verdict: 'REQUIRE_APPROVAL',
      reasons: [],
      toolName: 'create_order',
      requestPayload: { test: true },
    },
  });

  return { mandate, ...pending };
}

beforeAll(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('GET /approvals', () => {
  it('lists pending approvals without calling PayPal', async () => {
    const pending = await createPendingApproval({
      idempotencyKey: 'approvals-list-1',
    });
    const paypal = fakePaypal();
    const app = createApp({ prisma, paypalOrders: paypal });

    const response = await request(app).get('/approvals?status=PENDING');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pending.approvalId,
          orderId: pending.orderId,
          mandateId: pending.mandate.id,
          status: 'PENDING',
          reason: 'Purchase above approval threshold',
          approvedBy: null,
        }),
      ]),
    );
    expect(paypal.calls).toEqual({ create: 0, get: 0, capture: 0 });
  });
});

describe('POST /approvals/:id/reject', () => {
  it('denies the approval and fails the order without calling PayPal', async () => {
    const pending = await createPendingApproval({
      idempotencyKey: 'approvals-reject-1',
    });
    const paypal = fakePaypal();
    const app = createApp({ prisma, paypalOrders: paypal });

    const response = await request(app)
      .post(`/approvals/${pending.approvalId}/reject`)
      .send({ rejectedBy: 'alice' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'DENIED',
      approval: {
        id: pending.approvalId,
        status: 'DENIED',
        approvedBy: 'alice',
        resolvedBy: 'alice',
      },
      order: {
        id: pending.orderId,
        status: 'FAILED',
      },
    });
    expect(paypal.calls).toEqual({ create: 0, get: 0, capture: 0 });

    const second = await request(app)
      .post(`/approvals/${pending.approvalId}/reject`)
      .send({ rejectedBy: 'alice' });

    expect(second.status).toBe(409);
  });
});

describe('POST /approvals/:id/approve', () => {
  it('re-runs the guard and denies without calling PayPal when the verdict is now BLOCK', async () => {
    const pending = await createPendingApproval({
      idempotencyKey: 'approvals-block-1',
    });
    await prisma.mandate.update({
      where: { id: pending.mandate.id },
      data: { totalBudgetMinorUnits: 1_000 },
    });
    const paypal = fakePaypal();
    const app = createApp({ prisma, paypalOrders: paypal });

    const response = await request(app)
      .post(`/approvals/${pending.approvalId}/approve`)
      .send({ approvedBy: 'alice' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      status: 'DENIED',
      verdict: 'BLOCK',
      reasons: ['TOTAL_BUDGET_EXCEEDED'],
    });
    expect(paypal.calls).toEqual({ create: 0, get: 0, capture: 0 });

    const [approval, order, decisions] = await Promise.all([
      prisma.approval.findUniqueOrThrow({
        where: { id: pending.approvalId },
      }),
      prisma.order.findUniqueOrThrow({ where: { id: pending.orderId } }),
      prisma.decision.findMany({
        where: { orderId: pending.orderId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    expect(approval).toMatchObject({
      status: 'DENIED',
      resolvedBy: 'alice',
    });
    expect(order).toMatchObject({ status: 'FAILED', paypalOrderId: null });
    expect(decisions.at(-1)).toMatchObject({
      verdict: 'BLOCK',
      toolName: 'approval_rerun',
      reason: 'TOTAL_BUDGET_EXCEEDED',
    });
  });

  it('creates the PayPal order, waits for sandbox approval, captures once, and records spent', async () => {
    const pending = await createPendingApproval({
      idempotencyKey: 'approvals-capture-1',
    });
    const paypal = fakePaypal();
    paypal.setGets([
      snapshot({ status: 'CREATED' }),
      snapshot({ status: 'APPROVED' }),
    ]);
    const app = createApp({ prisma, paypalOrders: paypal });

    const first = await request(app)
      .post(`/approvals/${pending.approvalId}/approve`)
      .send({ approvedBy: 'alice' });

    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      status: 'PENDING_BUYER_APPROVAL',
      paypalOrderId: 'PAYPAL-ORDER-1',
      approvalLink: 'https://sandbox.paypal.test/approve',
    });
    expect(paypal.calls).toEqual({ create: 1, get: 1, capture: 0 });

    const afterPending = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: pending.orderId } }),
      prisma.approval.findUniqueOrThrow({
        where: { id: pending.approvalId },
      }),
      prisma.mandate.findUniqueOrThrow({ where: { id: pending.mandate.id } }),
    ]);

    expect(afterPending[0]).toMatchObject({
      status: 'APPROVED',
      paypalOrderId: 'PAYPAL-ORDER-1',
    });
    expect(afterPending[1].status).toBe('PENDING');
    expect(afterPending[2].spentMinorUnits).toBe(0);

    const second = await request(app)
      .post(`/approvals/${pending.approvalId}/approve`)
      .send({ approvedBy: 'alice' });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: 'CAPTURED',
      paypalOrderId: 'PAYPAL-ORDER-1',
      captureId: 'CAPTURE-1',
      order: { status: 'CAPTURED' },
      approval: { status: 'APPROVED', approvedBy: 'alice' },
      mandate: { spentMinorUnits: 15_000 },
    });
    expect(paypal.calls).toEqual({ create: 1, get: 2, capture: 1 });

    const third = await request(app)
      .post(`/approvals/${pending.approvalId}/approve`)
      .send({ approvedBy: 'alice' });

    expect(third.status).toBe(409);
    expect(paypal.calls).toEqual({ create: 1, get: 2, capture: 1 });

    const mandate = await prisma.mandate.findUniqueOrThrow({
      where: { id: pending.mandate.id },
    });
    expect(mandate.spentMinorUnits).toBe(15_000);
  });

  it('does not record spent when capture fails, then succeeds on retry', async () => {
    const pending = await createPendingApproval({
      idempotencyKey: 'approvals-capture-fail-1',
    });
    const paypal = fakePaypal();
    paypal.setGets([snapshot({ status: 'APPROVED' })]);
    paypal.setCapture(
      snapshot({
        status: 'COMPLETED',
        captured: false,
        captureStatus: 'DECLINED',
        errorMessage: 'The transaction was declined',
      }),
    );
    const app = createApp({ prisma, paypalOrders: paypal });

    const failed = await request(app)
      .post(`/approvals/${pending.approvalId}/approve`)
      .send({ approvedBy: 'alice' });

    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({
      status: 'PAYPAL_ERROR',
      error: 'The transaction was declined',
    });

    const beforeRetry = await Promise.all([
      prisma.mandate.findUniqueOrThrow({ where: { id: pending.mandate.id } }),
      prisma.approval.findUniqueOrThrow({
        where: { id: pending.approvalId },
      }),
      prisma.order.findUniqueOrThrow({ where: { id: pending.orderId } }),
    ]);

    expect(beforeRetry[0].spentMinorUnits).toBe(0);
    expect(beforeRetry[1].status).toBe('PENDING');
    expect(beforeRetry[2].status).toBe('APPROVED');

    paypal.setCapture(
      snapshot({
        status: 'COMPLETED',
        captured: true,
        captureId: 'CAPTURE-2',
        captureStatus: 'COMPLETED',
      }),
    );

    const retried = await request(app)
      .post(`/approvals/${pending.approvalId}/approve`)
      .send({ approvedBy: 'alice' });

    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      status: 'CAPTURED',
      captureId: 'CAPTURE-2',
    });

    const mandate = await prisma.mandate.findUniqueOrThrow({
      where: { id: pending.mandate.id },
    });
    expect(mandate.spentMinorUnits).toBe(15_000);
  });
});

describe('GET /orders/:id/receipt', () => {
  it('returns the full decision trail, approver, and PayPal identifiers', async () => {
    const pending = await createPendingApproval({
      idempotencyKey: 'approvals-receipt-1',
    });
    const paypal = fakePaypal();
    paypal.setGets([snapshot({ status: 'APPROVED' })]);
    const app = createApp({ prisma, paypalOrders: paypal });

    await request(app)
      .post(`/approvals/${pending.approvalId}/approve`)
      .send({ approvedBy: 'alice' });

    const response = await request(app).get(
      `/orders/${pending.orderId}/receipt`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      order: {
        id: pending.orderId,
        status: 'CAPTURED',
      },
      paypalOrderId: 'PAYPAL-ORDER-1',
      captureId: 'CAPTURE-1',
      approvedBy: 'alice',
      rules: {
        failed: ['APPROVAL_THRESHOLD_EXCEEDED'],
      },
    });
    expect(response.body.decisions).toEqual([
      expect.objectContaining({
        verdict: 'REQUIRE_APPROVAL',
        toolName: 'create_order',
      }),
      expect.objectContaining({
        verdict: 'REQUIRE_APPROVAL',
        toolName: 'approval_rerun',
        reasons: ['APPROVAL_THRESHOLD_EXCEEDED'],
      }),
    ]);
    expect(response.body.approvals).toEqual([
      expect.objectContaining({
        id: pending.approvalId,
        status: 'APPROVED',
        approvedBy: 'alice',
        resolvedBy: 'alice',
      }),
    ]);
    expect(response.body.rules.passed).toEqual(
      expect.arrayContaining([
        'TOTAL_BUDGET_EXCEEDED',
        'PER_PURCHASE_CAP_EXCEEDED',
        'MERCHANT_NOT_ALLOWED',
      ]),
    );
  });

  it('returns 404 for an unknown order', async () => {
    const app = createApp({ prisma, paypalOrders: fakePaypal() });

    const response = await request(app).get(
      '/orders/00000000-0000-0000-0000-000000000000/receipt',
    );

    expect(response.status).toBe(404);
  });
});
