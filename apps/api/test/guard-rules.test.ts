import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_POLICY,
  REASON_CODES,
  evaluateOrder,
  type MandateForGuard,
  type OrderHistoryEntry,
  type ProposedOrder,
} from '../src/guard/rules.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function mandate(overrides: Partial<MandateForGuard> = {}): MandateForGuard {
  return {
    active: true,
    totalBudgetMinorUnits: 100_000,
    perPurchaseCapMinorUnits: 20_000,
    approvalThresholdMinorUnits: 10_000,
    currency: 'USD',
    allowedMerchants: ['Amazon', 'Bookshop'],
    allowedCategories: ['books', 'electronics'],
    expiresAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function order(overrides: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    merchant: 'Amazon',
    category: 'books',
    currency: 'USD',
    amountMinorUnits: 2_000,
    items: [{ name: 'A Book', quantity: 2, unitAmountMinorUnits: 1_000 }],
    ...overrides,
  };
}

function historyEntry(overrides: Partial<OrderHistoryEntry> = {}): OrderHistoryEntry {
  return {
    ...order(),
    createdAt: new Date(NOW.getTime() - 5 * 60 * 1_000),
    ...overrides,
  };
}

function evaluate(
  currentOrder: ProposedOrder,
  history: OrderHistoryEntry[] = [],
  mandateOverrides: Partial<MandateForGuard> = {},
  policy?: Partial<typeof DEFAULT_RULES_POLICY>,
) {
  return evaluateOrder({
    mandate: mandate(mandateOverrides),
    order: currentOrder,
    history,
    now: NOW,
    ...(policy ? { policy } : {}),
  });
}

describe('evaluateOrder', () => {
  it('allows a valid order', () => {
    expect(evaluate(order())).toEqual({ verdict: 'ALLOW', reasons: [] });
  });

  it('normalizes currency, merchant and category casing', () => {
    expect(
      evaluate(
        order({
          merchant: ' amazon ',
          category: 'BOOKS',
          currency: 'usd',
        }),
      ),
    ).toEqual({ verdict: 'ALLOW', reasons: [] });
  });

  it('blocks an inactive mandate', () => {
    expect(evaluate(order(), [], { active: false })).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.MANDATE_INACTIVE],
    });
  });

  it('blocks an expired mandate', () => {
    expect(evaluate(order(), [], { expiresAt: NOW })).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.MANDATE_EXPIRED],
    });
  });

  it('blocks a currency mismatch', () => {
    expect(evaluate(order({ currency: 'EUR' }))).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.CURRENCY_MISMATCH],
    });
  });

  it('blocks a merchant that is not allowed', () => {
    expect(evaluate(order({ merchant: 'Other Store' }))).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.MERCHANT_NOT_ALLOWED],
    });
  });

  it('blocks a category that is not allowed', () => {
    expect(evaluate(order({ category: 'groceries' }))).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.CATEGORY_NOT_ALLOWED],
    });
  });

  it('blocks an order above the per-purchase cap', () => {
    const aboveCap = order({
      amountMinorUnits: 20_001,
      items: [{ name: 'Expensive Book', quantity: 1, unitAmountMinorUnits: 20_001 }],
    });

    expect(evaluate(aboveCap)).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.PER_PURCHASE_CAP_EXCEEDED],
    });
  });

  it('blocks when spent plus the new amount exceeds the total budget', () => {
    const priorSpend = historyEntry({
      merchant: 'Bookshop',
      amountMinorUnits: 99_000,
    });

    expect(evaluate(order(), [priorSpend])).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.TOTAL_BUDGET_EXCEEDED],
    });
  });

  it('blocks a line item above the quantity limit', () => {
    const tooMany = order({
      amountMinorUnits: 11_000,
      items: [{ name: 'A Book', quantity: 11, unitAmountMinorUnits: 1_000 }],
    });

    expect(evaluate(tooMany)).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.QUANTITY_LIMIT_EXCEEDED],
    });
  });

  it('blocks a cart above the total quantity limit', () => {
    const tooManyLines = order({
      amountMinorUnits: 5_400,
      items: [
        { name: 'Book A', quantity: 9, unitAmountMinorUnits: 200 },
        { name: 'Book B', quantity: 9, unitAmountMinorUnits: 200 },
        { name: 'Book C', quantity: 9, unitAmountMinorUnits: 200 },
      ],
    });

    expect(evaluate(tooManyLines)).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.QUANTITY_LIMIT_EXCEEDED],
    });
  });

  it('blocks when the cart total does not equal the sum of line items', () => {
    const mismatched = order({
      amountMinorUnits: 2_000,
      items: [{ name: 'A Book', quantity: 2, unitAmountMinorUnits: 900 }],
    });

    expect(evaluate(mismatched)).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.CART_TOTAL_MISMATCH],
    });
  });

  it('blocks a duplicate order inside the duplicate window', () => {
    const duplicate = historyEntry({
      createdAt: new Date(NOW.getTime() - 5 * 60 * 1_000),
    });

    expect(evaluate(order(), [duplicate])).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.DUPLICATE_ORDER],
    });
  });

  it('allows an order that matches history outside the duplicate window', () => {
    const oldOrder = historyEntry({
      createdAt: new Date(NOW.getTime() - 11 * 60 * 1_000),
    });

    expect(evaluate(order(), [oldOrder])).toEqual({
      verdict: 'ALLOW',
      reasons: [],
    });
  });

  it('requires approval after several small orders to the same merchant', () => {
    const priorSmallOrders = [
      historyEntry({
        amountMinorUnits: 1_000,
        createdAt: new Date(NOW.getTime() - 5 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_200,
        createdAt: new Date(NOW.getTime() - 10 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_400,
        createdAt: new Date(NOW.getTime() - 15 * 60 * 1_000),
      }),
    ];

    expect(evaluate(order(), priorSmallOrders)).toEqual({
      verdict: 'REQUIRE_APPROVAL',
      reasons: [REASON_CODES.VELOCITY_SMALL_ORDERS],
    });
  });

  it('does not apply velocity to small orders outside the window', () => {
    const priorSmallOrders = [
      historyEntry({
        amountMinorUnits: 1_000,
        createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_200,
        createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_400,
        createdAt: new Date(NOW.getTime() - 4 * 60 * 60 * 1_000),
      }),
    ];

    expect(evaluate(order(), priorSmallOrders)).toEqual({
      verdict: 'ALLOW',
      reasons: [],
    });
  });

  it('does not apply small-order velocity to a large order', () => {
    const priorSmallOrders = [
      historyEntry({
        amountMinorUnits: 1_000,
        createdAt: new Date(NOW.getTime() - 5 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_200,
        createdAt: new Date(NOW.getTime() - 10 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_400,
        createdAt: new Date(NOW.getTime() - 15 * 60 * 1_000),
      }),
    ];
    const largeOrder = order({
      amountMinorUnits: 15_000,
      items: [{ name: 'Laptop', quantity: 1, unitAmountMinorUnits: 15_000 }],
    });

    expect(evaluate(largeOrder, priorSmallOrders)).toEqual({
      verdict: 'ALLOW',
      reasons: [],
    });
  });

  it('lets BLOCK win over REQUIRE_APPROVAL while preserving both reasons', () => {
    const priorSmallOrders = [
      historyEntry({
        amountMinorUnits: 1_000,
        createdAt: new Date(NOW.getTime() - 5 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_200,
        createdAt: new Date(NOW.getTime() - 10 * 60 * 1_000),
      }),
      historyEntry({
        amountMinorUnits: 1_400,
        createdAt: new Date(NOW.getTime() - 15 * 60 * 1_000),
      }),
    ];

    const result = evaluate(order(), priorSmallOrders, { active: false });

    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        REASON_CODES.MANDATE_INACTIVE,
        REASON_CODES.VELOCITY_SMALL_ORDERS,
      ]),
    );
  });

  it('supports policy overrides for windows and thresholds', () => {
    const oldDuplicate = historyEntry({
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1_000),
    });

    expect(
      evaluate(order(), [oldDuplicate], {}, {
        duplicateWindowMs: 60 * 60 * 1_000,
      }),
    ).toEqual({
      verdict: 'BLOCK',
      reasons: [REASON_CODES.DUPLICATE_ORDER],
    });
  });
});
