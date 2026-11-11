import {
  ApprovalStatus,
  OrderStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type {
  GuardVerdict,
  MandateForGuard,
  OrderHistoryEntry,
  OrderLineItem,
  ReasonCode,
} from './rules.js';

export interface GuardDecisionInput {
  mandateId: string;
  orderId?: string;
  verdict: GuardVerdict;
  reasons: readonly ReasonCode[];
  toolName: string;
  requestPayload: unknown;
}

export interface GuardOrderInput {
  mandateId: string;
  merchant: string;
  category: string;
  amountMinorUnits: number;
  feeMinorUnits: number;
  currency: string;
  items: readonly OrderLineItem[];
  idempotencyKey: string;
}

export interface GuardStore {
  loadMandate(mandateId: string): Promise<MandateForGuard | null>;
  loadHistory(mandateId: string): Promise<OrderHistoryEntry[]>;
  saveDecision(input: GuardDecisionInput): Promise<{ id: string }>;
  saveAllowedOrder(input: {
    order: GuardOrderInput;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; decisionId: string }>;
  savePendingApproval(input: {
    order: GuardOrderInput;
    reason: string;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; approvalId: string; decisionId: string }>;
  finalizeOrder(
    orderId: string,
    input: { paypalOrderId: string; approvalLink?: string },
  ): Promise<void>;
  markOrderFailed(orderId: string): Promise<void>;
}

type GuardPrismaClient = Pick<
  PrismaClient,
  'mandate' | 'order' | 'decision' | 'approval' | '$transaction'
>;

function decisionData(
  input: GuardDecisionInput,
  runId?: string,
): Prisma.DecisionUncheckedCreateInput {
  return {
    mandateId: input.mandateId,
    ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
    ...(runId === undefined ? {} : { runId }),
    verdict: input.verdict,
    reason: input.reasons.length === 0 ? input.verdict : input.reasons.join(','),
    toolName: input.toolName,
    requestPayload: input.requestPayload as Prisma.InputJsonValue,
  };
}

function orderData(input: GuardOrderInput): Prisma.OrderUncheckedCreateInput {
  return {
    mandateId: input.mandateId,
    merchant: input.merchant,
    category: input.category,
    amountMinorUnits: input.amountMinorUnits,
    feeMinorUnits: input.feeMinorUnits,
    currency: input.currency,
    items: input.items as unknown as Prisma.InputJsonValue,
    idempotencyKey: input.idempotencyKey,
    status: OrderStatus.CREATED,
  };
}

export function parseStoredItems(value: Prisma.JsonValue): OrderLineItem[] {
  if (!Array.isArray(value)) {
    throw new Error('Stored order items are not an array');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Stored order item ${index} is not an object`);
    }

    const item = entry as Record<string, unknown>;

    if (
      typeof item.name !== 'string' ||
      typeof item.quantity !== 'number' ||
      !Number.isInteger(item.quantity) ||
      typeof item.unitAmountMinorUnits !== 'number' ||
      !Number.isInteger(item.unitAmountMinorUnits)
    ) {
      throw new Error(`Stored order item ${index} is malformed`);
    }

    return {
      name: item.name,
      quantity: item.quantity,
      unitAmountMinorUnits: item.unitAmountMinorUnits,
    };
  });
}

export class PrismaGuardStore implements GuardStore {
  constructor(
    private readonly prisma: GuardPrismaClient,
    private readonly runId?: string,
  ) {}

  async loadMandate(mandateId: string): Promise<MandateForGuard | null> {
    const mandate = await this.prisma.mandate.findUnique({
      where: { id: mandateId },
    });

    if (!mandate) {
      return null;
    }

    return {
      active: true,
      totalBudgetMinorUnits: mandate.totalBudgetMinorUnits,
      perPurchaseCapMinorUnits: mandate.perPurchaseCapMinorUnits,
      approvalThresholdMinorUnits: mandate.approvalThresholdMinorUnits,
      currency: mandate.currency,
      allowedMerchants: mandate.allowedMerchants,
      allowedCategories: mandate.allowedCategories,
      expiresAt: mandate.expiresAt,
    };
  }

  async loadHistory(mandateId: string): Promise<OrderHistoryEntry[]> {
    const orders = await this.prisma.order.findMany({
      where: {
        mandateId,
        status: {
          in: [OrderStatus.CREATED, OrderStatus.APPROVED, OrderStatus.CAPTURED],
        },
        approvals: {
          none: { status: ApprovalStatus.PENDING },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return orders.map((order) => ({
      merchant: order.merchant,
      category: order.category,
      currency: order.currency,
      amountMinorUnits: order.amountMinorUnits,
      feeMinorUnits: order.feeMinorUnits,
      items: parseStoredItems(order.items),
      createdAt: order.createdAt,
    }));
  }

  async saveDecision(input: GuardDecisionInput): Promise<{ id: string }> {
    return this.prisma.decision.create({
      data: decisionData(input, this.runId),
    });
  }

  async saveAllowedOrder(input: {
    order: GuardOrderInput;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; decisionId: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const order = await transaction.order.create({
        data: orderData(input.order),
      });
      const decision = await transaction.decision.create({
        data: decisionData(
          { ...input.decision, orderId: order.id },
          this.runId,
        ),
      });

      return { orderId: order.id, decisionId: decision.id };
    });
  }

  async savePendingApproval(input: {
    order: GuardOrderInput;
    reason: string;
    decision: GuardDecisionInput;
  }): Promise<{ orderId: string; approvalId: string; decisionId: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const order = await transaction.order.create({
        data: orderData(input.order),
      });
      const approval = await transaction.approval.create({
        data: {
          mandateId: input.order.mandateId,
          orderId: order.id,
          status: ApprovalStatus.PENDING,
          reason: input.reason,
        },
      });
      const decision = await transaction.decision.create({
        data: decisionData(
          { ...input.decision, orderId: order.id },
          this.runId,
        ),
      });

      return {
        orderId: order.id,
        approvalId: approval.id,
        decisionId: decision.id,
      };
    });
  }

  async finalizeOrder(
    orderId: string,
    input: { paypalOrderId: string; approvalLink?: string },
  ): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paypalOrderId: input.paypalOrderId,
        ...(input.approvalLink === undefined
          ? {}
          : { approvalLink: input.approvalLink }),
      },
    });
  }

  async markOrderFailed(orderId: string): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.FAILED },
    });
  }
}
