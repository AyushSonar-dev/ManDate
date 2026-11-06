export type GuardVerdict = 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED';

export interface Mandate {
  id: string;
  totalBudgetMinorUnits: number;
  perPurchaseCapMinorUnits: number;
  approvalThresholdMinorUnits: number;
  spentMinorUnits: number;
  currency: string;
  allowedMerchants: string[];
  allowedCategories: string[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposedOrder {
  merchant: string;
  category: string;
  currency: string;
  amountMinorUnits: number;
  feeMinorUnits?: number;
  items: Array<{
    name: string;
    quantity: number;
    unitAmountMinorUnits: number;
  }>;
}

export interface Decision {
  id: string;
  mandateId: string;
  orderId: string | null;
  verdict: GuardVerdict;
  reason: string;
  reasons: string[];
  toolName: string;
  requestPayload: unknown;
  createdAt: string;
}

export interface Approval {
  id: string;
  orderId: string | null;
  mandateId: string;
  status: ApprovalStatus;
  reason: string | null;
  approvedBy: string | null;
  resolvedBy: string | null;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface OrderSummary {
  id: string;
  mandateId: string;
  paypalOrderId: string | null;
  idempotencyKey: string;
  merchant: string;
  category: string;
  items: ProposedOrder['items'];
  amountMinorUnits: number;
  feeMinorUnits: number;
  currency: string;
  status: 'CREATED' | 'APPROVED' | 'CAPTURED' | 'FAILED';
  approvalLink: string | null;
  captureId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderReceipt {
  order: OrderSummary;
  mandate: Mandate;
  paypalOrderId: string | null;
  captureId: string | null;
  approvedBy: string | null;
  decisions: Decision[];
  approvals: Approval[];
  rules: {
    passed: string[];
    failed: string[];
  };
}

export interface AgentStepLog {
  stepNumber: number;
  text: string;
  finishReason: string;
  toolCalls: Array<{
    toolName: string;
    toolCallId: string;
    args: unknown;
  }>;
  toolResults: Array<{
    toolName: string;
    toolCallId: string;
    result: unknown;
  }>;
}

export interface AgentRunResponse {
  text: string;
  steps: AgentStepLog[];
}

export interface ScorecardCategory {
  category: string;
  passed: number;
  total: number;
}

export interface ScorecardScenario {
  id: string;
  name: string;
  category: string;
  expectedVerdict: GuardVerdict;
  expectedReasons: string[];
  actualVerdict: GuardVerdict;
  actualReasons: string[];
  passed: boolean;
  mandateId: string;
  trail?: unknown;
}

export interface ScorecardResults {
  setName: 'core' | 'heldout';
  marker: string;
  totalScenarios: number;
  passedScenarios: number;
  categories: ScorecardCategory[];
  scenarios: ScorecardScenario[];
}

export interface AttackRun {
  id: string;
  mandateId: string | null;
  name: string;
  status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED';
  totalScenarios: number;
  passedScenarios: number;
  results: ScorecardResults | null;
  startedAt: string;
  completedAt: string | null;
}

export interface LatestScorecard {
  latest: AttackRun | null;
}
