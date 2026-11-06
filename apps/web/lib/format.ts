import type { Decision, GuardVerdict, ProposedOrder } from './types';

export function formatMoney(
  minorUnits: number,
  currency: string,
): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(minorUnits / 100);
  } catch {
    return `${currency} ${(minorUnits / 100).toFixed(2)}`;
  }
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function reasonLabel(reason: string): string {
  return reason
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function verdictClasses(verdict: GuardVerdict): string {
  switch (verdict) {
    case 'ALLOW':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'BLOCK':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    case 'REQUIRE_APPROVAL':
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
}

export function proposedOrderFromDecision(
  decision: Decision,
): ProposedOrder | null {
  if (
    typeof decision.requestPayload !== 'object' ||
    decision.requestPayload === null ||
    Array.isArray(decision.requestPayload)
  ) {
    return null;
  }

  const proposed = (decision.requestPayload as Record<string, unknown>)
    .proposedOrder;

  if (typeof proposed !== 'object' || proposed === null || Array.isArray(proposed)) {
    return null;
  }

  const order = proposed as Record<string, unknown>;

  if (
    typeof order.merchant !== 'string' ||
    typeof order.category !== 'string' ||
    typeof order.currency !== 'string' ||
    typeof order.amountMinorUnits !== 'number'
  ) {
    return null;
  }

  return {
    merchant: order.merchant,
    category: order.category,
    currency: order.currency,
    amountMinorUnits: order.amountMinorUnits,
    feeMinorUnits:
      typeof order.feeMinorUnits === 'number' ? order.feeMinorUnits : 0,
    items: Array.isArray(order.items)
      ? (order.items as ProposedOrder['items'])
      : [],
  };
}

export function reasonsForDecision(decision: Decision): string[] {
  if (decision.reasons.length > 0) {
    return decision.reasons;
  }

  if (
    decision.reason.length === 0 ||
    decision.reason === decision.verdict
  ) {
    return [];
  }

  return decision.reason
    .split(',')
    .map((reason) => reason.trim())
    .filter(Boolean);
}

export function toMinorUnits(value: string): number {
  const normalized = value.trim();

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error('Enter a dollar amount with at most two decimals');
  }

  const [whole = '0', fraction = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}
