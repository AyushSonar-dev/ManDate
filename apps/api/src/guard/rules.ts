export const GUARD_VERDICTS = ['ALLOW', 'REQUIRE_APPROVAL', 'BLOCK'] as const;

export type GuardVerdict = (typeof GUARD_VERDICTS)[number];

export const REASON_CODES = {
  MANDATE_NOT_FOUND: 'MANDATE_NOT_FOUND',
  MANDATE_INACTIVE: 'MANDATE_INACTIVE',
  MANDATE_EXPIRED: 'MANDATE_EXPIRED',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  MERCHANT_NOT_ALLOWED: 'MERCHANT_NOT_ALLOWED',
  CATEGORY_NOT_ALLOWED: 'CATEGORY_NOT_ALLOWED',
  PER_PURCHASE_CAP_EXCEEDED: 'PER_PURCHASE_CAP_EXCEEDED',
  TOTAL_BUDGET_EXCEEDED: 'TOTAL_BUDGET_EXCEEDED',
  QUANTITY_LIMIT_EXCEEDED: 'QUANTITY_LIMIT_EXCEEDED',
  CART_TOTAL_MISMATCH: 'CART_TOTAL_MISMATCH',
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  VELOCITY_SMALL_ORDERS: 'VELOCITY_SMALL_ORDERS',
  INVALID_ORDER_INPUT: 'INVALID_ORDER_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PAYPAL_CALL_FAILED: 'PAYPAL_CALL_FAILED',
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export interface GuardResult {
  verdict: GuardVerdict;
  reasons: ReasonCode[];
}

export interface MandateForGuard {
  active: boolean;
  totalBudgetMinorUnits: number;
  perPurchaseCapMinorUnits: number;
  approvalThresholdMinorUnits: number;
  currency: string;
  allowedMerchants: readonly string[];
  allowedCategories: readonly string[];
  expiresAt: Date;
}

export interface OrderLineItem {
  name: string;
  quantity: number;
  unitAmountMinorUnits: number;
}

export interface ProposedOrder {
  merchant: string;
  category: string;
  currency: string;
  amountMinorUnits: number;
  feeMinorUnits?: number;
  items: readonly OrderLineItem[];
}

export interface OrderHistoryEntry extends ProposedOrder {
  createdAt: Date;
}

export interface RulesPolicy {
  duplicateWindowMs: number;
  velocityWindowMs: number;
  velocityMaxSmallOrdersPerMerchant: number;
  smallOrderThresholdMinorUnits: number;
  maxQuantityPerLineItem: number;
  maxTotalQuantity: number;
}

export const DEFAULT_RULES_POLICY: RulesPolicy = {
  duplicateWindowMs: 10 * 60 * 1_000,
  velocityWindowMs: 60 * 60 * 1_000,
  velocityMaxSmallOrdersPerMerchant: 3,
  smallOrderThresholdMinorUnits: 10_000,
  maxQuantityPerLineItem: 10,
  maxTotalQuantity: 25,
};

const REASON_VERDICTS: Record<ReasonCode, Exclude<GuardVerdict, 'ALLOW'>> = {
  [REASON_CODES.MANDATE_NOT_FOUND]: 'BLOCK',
  [REASON_CODES.MANDATE_INACTIVE]: 'BLOCK',
  [REASON_CODES.MANDATE_EXPIRED]: 'BLOCK',
  [REASON_CODES.CURRENCY_MISMATCH]: 'BLOCK',
  [REASON_CODES.MERCHANT_NOT_ALLOWED]: 'BLOCK',
  [REASON_CODES.CATEGORY_NOT_ALLOWED]: 'BLOCK',
  [REASON_CODES.PER_PURCHASE_CAP_EXCEEDED]: 'BLOCK',
  [REASON_CODES.TOTAL_BUDGET_EXCEEDED]: 'BLOCK',
  [REASON_CODES.QUANTITY_LIMIT_EXCEEDED]: 'BLOCK',
  [REASON_CODES.CART_TOTAL_MISMATCH]: 'BLOCK',
  [REASON_CODES.DUPLICATE_ORDER]: 'BLOCK',
  [REASON_CODES.VELOCITY_SMALL_ORDERS]: 'REQUIRE_APPROVAL',
  [REASON_CODES.INVALID_ORDER_INPUT]: 'BLOCK',
  [REASON_CODES.INTERNAL_ERROR]: 'BLOCK',
  [REASON_CODES.PAYPAL_CALL_FAILED]: 'BLOCK',
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function listIncludes(values: readonly string[], target: string): boolean {
  const normalizedTarget = normalize(target);
  return values.some((value) => normalize(value) === normalizedTarget);
}

function isWithinWindow(entryTime: Date, now: Date, windowMs: number): boolean {
  const ageMs = now.getTime() - entryTime.getTime();
  return ageMs >= 0 && ageMs <= windowMs;
}

export function evaluateOrder(input: {
  mandate: MandateForGuard;
  order: ProposedOrder;
  history: readonly OrderHistoryEntry[];
  now: Date;
  policy?: Partial<RulesPolicy>;
}): GuardResult {
  const { mandate, order, history, now } = input;
  const policy: RulesPolicy = {
    ...DEFAULT_RULES_POLICY,
    ...input.policy,
  };
  const reasons: ReasonCode[] = [];

  const addReason = (reason: ReasonCode): void => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  if (!mandate.active) {
    addReason(REASON_CODES.MANDATE_INACTIVE);
  }

  if (mandate.expiresAt.getTime() <= now.getTime()) {
    addReason(REASON_CODES.MANDATE_EXPIRED);
  }

  if (normalize(mandate.currency) !== normalize(order.currency)) {
    addReason(REASON_CODES.CURRENCY_MISMATCH);
  }

  if (!listIncludes(mandate.allowedMerchants, order.merchant)) {
    addReason(REASON_CODES.MERCHANT_NOT_ALLOWED);
  }

  if (!listIncludes(mandate.allowedCategories, order.category)) {
    addReason(REASON_CODES.CATEGORY_NOT_ALLOWED);
  }

  if (order.amountMinorUnits > mandate.perPurchaseCapMinorUnits) {
    addReason(REASON_CODES.PER_PURCHASE_CAP_EXCEEDED);
  }

  const spentMinorUnits = history.reduce(
    (total, entry) => total + entry.amountMinorUnits,
    0,
  );

  if (spentMinorUnits + order.amountMinorUnits > mandate.totalBudgetMinorUnits) {
    addReason(REASON_CODES.TOTAL_BUDGET_EXCEEDED);
  }

  const hasInvalidQuantity = order.items.some(
    (item) =>
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > policy.maxQuantityPerLineItem,
  );
  const totalQuantity = order.items.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  if (hasInvalidQuantity || totalQuantity > policy.maxTotalQuantity) {
    addReason(REASON_CODES.QUANTITY_LIMIT_EXCEEDED);
  }

  const lineItemTotalMinorUnits = order.items.reduce(
    (total, item) => total + item.quantity * item.unitAmountMinorUnits,
    0,
  );
  const feeMinorUnits = order.feeMinorUnits ?? 0;

  if (lineItemTotalMinorUnits + feeMinorUnits !== order.amountMinorUnits) {
    addReason(REASON_CODES.CART_TOTAL_MISMATCH);
  }

  const hasDuplicate = history.some(
    (entry) =>
      isWithinWindow(entry.createdAt, now, policy.duplicateWindowMs) &&
      normalize(entry.merchant) === normalize(order.merchant) &&
      normalize(entry.currency) === normalize(order.currency) &&
      entry.amountMinorUnits === order.amountMinorUnits,
  );

  if (hasDuplicate) {
    addReason(REASON_CODES.DUPLICATE_ORDER);
  }

  if (order.amountMinorUnits <= policy.smallOrderThresholdMinorUnits) {
    const priorSmallOrders = history.filter(
      (entry) =>
        isWithinWindow(entry.createdAt, now, policy.velocityWindowMs) &&
        normalize(entry.merchant) === normalize(order.merchant) &&
        entry.amountMinorUnits <= policy.smallOrderThresholdMinorUnits,
    ).length;

    if (priorSmallOrders >= policy.velocityMaxSmallOrdersPerMerchant) {
      addReason(REASON_CODES.VELOCITY_SMALL_ORDERS);
    }
  }

  const verdict: GuardVerdict = reasons.some(
    (reason) => REASON_VERDICTS[reason] === 'BLOCK',
  )
    ? 'BLOCK'
    : reasons.some((reason) => REASON_VERDICTS[reason] === 'REQUIRE_APPROVAL')
      ? 'REQUIRE_APPROVAL'
      : 'ALLOW';

  return { verdict, reasons };
}
