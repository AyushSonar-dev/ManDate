import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';

export interface PaypalOrderItemInput {
  name: string;
  quantity: number;
  itemCost: number;
  taxPercent: number;
  itemTotal: number;
}

export interface CreatePaypalOrderInput {
  currencyCode: string;
  items: PaypalOrderItemInput[];
  shippingCost?: number;
  discount?: number;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface PaypalOrderSnapshot {
  paypalOrderId: string;
  status: string;
  approvalLink?: string;
  captureId?: string;
  captureStatus?: string;
  captured: boolean;
  errorMessage?: string;
  raw: unknown;
}

export interface PaypalOrders {
  createOrder(input: CreatePaypalOrderInput): Promise<PaypalOrderSnapshot>;
  getOrder(paypalOrderId: string): Promise<PaypalOrderSnapshot>;
  captureOrder(paypalOrderId: string): Promise<PaypalOrderSnapshot>;
}

interface ToolLike {
  execute?: (
    args: Record<string, unknown>,
    options: unknown,
  ) => PromiseLike<unknown> | unknown;
}

export interface ToolkitPaypalOrdersOptions {
  clientId: string;
  clientSecret: string;
  appBaseUrl?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return asRecord(parsed);
    } catch {
      return null;
    }
  }

  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readArray(
  record: Record<string, unknown> | null,
  ...keys: string[]
): unknown[] {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function approvalLinkFrom(order: Record<string, unknown> | null): string | undefined {
  const link = readArray(order, 'links')
    .map((entry) => asRecord(entry))
    .find((entry) => {
      const rel = readString(entry, 'rel');
      return rel === 'approve' || rel === 'payer-action';
    });

  return readString(link ?? null, 'href');
}

function capturesFrom(order: Record<string, unknown> | null): Record<string, unknown>[] {
  return readArray(order, 'purchase_units', 'purchaseUnits').flatMap((unit) => {
    const payments = asRecord(asRecord(unit)?.['payments'] ?? null);
    return readArray(payments, 'captures')
      .map((capture) => asRecord(capture))
      .filter((capture): capture is Record<string, unknown> => capture !== null);
  });
}

function snapshotFrom(
  result: unknown,
  fallbackOrderId: string,
  captured: boolean,
): PaypalOrderSnapshot {
  const outer = asRecord(result);
  const response = asRecord(outer?.['response'] ?? null) ?? outer;
  const captures = capturesFrom(response);
  const completedCapture = captures.find(
    (capture) => readString(capture, 'status') === 'COMPLETED',
  );
  const firstCapture = completedCapture ?? captures[0];
  const paypalOrderId =
    readString(response, 'id') ??
    readString(outer, 'id') ??
    fallbackOrderId;
  const firstDetail = asRecord(
    readArray(asRecord(response), 'details')[0] ?? null,
  );
  const errorMessage =
    readString(firstDetail, 'description') ??
    readString(firstDetail, 'issue') ??
    readString(response, 'message') ??
    (readString(outer, 'status') === 'error'
      ? JSON.stringify(response ?? outer)
      : undefined);
  const approvalLink = approvalLinkFrom(response);
  const captureId = readString(firstCapture ?? null, 'id');
  const captureStatus = readString(firstCapture ?? null, 'status');

  return {
    paypalOrderId,
    status: readString(response, 'status') ?? 'UNKNOWN',
    ...(approvalLink === undefined ? {} : { approvalLink }),
    ...(captureId === undefined ? {} : { captureId }),
    ...(captureStatus === undefined ? {} : { captureStatus }),
    captured:
      captured &&
      readString(outer, 'status') !== 'error' &&
      captureStatus === 'COMPLETED',
    ...(errorMessage === undefined ? {} : { errorMessage }),
    raw: result,
  };
}

function executeTool(
  tools: Record<string, ToolLike>,
  name: string,
): NonNullable<ToolLike['execute']> {
  const execute = tools[name]?.execute;

  if (!execute) {
    throw new Error(`PayPal toolkit did not expose the ${name} tool`);
  }

  return execute;
}

export function createToolkitPaypalOrders(
  options: ToolkitPaypalOrdersOptions,
): PaypalOrders {
  const toolkit = new PayPalAgentToolkit({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    configuration: {
      actions: {
        orders: {
          create: true,
          get: true,
          capture: true,
        },
      },
      context: {
        sandbox: true,
      },
    },
  });
  const tools = toolkit.getTools() as unknown as Record<string, ToolLike>;
  const createOrderTool = executeTool(tools, 'create_order');
  const getOrderTool = executeTool(tools, 'get_order');
  const captureOrderTool = executeTool(tools, 'pay_order');
  const baseUrl = options.appBaseUrl?.replace(/\/+$/, '');

  return {
    async createOrder(input) {
      const result = await createOrderTool(
        {
          currencyCode: input.currencyCode,
          items: input.items,
          ...(input.shippingCost === undefined
            ? {}
            : { shippingCost: input.shippingCost }),
          ...(input.discount === undefined ? {} : { discount: input.discount }),
          ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
          ...(input.cancelUrl === undefined ? {} : { cancelUrl: input.cancelUrl }),
        },
        {},
      );
      const snapshot = snapshotFrom(result, '', false);

      if (snapshot.paypalOrderId.length === 0) {
        throw new Error('PayPal create_order did not return an order id');
      }

      return snapshot;
    },

    async getOrder(paypalOrderId) {
      const result = await getOrderTool({ id: paypalOrderId }, {});
      return snapshotFrom(result, paypalOrderId, false);
    },

    async captureOrder(paypalOrderId) {
      const result = await captureOrderTool({ id: paypalOrderId }, {});
      return snapshotFrom(result, paypalOrderId, true);
    },
  };
}

export function paypalReturnUrl(
  appBaseUrl: string,
  localOrderId: string,
): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/orders/${encodeURIComponent(
    localOrderId,
  )}/receipt`;
}
