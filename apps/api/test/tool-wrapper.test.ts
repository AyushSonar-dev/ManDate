import { describe, expect, it, vi } from 'vitest';
import {
  REASON_CODES,
  type MandateForGuard,
  type OrderHistoryEntry,
} from '../src/guard/rules.js';
import type {
  IntentCheckDecision,
  IntentChecker,
} from '../src/guard/intent.js';
import {
  InvalidOrderInputError,
  mapCreateOrderArgsToProposedOrder,
} from '../src/guard/order-mapping.js';
import type {
  GuardDecisionInput,
  GuardOrderInput,
  GuardStore,
} from '../src/guard/store.js';
import {
  wrapToolkitTools,
  type ToolkitTool,
} from '../src/guard/tool-wrapper.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const mandate: MandateForGuard = {
  active: true,
  totalBudgetMinorUnits: 100_000,
  perPurchaseCapMinorUnits: 20_000,
  approvalThresholdMinorUnits: 10_000,
  currency: 'USD',
  allowedMerchants: ['Amazon'],
  allowedCategories: ['books'],
  expiresAt: new Date('2026-07-01T00:00:00.000Z'),
};

const context = {
  mandateId: 'mandate-1',
  merchant: 'Amazon',
  category: 'books',
};

const validArgs = {
  currencyCode: 'USD',
  items: [
    {
      name: 'A Book',
      quantity: 2,
      itemCost: 10,
      taxPercent: 0,
      itemTotal: 20,
    },
  ],
};

function historyEntry(overrides: Partial<OrderHistoryEntry> = {}): OrderHistoryEntry {
  return {
    merchant: 'Amazon',
    category: 'books',
    currency: 'USD',
    amountMinorUnits: 1_000,
    items: [{ name: 'Small Book', quantity: 1, unitAmountMinorUnits: 1_000 }],
    createdAt: new Date(NOW.getTime() - 5 * 60 * 1_000),
    ...overrides,
  };
}

class FakeStore implements GuardStore {
  events: string[] = [];
  decisions: GuardDecisionInput[] = [];
  orders: GuardOrderInput[] = [];
  approvals: Array<{ orderId: string; reason: string; status: string }> = [];
  finalized: Array<{ orderId: string; paypalOrderId: string; approvalLink?: string }> = [];
  failedOrderIds: string[] = [];
  failLoadMandate = false;
  failSaveAllowedOrder = false;

  constructor(
    private readonly currentMandate: MandateForGuard | null = mandate,
    private readonly currentHistory: OrderHistoryEntry[] = [],
  ) {}

  async loadMandate(): Promise<MandateForGuard | null> {
    this.events.push('load-mandate');

    if (this.failLoadMandate) {
      throw new Error('mandate load failed');
    }

    return this.currentMandate;
  }

  async loadHistory(): Promise<OrderHistoryEntry[]> {
    this.events.push('load-history');
    return this.currentHistory;
  }

  async saveDecision(input: GuardDecisionInput): Promise<{ id: string }> {
    this.events.push('decision');
    this.decisions.push(input);
    return { id: `decision-${this.decisions.length}` };
  }

  async saveAllowedOrder(input: {
    order: GuardOrderInput;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; decisionId: string }> {
    this.events.push('order');

    if (this.failSaveAllowedOrder) {
      throw new Error('order save failed');
    }

    this.orders.push(input.order);
    this.decisions.push(input.decision);
    return { orderId: 'local-order-1', decisionId: 'decision-allow' };
  }

  async savePendingApproval(input: {
    order: GuardOrderInput;
    reason: string;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; approvalId: string; decisionId: string }> {
    this.events.push('pending-approval');
    this.orders.push(input.order);
    this.decisions.push(input.decision);
    this.approvals.push({
      orderId: 'local-order-1',
      reason: input.reason,
      status: 'PENDING',
    });
    return {
      orderId: 'local-order-1',
      approvalId: 'approval-1',
      decisionId: 'decision-require',
    };
  }

  async finalizeOrder(
    orderId: string,
    input: { paypalOrderId: string; approvalLink?: string },
  ): Promise<void> {
    this.events.push('finalize');
    this.finalized.push({ orderId, ...input });
  }

  async markOrderFailed(orderId: string): Promise<void> {
    this.events.push('failed');
    this.failedOrderIds.push(orderId);
  }
}

type ToolExecute = (
  args: Record<string, unknown>,
  options: unknown,
) => PromiseLike<unknown> | unknown;

function tool(execute: ToolExecute): ToolkitTool {
  return { description: 'test tool', parameters: {}, execute };
}

function paypalResult(): Record<string, unknown> {
  return {
    id: 'PAYPAL-ORDER-1',
    status: 'CREATED',
    links: [
      { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/1' },
      { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=1' },
    ],
  };
}

function guard(options: {
  store?: FakeStore;
  createOrderExecute?: ToolExecute;
  intentChecker?: IntentChecker;
  userRequest?: string;
} = {}) {
  const store = options.store ?? new FakeStore();
  const createOrderExecute =
    options.createOrderExecute ??
    vi.fn(async () => {
      store.events.push('paypal');
      return paypalResult();
    });
  const getOrderExecute = vi.fn(async () => ({ id: 'PAYPAL-ORDER-1' }));

  const tools = wrapToolkitTools(
    {
      create_order: tool(createOrderExecute),
      get_order: tool(getOrderExecute),
    },
    {
      context,
      store,
      now: () => NOW,
      generateIdempotencyKey: () => 'idem-1',
      ...(options.intentChecker === undefined
        ? {}
        : { intentChecker: options.intentChecker }),
      ...(options.userRequest === undefined
        ? {}
        : { userRequest: options.userRequest }),
    },
  );

  return { store, tools, createOrderExecute, getOrderExecute };
}

function fakeIntent(result: IntentCheckDecision): IntentChecker & {
  check: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn(async () => result);

  return { check };
}

describe('mapCreateOrderArgsToProposedOrder', () => {
  it('maps toolkit amounts to integer minor units including fees', () => {
    const proposed = mapCreateOrderArgsToProposedOrder(
      {
        currencyCode: 'usd',
        items: [
          {
            name: 'A Book',
            quantity: 2,
            itemCost: 10,
            taxPercent: 10,
            itemTotal: 22,
          },
        ],
        shippingCost: 5,
        discount: 1,
      },
      context,
    );

    expect(proposed).toEqual({
      merchant: 'Amazon',
      category: 'books',
      currency: 'USD',
      amountMinorUnits: 2_600,
      feeMinorUnits: 600,
      items: [{ name: 'A Book', quantity: 2, unitAmountMinorUnits: 1_000 }],
    });
  });

  it('rejects money with more than two decimal places', () => {
    expect(() =>
      mapCreateOrderArgsToProposedOrder(
        {
          currencyCode: 'USD',
          items: [{ name: 'A Book', quantity: 1, itemCost: 1.001 }],
        },
        context,
      ),
    ).toThrow(InvalidOrderInputError);
  });

  it('rejects an empty cart', () => {
    expect(() =>
      mapCreateOrderArgsToProposedOrder(
        { currencyCode: 'USD', items: [] },
        context,
      ),
    ).toThrow(InvalidOrderInputError);
  });
});

describe('wrapToolkitTools', () => {
  it('calls PayPal and finalizes the order only after saving an ALLOW decision', async () => {
    const { store, tools, createOrderExecute } = guard();

    const result = await tools.create_order?.execute?.(validArgs, {});

    expect(result).toEqual(paypalResult());
    expect(createOrderExecute).toHaveBeenCalledTimes(1);
    expect(store.events.indexOf('decision')).toBeLessThan(
      store.events.indexOf('paypal'),
    );
    expect(store.orders).toHaveLength(1);
    expect(store.orders[0]).toMatchObject({
      mandateId: 'mandate-1',
      amountMinorUnits: 2_000,
      currency: 'USD',
      idempotencyKey: 'idem-1',
    });
    expect(store.finalized).toEqual([
      {
        orderId: 'local-order-1',
        paypalOrderId: 'PAYPAL-ORDER-1',
        approvalLink: 'https://www.sandbox.paypal.com/checkoutnow?token=1',
      },
    ]);
  });

  it('runs the intent check after an ALLOW and proceeds on match', async () => {
    const intentChecker = fakeIntent({
      status: 'checked',
      match: 'match',
      reasons: ['matches the request'],
    });
    const { store, tools, createOrderExecute } = guard({
      intentChecker,
      userRequest: 'buy a book',
    });

    const result = await tools.create_order?.execute?.(validArgs, {});

    expect(result).toEqual(paypalResult());
    expect(intentChecker.check).toHaveBeenCalledWith({
      userRequest: 'buy a book',
      cart: {
        merchant: 'Amazon',
        category: 'books',
        currency: 'USD',
        amountMinorUnits: 2_000,
        feeMinorUnits: 0,
        items: [{ name: 'A Book', quantity: 2, unitAmountMinorUnits: 1_000 }],
      },
    });
    expect(createOrderExecute).toHaveBeenCalledTimes(1);
    expect(store.decisions[0]).toMatchObject({
      verdict: 'ALLOW',
      requestPayload: {
        intent: {
          match: 'match',
          reasons: ['matches the request'],
        },
      },
    });
  });

  it.each([
    ['partial', REASON_CODES.INTENT_PARTIAL],
    ['mismatch', REASON_CODES.INTENT_MISMATCH],
  ] as const)(
    'requires approval and never calls PayPal when intent is %s',
    async (match, reason) => {
      const intentChecker = fakeIntent({
        status: 'checked',
        match,
        reasons: ['does not fully match'],
      });
      const { store, tools, createOrderExecute } = guard({
        intentChecker,
        userRequest: 'buy a book',
      });

      const result = (await tools.create_order?.execute?.(
        validArgs,
        {},
      )) as Record<string, unknown>;

      expect(result).toMatchObject({
        pending: true,
        verdict: 'REQUIRE_APPROVAL',
        status: 'PENDING_APPROVAL',
      });
      expect(result.reasons).toEqual([reason]);
      expect(createOrderExecute).not.toHaveBeenCalled();
      expect(store.events).not.toContain('paypal');
      expect(store.approvals).toHaveLength(1);
      expect(store.decisions[0]).toMatchObject({
        verdict: 'REQUIRE_APPROVAL',
        requestPayload: {
          intent: {
            match,
            reasons: ['does not fully match'],
          },
        },
      });
    },
  );

  it('fails closed to approval when the intent checker throws', async () => {
    const intentChecker: IntentChecker = {
      check: vi.fn(async () => {
        throw new Error('model unavailable');
      }),
    };
    const { store, tools, createOrderExecute } = guard({
      intentChecker,
      userRequest: 'buy a book',
    });

    const result = (await tools.create_order?.execute?.(validArgs, {})) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      pending: true,
      verdict: 'REQUIRE_APPROVAL',
    });
    expect(result.reasons).toEqual([REASON_CODES.INTENT_CHECK_FAILED]);
    expect(createOrderExecute).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
  });

  it('fails closed when the intent checker is configured without a user request', async () => {
    const intentChecker = fakeIntent({
      status: 'checked',
      match: 'match',
      reasons: [],
    });
    const { store, tools, createOrderExecute } = guard({ intentChecker });

    const result = (await tools.create_order?.execute?.(validArgs, {})) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      pending: true,
      verdict: 'REQUIRE_APPROVAL',
    });
    expect(result.reasons).toEqual([REASON_CODES.INTENT_CHECK_FAILED]);
    expect(intentChecker.check).not.toHaveBeenCalled();
    expect(createOrderExecute).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
  });

  it('does not run intent when Layer 1 blocks', async () => {
    const intentChecker = fakeIntent({
      status: 'checked',
      match: 'match',
      reasons: [],
    });
    const { tools, createOrderExecute } = guard({
      intentChecker,
      userRequest: 'buy a book',
    });

    const result = (await tools.create_order?.execute?.(
      {
        ...validArgs,
        items: [{ name: 'Fast Laptop', quantity: 1, itemCost: 300 }],
      },
      {},
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ blocked: true, verdict: 'BLOCK' });
    expect(intentChecker.check).not.toHaveBeenCalled();
    expect(createOrderExecute).not.toHaveBeenCalled();
  });

  it('does not run intent when Layer 1 already requires approval', async () => {
    const store = new FakeStore(mandate, [
      historyEntry(),
      historyEntry({ amountMinorUnits: 1_100 }),
      historyEntry({ amountMinorUnits: 1_200 }),
    ]);
    const intentChecker = fakeIntent({
      status: 'checked',
      match: 'match',
      reasons: [],
    });
    const { tools, createOrderExecute } = guard({
      store,
      intentChecker,
      userRequest: 'buy a book',
    });

    const result = (await tools.create_order?.execute?.(validArgs, {})) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      pending: true,
      verdict: 'REQUIRE_APPROVAL',
    });
    expect(result.reasons).toEqual([REASON_CODES.VELOCITY_SMALL_ORDERS]);
    expect(intentChecker.check).not.toHaveBeenCalled();
    expect(createOrderExecute).not.toHaveBeenCalled();
  });

  it('returns a refusal and never calls PayPal when the guard blocks', async () => {
    const { store, tools, createOrderExecute } = guard();

    const result = (await tools.create_order?.execute?.(
      {
        ...validArgs,
        items: [{ name: 'Fast Laptop', quantity: 1, itemCost: 300 }],
      },
      {},
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      blocked: true,
      verdict: 'BLOCK',
      status: 'BLOCKED',
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([REASON_CODES.PER_PURCHASE_CAP_EXCEEDED]),
    );
    expect(createOrderExecute).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]?.verdict).toBe('BLOCK');
    expect(store.orders).toHaveLength(0);
  });

  it('saves a pending approval and never calls PayPal when approval is required', async () => {
    const store = new FakeStore(mandate, [
      historyEntry(),
      historyEntry({ amountMinorUnits: 1_100 }),
      historyEntry({ amountMinorUnits: 1_200 }),
    ]);
    const { tools, createOrderExecute } = guard({ store });

    const result = (await tools.create_order?.execute?.(validArgs, {})) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      pending: true,
      verdict: 'REQUIRE_APPROVAL',
      status: 'PENDING_APPROVAL',
      approvalId: 'approval-1',
      orderId: 'local-order-1',
    });
    expect(result.reasons).toEqual([REASON_CODES.VELOCITY_SMALL_ORDERS]);
    expect(createOrderExecute).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
    expect(store.approvals).toEqual([
      expect.objectContaining({ status: 'PENDING', orderId: 'local-order-1' }),
    ]);
    expect(store.orders[0]?.idempotencyKey).toBe('idem-1');
  });

  it('fails closed with no PayPal call when guard state cannot be loaded', async () => {
    const store = new FakeStore();
    store.failLoadMandate = true;
    const { tools, createOrderExecute } = guard({ store });

    const result = (await tools.create_order?.execute?.(validArgs, {})) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ blocked: true, verdict: 'BLOCK' });
    expect(result.reasons).toEqual([REASON_CODES.INTERNAL_ERROR]);
    expect(createOrderExecute).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
    expect(store.events).not.toContain('order');
  });

  it('fails closed with no PayPal call when order arguments are malformed', async () => {
    const { store, tools, createOrderExecute } = guard();

    const result = (await tools.create_order?.execute?.(
      { currencyCode: 'USD', items: [] },
      {},
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ blocked: true, verdict: 'BLOCK' });
    expect(result.reasons).toEqual([REASON_CODES.INVALID_ORDER_INPUT]);
    expect(createOrderExecute).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
  });

  it('fails closed with no PayPal call when the order cannot be saved', async () => {
    const store = new FakeStore();
    store.failSaveAllowedOrder = true;
    const { tools, createOrderExecute } = guard({ store });

    const result = (await tools.create_order?.execute?.(validArgs, {})) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ blocked: true, verdict: 'BLOCK' });
    expect(result.reasons).toEqual([REASON_CODES.INTERNAL_ERROR]);
    expect(createOrderExecute).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
  });

  it('marks the local order failed when the PayPal call throws', async () => {
    const store = new FakeStore();
    const createOrderExecute = vi.fn(async () => {
      throw new Error('PayPal unavailable');
    });
    const { tools } = guard({ store, createOrderExecute });

    const result = (await tools.create_order?.execute?.(validArgs, {})) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({ blocked: true, verdict: 'BLOCK' });
    expect(result.reasons).toEqual([REASON_CODES.PAYPAL_CALL_FAILED]);
    expect(store.failedOrderIds).toEqual(['local-order-1']);
  });

  it('leaves non-create tools callable without running the order guard', async () => {
    const { store, tools, getOrderExecute } = guard();

    const result = await tools.get_order?.execute?.({ id: 'PAYPAL-ORDER-1' }, {});

    expect(result).toEqual({ id: 'PAYPAL-ORDER-1' });
    expect(getOrderExecute).toHaveBeenCalledTimes(1);
    expect(store.events).toHaveLength(0);
  });

  it('resolves guard context from the order arguments', async () => {
    const store = new FakeStore();
    const createOrderExecute = vi.fn(async () => {
      store.events.push('paypal');
      return paypalResult();
    });
    const resolveContext = vi.fn(async (args: Record<string, unknown>) => {
      expect(args).toEqual(validArgs);
      return context;
    });
    const tools = wrapToolkitTools(
      { create_order: tool(createOrderExecute) },
      {
        context: resolveContext,
        store,
        now: () => NOW,
        generateIdempotencyKey: () => 'idem-dynamic',
      },
    );

    const result = await tools.create_order?.execute?.(validArgs, {});

    expect(result).toEqual(paypalResult());
    expect(resolveContext).toHaveBeenCalledWith(validArgs);
    expect(store.orders[0]).toMatchObject({
      merchant: 'Amazon',
      category: 'books',
      idempotencyKey: 'idem-dynamic',
    });
  });
});
