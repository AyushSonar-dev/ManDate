import type { OrderLineItem, ProposedOrder } from './rules.js';

export interface OrderContext {
  merchant: string;
  category: string;
}

export class InvalidOrderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrderInputError';
  }
}

function toMinorUnits(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidOrderInputError(`${field} must be a finite non-negative number`);
  }

  const scaled = value * 100;
  const rounded = Math.round(scaled);

  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new InvalidOrderInputError(`${field} must have at most 2 decimal places`);
  }

  return rounded;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidOrderInputError(`${field} must be a non-empty string`);
  }

  return value.trim();
}

function readItems(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidOrderInputError('items must be a non-empty array');
  }

  if (value.length > 50) {
    throw new InvalidOrderInputError('items must not contain more than 50 entries');
  }

  return value;
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidOrderInputError(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

export function mapCreateOrderArgsToProposedOrder(
  args: Record<string, unknown>,
  context: OrderContext,
): ProposedOrder {
  const merchant = readString(context.merchant, 'merchant');
  const category = readString(context.category, 'category');
  const currency = readString(args.currencyCode, 'currencyCode').toUpperCase();
  const items: OrderLineItem[] = [];
  let subtotalMinorUnits = 0;
  let taxMinorUnits = 0;

  for (const [index, rawItem] of readItems(args.items).entries()) {
    const item = readRecord(rawItem, `items[${index}]`);
    const name = readString(item.name, `items[${index}].name`);
    const quantity = item.quantity === undefined ? 1 : item.quantity;

    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      throw new InvalidOrderInputError(`items[${index}].quantity must be a positive integer`);
    }

    const unitAmountMinorUnits = toMinorUnits(item.itemCost, `items[${index}].itemCost`);
    const taxPercent = item.taxPercent === undefined ? 0 : item.taxPercent;

    if (typeof taxPercent !== 'number' || !Number.isFinite(taxPercent) || taxPercent < 0) {
      throw new InvalidOrderInputError(`items[${index}].taxPercent must be a non-negative number`);
    }

    const lineSubtotalMinorUnits = unitAmountMinorUnits * quantity;
    subtotalMinorUnits += lineSubtotalMinorUnits;
    taxMinorUnits += Math.round((lineSubtotalMinorUnits * taxPercent) / 100);
    items.push({ name, quantity, unitAmountMinorUnits });
  }

  const shippingMinorUnits =
    args.shippingCost === undefined ? 0 : toMinorUnits(args.shippingCost, 'shippingCost');
  const discountMinorUnits =
    args.discount === undefined ? 0 : toMinorUnits(args.discount, 'discount');
  const feeMinorUnits = taxMinorUnits + shippingMinorUnits - discountMinorUnits;
  const amountMinorUnits = subtotalMinorUnits + feeMinorUnits;

  if (amountMinorUnits <= 0) {
    throw new InvalidOrderInputError('order total must be greater than zero');
  }

  return {
    merchant,
    category,
    currency,
    amountMinorUnits,
    feeMinorUnits,
    items,
  };
}
