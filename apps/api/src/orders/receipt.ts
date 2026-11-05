import {
  ApprovalStatus,
  type Decision,
  type PrismaClient,
} from '@prisma/client';
import { GUARD_RULE_CODES, type ReasonCode } from '../guard/rules.js';

function reasonsFromDecision(decision: Decision): ReasonCode[] {
  if (
    decision.reason.length === 0 ||
    decision.reason === decision.verdict
  ) {
    return [];
  }

  return decision.reason
    .split(',')
    .map((reason) => reason.trim())
    .filter((reason): reason is ReasonCode =>
      (GUARD_RULE_CODES as readonly string[]).includes(reason),
    );
}

export async function getOrderReceipt(
  prisma: PrismaClient,
  orderId: string,
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      mandate: true,
      decisions: { orderBy: { createdAt: 'asc' } },
      approvals: { orderBy: { requestedAt: 'asc' } },
    },
  });

  if (!order) {
    return null;
  }

  const { mandate, decisions, approvals, ...orderFields } = order;
  const decisionsWithReasons = decisions.map((decision) => ({
    ...decision,
    reasons: reasonsFromDecision(decision),
  }));
  const latestDecision = decisionsWithReasons.at(-1);
  const failedRules = latestDecision?.reasons ?? [];
  const approvedApproval = approvals.find(
    (approval) => approval.status === ApprovalStatus.APPROVED,
  );

  return {
    order: orderFields,
    mandate,
    paypalOrderId: order.paypalOrderId,
    captureId: order.captureId,
    approvedBy: approvedApproval?.resolvedBy ?? null,
    decisions: decisionsWithReasons,
    approvals: approvals.map((approval) => ({
      ...approval,
      approvedBy: approval.resolvedBy,
    })),
    rules: {
      passed: GUARD_RULE_CODES.filter(
        (rule) => !failedRules.includes(rule),
      ),
      failed: failedRules,
    },
  };
}
