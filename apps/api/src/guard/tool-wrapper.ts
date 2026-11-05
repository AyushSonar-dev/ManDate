import { randomUUID } from 'node:crypto';
import {
  REASON_CODES,
  evaluateOrder,
  type GuardResult,
  type GuardVerdict,
  type MandateForGuard,
  type OrderHistoryEntry,
  type ProposedOrder,
  type ReasonCode,
  type RulesPolicy,
} from './rules.js';
import type {
  IntentCheckDecision,
  IntentChecker,
  IntentMatch,
} from './intent.js';
import {
  InvalidOrderInputError,
  mapCreateOrderArgsToProposedOrder,
  type OrderContext,
} from './order-mapping.js';
import type {
  GuardDecisionInput,
  GuardOrderInput,
  GuardStore,
} from './store.js';

export interface ToolkitTool {
  description?: string;
  parameters: unknown;
  execute?: (
    args: Record<string, unknown>,
    options: unknown,
  ) => PromiseLike<unknown> | unknown;
}

export interface GuardToolContext extends OrderContext {
  mandateId: string;
}

export type GuardContextResolver = (
  args: Record<string, unknown>,
) => PromiseLike<GuardToolContext> | GuardToolContext;

export interface GuardedToolkitOptions {
  context: GuardToolContext | GuardContextResolver;
  store: GuardStore;
  intentChecker?: IntentChecker;
  userRequest?: string;
  now?: () => Date;
  policy?: Partial<RulesPolicy>;
  generateIdempotencyKey?: () => string;
}

interface IntentAudit {
  match: IntentMatch | 'error';
  reasons: string[];
}

export interface GuardRefusal {
  blocked: true;
  status: 'BLOCKED';
  verdict: 'BLOCK';
  reasons: ReasonCode[];
  message: string;
  decisionId?: string;
}

export interface GuardPendingApproval {
  pending: true;
  status: 'PENDING_APPROVAL';
  verdict: 'REQUIRE_APPROVAL';
  reasons: ReasonCode[];
  message: string;
  approvalId: string;
  orderId: string;
  decisionId: string;
}

const GUARDED_TOOL = 'create_order';

function refusal(
  reasons: readonly ReasonCode[],
  message: string,
  decisionId?: string,
): GuardRefusal {
  return {
    blocked: true,
    status: 'BLOCKED',
    verdict: 'BLOCK',
    reasons: [...reasons],
    message,
    ...(decisionId === undefined ? {} : { decisionId }),
  };
}

function messageFor(verdict: GuardVerdict, reasons: readonly ReasonCode[]): string {
  if (reasons.length === 0) {
    return `Order ${verdict.toLowerCase()}`;
  }

  return `Order ${verdict.toLowerCase()}: ${reasons.join(', ')}`;
}

function decisionInput(input: {
  mandateId: string;
  verdict: GuardVerdict;
  reasons: readonly ReasonCode[];
  proposal: ProposedOrder;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  intent?: IntentAudit;
}): GuardDecisionInput {
  return {
    mandateId: input.mandateId,
    verdict: input.verdict,
    reasons: input.reasons,
    toolName: GUARDED_TOOL,
    requestPayload: {
      arguments: input.args,
      proposedOrder: input.proposal,
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
      ...(input.intent === undefined ? {} : { intent: input.intent }),
    },
  };
}

function orderInput(input: {
  mandateId: string;
  proposal: ProposedOrder;
  idempotencyKey: string;
}): GuardOrderInput {
  return {
    mandateId: input.mandateId,
    merchant: input.proposal.merchant,
    category: input.proposal.category,
    amountMinorUnits: input.proposal.amountMinorUnits,
    feeMinorUnits: input.proposal.feeMinorUnits ?? 0,
    currency: input.proposal.currency,
    items: input.proposal.items,
    idempotencyKey: input.idempotencyKey,
  };
}

function parseToolResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function paypalOrderDetails(result: unknown): {
  paypalOrderId: string;
  approvalLink?: string;
} {
  const parsed = parseToolResult(result);
  const id = parsed?.id;

  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('PayPal create_order result did not contain an order id');
  }

  const links = Array.isArray(parsed?.links) ? parsed.links : [];
  const approvalLink = links.find((link) => {
    if (typeof link !== 'object' || link === null || Array.isArray(link)) {
      return false;
    }

    const rel = (link as Record<string, unknown>).rel;
    return rel === 'approve' || rel === 'payer-action';
  }) as Record<string, unknown> | undefined;

  const href = approvalLink?.href;

  return {
    paypalOrderId: id,
    ...(typeof href === 'string' && href.length > 0 ? { approvalLink: href } : {}),
  };
}

async function saveFailureDecision(
  store: GuardStore,
  input: GuardDecisionInput,
): Promise<string | undefined> {
  try {
    const decision = await store.saveDecision(input);
    return decision.id;
  } catch {
    return undefined;
  }
}

async function guardCreateOrder(
  toolName: string,
  tool: ToolkitTool,
  args: Record<string, unknown>,
  options: unknown,
  guardedOptions: GuardedToolkitOptions,
): Promise<unknown> {
  const { store } = guardedOptions;
  const now = guardedOptions.now ?? (() => new Date());
  const generateIdempotencyKey =
    guardedOptions.generateIdempotencyKey ?? (() => randomUUID());

  let context: GuardToolContext;

  try {
    context =
      typeof guardedOptions.context === 'function'
        ? await guardedOptions.context(args)
        : guardedOptions.context;
  } catch {
    return refusal(
      [REASON_CODES.INVALID_ORDER_INPUT],
      'Blocked: order context could not be resolved',
    );
  }

  let proposal: ProposedOrder;

  try {
    proposal = mapCreateOrderArgsToProposedOrder(args, context);
  } catch (error) {
    const reason = REASON_CODES.INVALID_ORDER_INPUT;
    const message =
      error instanceof InvalidOrderInputError
        ? error.message
        : 'Order arguments could not be mapped safely';
    const decisionId = await saveFailureDecision(
      store,
      {
        mandateId: context.mandateId,
        verdict: 'BLOCK',
        reasons: [reason],
        toolName,
        requestPayload: { arguments: args, error: message },
      },
    );

    return refusal([reason], `Blocked: ${message}`, decisionId);
  }

  let mandate: MandateForGuard | null;
  let history: OrderHistoryEntry[];

  try {
    [mandate, history] = await Promise.all([
      store.loadMandate(context.mandateId),
      store.loadHistory(context.mandateId),
    ]);
  } catch {
    const reason = REASON_CODES.INTERNAL_ERROR;
    const decisionId = await saveFailureDecision(store, {
      mandateId: context.mandateId,
      verdict: 'BLOCK',
      reasons: [reason],
      toolName,
      requestPayload: { arguments: args, proposedOrder: proposal },
    });

    return refusal([reason], 'Blocked: guard state could not be loaded', decisionId);
  }

  if (!mandate) {
    const reason = REASON_CODES.MANDATE_NOT_FOUND;
    const decisionId = await saveFailureDecision(
      store,
      decisionInput({
        mandateId: context.mandateId,
        verdict: 'BLOCK',
        reasons: [reason],
        proposal,
        args,
      }),
    );

    return refusal([reason], 'Blocked: mandate not found', decisionId);
  }

  let guardResult: GuardResult;

  try {
    guardResult = evaluateOrder({
      mandate,
      order: proposal,
      history,
      now: now(),
      ...(guardedOptions.policy === undefined
        ? {}
        : { policy: guardedOptions.policy }),
    });
  } catch {
    const reason = REASON_CODES.INTERNAL_ERROR;
    const decisionId = await saveFailureDecision(store, {
      mandateId: context.mandateId,
      verdict: 'BLOCK',
      reasons: [reason],
      toolName,
      requestPayload: { arguments: args, proposedOrder: proposal },
    });

    return refusal([reason], 'Blocked: guard evaluation failed', decisionId);
  }

  if (guardResult.verdict === 'BLOCK') {
    let decisionId: string | undefined;

    try {
      const decision = await store.saveDecision(
        decisionInput({
          mandateId: context.mandateId,
          verdict: 'BLOCK',
          reasons: guardResult.reasons,
          proposal,
          args,
        }),
      );
      decisionId = decision.id;
    } catch {
      return refusal(
        [REASON_CODES.INTERNAL_ERROR],
        'Blocked: decision could not be saved',
      );
    }

    return refusal(
      guardResult.reasons,
      messageFor('BLOCK', guardResult.reasons),
      decisionId,
    );
  }

  let intentAudit: IntentAudit | undefined;

  if (
    guardResult.verdict === 'ALLOW' &&
    guardedOptions.intentChecker !== undefined
  ) {
    let intentDecision: IntentCheckDecision;
    const userRequest = guardedOptions.userRequest;

    if (userRequest === undefined || userRequest.trim().length === 0) {
      intentDecision = {
        status: 'failed',
        reasons: [REASON_CODES.INTENT_CHECK_FAILED],
      };
    } else {
      try {
        intentDecision = await guardedOptions.intentChecker.check({
          userRequest,
          cart: {
            merchant: proposal.merchant,
            category: proposal.category,
            currency: proposal.currency,
            amountMinorUnits: proposal.amountMinorUnits,
            feeMinorUnits: proposal.feeMinorUnits ?? 0,
            items: proposal.items,
          },
        });
      } catch {
        intentDecision = {
          status: 'failed',
          reasons: [REASON_CODES.INTENT_CHECK_FAILED],
        };
      }
    }

    if (intentDecision.status === 'failed') {
      intentAudit = {
        match: 'error',
        reasons: intentDecision.reasons,
      };
      guardResult = {
        verdict: 'REQUIRE_APPROVAL',
        reasons: [REASON_CODES.INTENT_CHECK_FAILED],
      };
    } else {
      intentAudit = {
        match: intentDecision.match,
        reasons: intentDecision.reasons,
      };

      if (intentDecision.match === 'partial') {
        guardResult = {
          verdict: 'REQUIRE_APPROVAL',
          reasons: [REASON_CODES.INTENT_PARTIAL],
        };
      } else if (intentDecision.match === 'mismatch') {
        guardResult = {
          verdict: 'REQUIRE_APPROVAL',
          reasons: [REASON_CODES.INTENT_MISMATCH],
        };
      }
    }
  }

  let idempotencyKey: string;

  try {
    idempotencyKey = generateIdempotencyKey();
  } catch {
    const reason = REASON_CODES.INTERNAL_ERROR;
    const decisionId = await saveFailureDecision(store, {
      mandateId: context.mandateId,
      verdict: 'BLOCK',
      reasons: [reason],
      toolName,
      requestPayload: { arguments: args, proposedOrder: proposal },
    });

    return refusal([reason], 'Blocked: idempotency key generation failed', decisionId);
  }

  if (guardResult.verdict === 'REQUIRE_APPROVAL') {
    let pending: { orderId: string; approvalId: string; decisionId: string };

    try {
      pending = await store.savePendingApproval({
        order: orderInput({
          mandateId: context.mandateId,
          proposal,
          idempotencyKey,
        }),
        reason: messageFor('REQUIRE_APPROVAL', guardResult.reasons),
        decision: decisionInput({
          mandateId: context.mandateId,
          verdict: 'REQUIRE_APPROVAL',
          reasons: guardResult.reasons,
          proposal,
          args,
          idempotencyKey,
          ...(intentAudit === undefined ? {} : { intent: intentAudit }),
        }),
      });
    } catch {
      return refusal(
        [REASON_CODES.INTERNAL_ERROR],
        'Blocked: pending approval could not be saved',
      );
    }

    return {
      pending: true,
      status: 'PENDING_APPROVAL',
      verdict: 'REQUIRE_APPROVAL',
      reasons: guardResult.reasons,
      message: messageFor('REQUIRE_APPROVAL', guardResult.reasons),
      approvalId: pending.approvalId,
      orderId: pending.orderId,
      decisionId: pending.decisionId,
    } satisfies GuardPendingApproval;
  }

  let savedOrder: { orderId: string; decisionId: string };

  try {
    savedOrder = await store.saveAllowedOrder({
      order: orderInput({
        mandateId: context.mandateId,
        proposal,
        idempotencyKey,
      }),
      decision: decisionInput({
        mandateId: context.mandateId,
        verdict: 'ALLOW',
        reasons: guardResult.reasons,
        proposal,
        args,
        idempotencyKey,
        ...(intentAudit === undefined ? {} : { intent: intentAudit }),
      }),
    });
  } catch {
    return refusal(
      [REASON_CODES.INTERNAL_ERROR],
      'Blocked: order could not be saved before calling PayPal',
    );
  }

  const originalExecute = tool.execute;

  if (!originalExecute) {
    await store.markOrderFailed(savedOrder.orderId).catch(() => undefined);
    return refusal(
      [REASON_CODES.INTERNAL_ERROR],
      'Blocked: PayPal tool is not executable',
      savedOrder.decisionId,
    );
  }

  let paypalResult: unknown;

  try {
    paypalResult = await originalExecute(args, options);
  } catch {
    await store.markOrderFailed(savedOrder.orderId).catch(() => undefined);
    return refusal(
      [REASON_CODES.PAYPAL_CALL_FAILED],
      'Blocked: PayPal order creation failed',
      savedOrder.decisionId,
    );
  }

  try {
    const details = paypalOrderDetails(paypalResult);
    await store.finalizeOrder(savedOrder.orderId, details);
  } catch {
    await store.markOrderFailed(savedOrder.orderId).catch(() => undefined);
    return refusal(
      [REASON_CODES.INTERNAL_ERROR],
      'Blocked: PayPal response could not be recorded',
      savedOrder.decisionId,
    );
  }

  return paypalResult;
}

export function wrapToolkitTools(
  tools: Record<string, ToolkitTool>,
  options: GuardedToolkitOptions,
): Record<string, ToolkitTool> {
  const wrapped: Record<string, ToolkitTool> = {};

  for (const [toolName, tool] of Object.entries(tools)) {
    const originalExecute = tool.execute;

    if (!originalExecute) {
      wrapped[toolName] = { ...tool };
      continue;
    }

    wrapped[toolName] = {
      ...tool,
      execute:
        toolName === GUARDED_TOOL
          ? (args, executeOptions) =>
              guardCreateOrder(toolName, tool, args, executeOptions, options)
          : (args, executeOptions) => originalExecute(args, executeOptions),
    };
  }

  return wrapped;
}
