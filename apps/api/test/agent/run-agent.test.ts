import { describe, expect, it, vi } from 'vitest';
import type { ShoppingAgentRequest, ShoppingAgentGeneration } from '../../src/agent/run-agent.js';
import { runShoppingAgent } from '../../src/agent/run-agent.js';
import {
  type MandateForGuard,
  type OrderHistoryEntry,
} from '../../src/guard/rules.js';
import type {
  GuardDecisionInput,
  GuardOrderInput,
  GuardStore,
} from '../../src/guard/store.js';
import type { ToolkitTool } from '../../src/guard/tool-wrapper.js';
import { MockStorefrontProvider } from '../../src/storefront/mock-provider.js';

function mandate(overrides: Partial<MandateForGuard> = {}): MandateForGuard {
  return {
    active: true,
    totalBudgetMinorUnits: 100_000,
    perPurchaseCapMinorUnits: 20_000,
    approvalThresholdMinorUnits: 10_000,
    currency: 'USD',
    allowedMerchants: ['soundhouse'],
    allowedCategories: ['electronics'],
    expiresAt: new Date('2030-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

class FakeStore implements GuardStore {
  events: string[] = [];
  decisions: GuardDecisionInput[] = [];
  orders: GuardOrderInput[] = [];
  finalized: Array<{ orderId: string; paypalOrderId: string }> = [];

  constructor(private readonly currentMandate: MandateForGuard | null) {}

  async loadMandate(): Promise<MandateForGuard | null> {
    return this.currentMandate;
  }

  async loadHistory(): Promise<OrderHistoryEntry[]> {
    return [];
  }

  async saveDecision(input: GuardDecisionInput): Promise<{ id: string }> {
    this.decisions.push(input);
    return { id: `decision-${this.decisions.length}` };
  }

  async saveAllowedOrder(input: {
    order: GuardOrderInput;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; decisionId: string }> {
    this.events.push('order');
    this.orders.push(input.order);
    this.decisions.push(input.decision);
    return { orderId: 'local-order-1', decisionId: 'decision-allow' };
  }

  async savePendingApproval(input: {
    order: GuardOrderInput;
    reason: string;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; approvalId: string; decisionId: string }> {
    this.events.push('pending');
    this.orders.push(input.order);
    this.decisions.push(input.decision);
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
    this.finalized.push({ orderId, paypalOrderId: input.paypalOrderId });
  }

  async markOrderFailed(orderId: string): Promise<void> {
    this.events.push(`failed:${orderId}`);
  }
}

function tool(
  execute: NonNullable<ToolkitTool['execute']>,
): ToolkitTool {
  return { description: 'test tool', parameters: {}, execute };
}

function paypalResult(): Record<string, unknown> {
  return {
    id: 'PAYPAL-ORDER-1',
    status: 'CREATED',
    links: [
      {
        rel: 'approve',
        href: 'https://www.sandbox.paypal.com/checkoutnow?token=1',
      },
    ],
  };
}

type ExecuteTool = {
  execute?: (
    args: Record<string, unknown>,
    options: unknown,
  ) => PromiseLike<unknown>;
};

async function executeTool(
  tools: ShoppingAgentRequest['tools'],
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const selected = tools[toolName] as ExecuteTool | undefined;

  if (!selected?.execute) {
    throw new Error(`Missing test tool ${toolName}`);
  }

  return selected.execute(args, {} as never);
}

function orderGeneration(input: {
  tools: ShoppingAgentRequest['tools'];
  query: string;
  itemCost: number;
  title: string;
}): Promise<ShoppingAgentGeneration> {
  return (async () => {
    const search = await executeTool(input.tools, 'search_catalog', {
      query: input.query,
    });
    const args = {
      currencyCode: 'USD',
      items: [
        {
          name: input.title,
          quantity: 1,
          itemCost: input.itemCost,
          taxPercent: 0,
          itemTotal: input.itemCost,
        },
      ],
    };
    const create = await executeTool(input.tools, 'create_order', args);

    expect(create).toBeDefined();
    expect(input.tools.pay_order).toBeUndefined();

    return {
      text: 'Shopping complete.',
      steps: [
        {
          text: '',
          finishReason: 'tool-calls',
          toolCalls: [
            {
              toolName: 'search_catalog',
              toolCallId: 'call-search',
              args: { query: input.query },
            },
          ],
          toolResults: [
            {
              toolName: 'search_catalog',
              toolCallId: 'call-search',
              result: search,
            },
          ],
        },
        {
          text: 'Shopping complete.',
          finishReason: 'stop',
          toolCalls: [
            {
              toolName: 'create_order',
              toolCallId: 'call-create',
              args,
            },
          ],
          toolResults: [
            {
              toolName: 'create_order',
              toolCallId: 'call-create',
              result: create,
            },
          ],
        },
      ],
    };
  })();
}

function toolkitTools(createOrder: NonNullable<ToolkitTool['execute']>): {
  tools: Record<string, ToolkitTool>;
  createOrder: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(createOrder);
  const tools = {
    create_order: tool(spy),
    get_order: tool(async () => ({ id: 'PAYPAL-ORDER-1' })),
    pay_order: tool(async () => ({ id: 'PAYPAL-ORDER-1', status: 'COMPLETED' })),
  };

  return { tools, createOrder: spy };
}

describe('runShoppingAgent', () => {
  it('runs storefront and guarded PayPal tools and logs every step', async () => {
    const store = new FakeStore(mandate());
    const provider = new MockStorefrontProvider();
    const paypal = toolkitTools(async () => {
      store.events.push('paypal');
      return paypalResult();
    });
    const onStep = vi.fn();
    let request: ShoppingAgentRequest | undefined;

    const result = await runShoppingAgent({
      mandateId: 'mandate-1',
      prompt: 'buy wireless headphones under 40 dollars',
      model: { modelId: 'test-model' } as never,
      provider,
      store,
      toolkitTools: paypal.tools,
      onStep,
      generate: async (generationRequest) => {
        request = generationRequest;
        return orderGeneration({
          tools: generationRequest.tools,
          query: 'wireless headphones',
          title: 'Aurora Wireless Headphones',
          itemCost: 39,
        });
      },
    });

    expect(request?.maxSteps).toBe(8);
    expect(request?.system).toContain('Allowed merchants: soundhouse');
    expect(paypal.createOrder).toHaveBeenCalledTimes(1);
    expect(store.orders[0]).toMatchObject({
      mandateId: 'mandate-1',
      merchant: 'soundhouse',
      category: 'electronics',
      amountMinorUnits: 3_900,
    });
    expect(store.finalized).toEqual([
      { orderId: 'local-order-1', paypalOrderId: 'PAYPAL-ORDER-1' },
    ]);
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(result.steps.map((step) => step.stepNumber)).toEqual([1, 2]);
    expect(result.text).toBe('Shopping complete.');
  });

  it('does not call PayPal when the guard blocks the agent order', async () => {
    const store = new FakeStore(
      mandate({ perPurchaseCapMinorUnits: 4_000 }),
    );
    const paypal = toolkitTools(async () => {
      store.events.push('paypal');
      return paypalResult();
    });
    let createResult: unknown;

    await runShoppingAgent({
      mandateId: 'mandate-1',
      prompt: 'buy a speaker',
      model: { modelId: 'test-model' } as never,
      provider: new MockStorefrontProvider(),
      store,
      toolkitTools: paypal.tools,
      generate: async (generationRequest) => {
        createResult = await executeTool(
          generationRequest.tools,
          'create_order',
          {
            currencyCode: 'USD',
            items: [
              {
                name: 'Echo Mini Bluetooth Speaker',
                quantity: 1,
                itemCost: 45,
                taxPercent: 0,
                itemTotal: 45,
              },
            ],
          },
        );

        return {
          text: 'Blocked.',
          steps: [
            {
              text: 'Blocked.',
              finishReason: 'stop',
              toolCalls: [],
              toolResults: [],
            },
          ],
        };
      },
    });

    expect(createResult).toMatchObject({
      blocked: true,
      verdict: 'BLOCK',
      status: 'BLOCKED',
    });
    expect(paypal.createOrder).not.toHaveBeenCalled();
    expect(store.events).not.toContain('paypal');
    expect(store.orders).toHaveLength(0);
    expect(store.decisions[0]?.reasons).toContain(
      'PER_PURCHASE_CAP_EXCEEDED',
    );
  });
});
