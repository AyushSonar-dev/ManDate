import {
  ApprovalStatus,
  OrderStatus,
  Prisma,
  type Approval,
  type Mandate,
  type Order,
  type PrismaClient,
} from '@prisma/client';
import {
  REASON_CODES,
  evaluateOrder,
  type GuardResult,
  type ProposedOrder,
  type ReasonCode,
} from '../guard/rules.js';
import {
  PrismaGuardStore,
  parseStoredItems,
  type GuardStore,
} from '../guard/store.js';
import type {
  PaypalOrderSnapshot,
  PaypalOrders,
} from '../paypal/orders.js';

type ApprovalWithRelations = Approval & {
  order: Order | null;
  mandate: Mandate;
};

export interface ApprovalServiceOptions {
  prisma: PrismaClient;
  paypalOrders: PaypalOrders;
  now?: () => Date;
  appBaseUrl?: string;
  store?: GuardStore;
}

export interface ApproveInput {
  approvedBy: string;
}

export interface RejectInput {
  rejectedBy: string;
}

export type ApproveOutcome =
  | { kind: 'not_found' }
  | {
      kind: 'conflict';
      message: string;
      approval: Approval;
      order: Order | null;
    }
  | {
      kind: 'blocked';
      result: GuardResult;
      approval: Approval;
      order: Order;
    }
  | {
      kind: 'pending_buyer_approval';
      message: string;
      approval: Approval;
      order: Order;
      paypalOrderId: string;
      approvalLink?: string;
    }
  | {
      kind: 'captured';
      approval: Approval;
      order: Order;
      mandate: Mandate;
      capture: PaypalOrderSnapshot;
    }
  | {
      kind: 'paypal_error';
      message: string;
      approval: Approval;
      order: Order;
    };

export type RejectOutcome =
  | { kind: 'not_found' }
  | {
      kind: 'conflict';
      message: string;
      approval: Approval;
      order: Order | null;
    }
  | { kind: 'rejected'; approval: Approval; order: Order | null };

export interface ApprovalService {
  list(status?: ApprovalStatus): Promise<Approval[]>;
  approve(id: string, input: ApproveInput): Promise<ApproveOutcome>;
  reject(id: string, input: RejectInput): Promise<RejectOutcome>;
}

function toProposedOrder(order: Order): ProposedOrder {
  return {
    merchant: order.merchant,
    category: order.category,
    currency: order.currency,
    amountMinorUnits: order.amountMinorUnits,
    feeMinorUnits: order.feeMinorUnits,
    items: parseStoredItems(order.items as Prisma.JsonValue),
  };
}

function returnUrlFor(appBaseUrl: string, orderId: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/orders/${encodeURIComponent(
    orderId,
  )}/receipt`;
}

function createOrderInput(
  order: Order,
  appBaseUrl: string | undefined,
): Parameters<PaypalOrders['createOrder']>[0] {
  const items = parseStoredItems(order.items as Prisma.JsonValue).map((item) => ({
    name: item.name,
    quantity: item.quantity,
    itemCost: item.unitAmountMinorUnits / 100,
    taxPercent: 0,
    itemTotal: (item.unitAmountMinorUnits * item.quantity) / 100,
  }));

  return {
    currencyCode: order.currency,
    items,
    ...(order.feeMinorUnits > 0
      ? { shippingCost: order.feeMinorUnits / 100 }
      : {}),
    ...(order.feeMinorUnits < 0
      ? { discount: Math.abs(order.feeMinorUnits) / 100 }
      : {}),
    ...(appBaseUrl === undefined
      ? {}
      : {
          returnUrl: returnUrlFor(appBaseUrl, order.id),
          cancelUrl: returnUrlFor(appBaseUrl, order.id),
        }),
  };
}

function isBuyerApprovalPending(snapshot: PaypalOrderSnapshot): boolean {
  return (
    snapshot.status === 'CREATED' ||
    snapshot.status === 'PAYER_ACTION_REQUIRED' ||
    snapshot.status === 'SAVED'
  );
}

function captureFailureNeedsBuyer(message: string | undefined): boolean {
  return /not.*approv|ORDER_NOT_APPROVED|payer/i.test(message ?? '');
}

export function createApprovalService(
  options: ApprovalServiceOptions,
): ApprovalService {
  const { prisma, paypalOrders } = options;
  const now = options.now ?? (() => new Date());
  const store = options.store ?? new PrismaGuardStore(prisma);

  async function loadApproval(
    id: string,
  ): Promise<ApprovalWithRelations | null> {
    return prisma.approval.findUnique({
      where: { id },
      include: {
        order: true,
        mandate: true,
      },
    });
  }

  async function resolveBlocked(
    approval: ApprovalWithRelations,
    order: Order,
    result: GuardResult,
    approvedBy: string,
  ): Promise<ApproveOutcome> {
    const resolvedAt = now();

    await prisma.$transaction(async (transaction) => {
      await transaction.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.DENIED,
          resolvedBy: approvedBy,
          resolvedAt,
        },
      });
      await transaction.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.FAILED },
      });
    });

    const updatedApproval = await prisma.approval.findUniqueOrThrow({
      where: { id: approval.id },
    });

    return {
      kind: 'blocked',
      result,
      approval: updatedApproval,
      order: { ...order, status: OrderStatus.FAILED },
    };
  }

  async function saveRerunDecision(input: {
    approval: ApprovalWithRelations;
    order: Order;
    result: GuardResult;
    approvedBy: string;
    proposal: ProposedOrder;
  }): Promise<void> {
    await store.saveDecision({
      mandateId: input.approval.mandateId,
      orderId: input.order.id,
      verdict: input.result.verdict,
      reasons: input.result.reasons,
      toolName: 'approval_rerun',
      requestPayload: {
        approvalId: input.approval.id,
        approvedBy: input.approvedBy,
        proposedOrder: input.proposal,
      },
    });
  }

  async function finalizeCapture(input: {
    approval: ApprovalWithRelations;
    order: Order;
    approvedBy: string;
    snapshot: PaypalOrderSnapshot;
  }): Promise<ApproveOutcome> {
    const resolvedAt = now();
    const captureId = input.snapshot.captureId;

    await prisma.$transaction(async (transaction) => {
      const claimed = await transaction.order.updateMany({
        where: {
          id: input.order.id,
          status: OrderStatus.APPROVED,
        },
        data: {
          status: OrderStatus.CAPTURED,
          ...(captureId === undefined ? {} : { captureId }),
        },
      });

      if (claimed.count !== 1) {
        return;
      }

      await transaction.mandate.update({
        where: { id: input.order.mandateId },
        data: {
          spentMinorUnits: { increment: input.order.amountMinorUnits },
        },
      });
      await transaction.approval.update({
        where: { id: input.approval.id },
        data: {
          status: ApprovalStatus.APPROVED,
          resolvedBy: input.approvedBy,
          resolvedAt,
        },
      });
    });

    const [updatedApproval, updatedOrder, updatedMandate] = await Promise.all([
      prisma.approval.findUniqueOrThrow({ where: { id: input.approval.id } }),
      prisma.order.findUniqueOrThrow({ where: { id: input.order.id } }),
      prisma.mandate.findUniqueOrThrow({ where: { id: input.order.mandateId } }),
    ]);

    return {
      kind: 'captured',
      approval: updatedApproval,
      order: updatedOrder,
      mandate: updatedMandate,
      capture: input.snapshot,
    };
  }

  async function captureApprovedOrder(input: {
    approval: ApprovalWithRelations;
    order: Order;
    approvedBy: string;
    paypalOrderId: string;
  }): Promise<ApproveOutcome> {
    const capture = await paypalOrders.captureOrder(input.paypalOrderId);

    if (capture.captured) {
      return finalizeCapture({
        approval: input.approval,
        order: input.order,
        approvedBy: input.approvedBy,
        snapshot: capture,
      });
    }

    if (captureFailureNeedsBuyer(capture.errorMessage)) {
      return {
        kind: 'pending_buyer_approval',
        message:
          capture.errorMessage ??
          'The buyer must approve the order in the PayPal sandbox before capture.',
        approval: input.approval,
        order: input.order,
        paypalOrderId: input.paypalOrderId,
        ...(input.order.approvalLink === null
          ? {}
          : { approvalLink: input.order.approvalLink }),
      };
    }

    return {
      kind: 'paypal_error',
      message: capture.errorMessage ?? 'PayPal did not complete the capture',
      approval: input.approval,
      order: input.order,
    };
  }

  return {
    async list(status) {
      return prisma.approval.findMany({
        where: status === undefined ? {} : { status },
        orderBy: { requestedAt: 'desc' },
      });
    },

    async approve(id, input) {
      const approval = await loadApproval(id);

      if (!approval) {
        return { kind: 'not_found' };
      }

      if (approval.status !== ApprovalStatus.PENDING || !approval.order) {
        return {
          kind: 'conflict',
          message: `Approval is ${approval.status}`,
          approval,
          order: approval.order,
        };
      }

      const order = approval.order;
      const mandate = await store.loadMandate(approval.mandateId);
      const history = mandate
        ? await store.loadHistory(approval.mandateId)
        : [];

      let proposal: ProposedOrder;

      try {
        proposal = toProposedOrder(order);
      } catch {
        const result: GuardResult = {
          verdict: 'BLOCK',
          reasons: [REASON_CODES.INVALID_ORDER_INPUT],
        };

        try {
          await saveRerunDecision({
            approval,
            order,
            result,
            approvedBy: input.approvedBy,
            proposal: {
              merchant: order.merchant,
              category: order.category,
              currency: order.currency,
              amountMinorUnits: order.amountMinorUnits,
              feeMinorUnits: order.feeMinorUnits,
              items: [],
            },
          });
        } catch {
          return {
            kind: 'paypal_error',
            message: 'Guard decision could not be recorded',
            approval,
            order,
          };
        }

        return resolveBlocked(approval, order, result, input.approvedBy);
      }

      const result: GuardResult = mandate
        ? evaluateOrder({
            mandate,
            order: proposal,
            history,
            now: now(),
          })
        : {
            verdict: 'BLOCK',
            reasons: [REASON_CODES.MANDATE_NOT_FOUND],
          };

      try {
        await saveRerunDecision({
          approval,
          order,
          result,
          approvedBy: input.approvedBy,
          proposal,
        });
      } catch {
        return {
          kind: 'paypal_error',
          message: 'Guard decision could not be recorded',
          approval,
          order,
        };
      }

      if (result.verdict === 'BLOCK') {
        return resolveBlocked(approval, order, result, input.approvedBy);
      }

      let paypalOrderId = order.paypalOrderId;

      if (paypalOrderId === null) {
        let created: PaypalOrderSnapshot;

        try {
          created = await paypalOrders.createOrder(
            createOrderInput(order, options.appBaseUrl),
          );
        } catch {
          return {
            kind: 'paypal_error',
            message: 'PayPal order could not be created',
            approval,
            order,
          };
        }

        paypalOrderId = created.paypalOrderId;

        await prisma.order.update({
          where: { id: order.id },
          data: {
            paypalOrderId,
            status: OrderStatus.APPROVED,
            ...(created.approvalLink === undefined
              ? {}
              : { approvalLink: created.approvalLink }),
          },
        });
      }

      const savedOrder = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      let snapshot: PaypalOrderSnapshot;

      try {
        snapshot = await paypalOrders.getOrder(paypalOrderId);
      } catch {
        return {
          kind: 'paypal_error',
          message: 'PayPal order status could not be loaded',
          approval,
          order: savedOrder,
        };
      }

      if (
        snapshot.captureStatus === 'COMPLETED' ||
        snapshot.status === 'COMPLETED'
      ) {
        return finalizeCapture({
          approval,
          order: savedOrder,
          approvedBy: input.approvedBy,
          snapshot,
        });
      }

      if (isBuyerApprovalPending(snapshot)) {
        return {
          kind: 'pending_buyer_approval',
          message:
            'Approve the order in the PayPal sandbox, then approve it again here to capture.',
          approval,
          order: savedOrder,
          paypalOrderId,
          ...(savedOrder.approvalLink === null
            ? {}
            : { approvalLink: savedOrder.approvalLink }),
        };
      }

      if (snapshot.status !== 'APPROVED') {
        return {
          kind: 'paypal_error',
          message: `PayPal order is ${snapshot.status}`,
          approval,
          order: savedOrder,
        };
      }

      return captureApprovedOrder({
        approval,
        order: savedOrder,
        approvedBy: input.approvedBy,
        paypalOrderId,
      });
    },

    async reject(id, input) {
      const approval = await loadApproval(id);

      if (!approval) {
        return { kind: 'not_found' };
      }

      if (approval.status !== ApprovalStatus.PENDING) {
        return {
          kind: 'conflict',
          message: `Approval is ${approval.status}`,
          approval,
          order: approval.order,
        };
      }

      const resolvedAt = now();

      const updated = await prisma.$transaction(async (transaction) => {
        const resolvedApproval = await transaction.approval.update({
          where: { id: approval.id },
          data: {
            status: ApprovalStatus.DENIED,
            resolvedBy: input.rejectedBy,
            resolvedAt,
          },
        });
        const resolvedOrder =
          approval.order === null
            ? null
            : await transaction.order.update({
                where: { id: approval.order.id },
                data: { status: OrderStatus.FAILED },
              });

        return { approval: resolvedApproval, order: resolvedOrder };
      });

      return { kind: 'rejected', ...updated };
    },
  };
}
