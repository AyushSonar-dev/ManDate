'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { VerdictBadge } from '@/components/VerdictBadge';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import {
  formatDateTime,
  formatMoney,
  proposedOrderFromDecision,
  reasonLabel,
} from '@/lib/format';
import type {
  AgentRunResponse,
  Decision,
  Mandate,
} from '@/lib/types';

const initialPrompt =
  'Buy me one copy of a book from an allowed merchant, staying within my mandate.';

export default function RunPage() {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [selectedMandateId, setSelectedMandateId] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [finalText, setFinalText] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);

  const loadMandates = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiGet<Mandate[]>('/mandates');
      setMandates(result);
      setSelectedMandateId((current) => current || result[0]?.id || '');
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMandates();
  }, [loadMandates]);

  const refreshDecisions = useCallback(async () => {
    if (!selectedMandateId) {
      return;
    }

    try {
      const result = await apiGet<Decision[]>(
        `/mandates/${selectedMandateId}/decisions?limit=50`,
      );
      setDecisions(result);
      setDecisionsError(null);
    } catch (error) {
      setDecisionsError(errorMessage(error));
    }
  }, [selectedMandateId]);

  useEffect(() => {
    if (!running || !selectedMandateId) {
      return;
    }

    void refreshDecisions();
    const interval = window.setInterval(() => {
      void refreshDecisions();
    }, 1_500);

    return () => window.clearInterval(interval);
  }, [running, selectedMandateId, refreshDecisions]);

  useEffect(() => {
    setDecisions([]);
    setDecisionsError(null);
    setRunError(null);
    setFinalText(null);
    setRunStartedAt(null);
  }, [selectedMandateId]);

  async function runAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedMandateId) {
      return;
    }

    setRunning(true);
    setRunError(null);
    setDecisionsError(null);
    setFinalText(null);
    setDecisions([]);
    setRunStartedAt(new Date().toISOString());

    try {
      const result = await apiPost<AgentRunResponse>('/agent/runs', {
        mandateId: selectedMandateId,
        prompt,
      });
      await refreshDecisions();
      setFinalText(result.text);
    } catch (error) {
      setRunError(errorMessage(error));
      await refreshDecisions();
    } finally {
      setRunning(false);
    }
  }

  const selectedMandate =
    mandates.find((mandate) => mandate.id === selectedMandateId) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
          Step 2
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Run the agent</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          The agent searches the storefront, tries to create a PayPal order, and
          the guard records a decision for each guarded tool call. The feed polls
          the audit log while the run is in progress.
        </p>
      </div>

      {loading ? <LoadingState label="Loading mandates…" /> : null}
      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void loadMandates()} />
      ) : null}

      {!loading && !loadError && mandates.length === 0 ? (
        <EmptyState
          title="Create a mandate first"
          action={
            <Link
              href="/mandate"
              className="inline-block rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Go to mandate
            </Link>
          }
        >
          The agent needs budget, limits, and an allowlist before it can shop.
        </EmptyState>
      ) : null}

      {!loading && !loadError && mandates.length > 0 ? (
        <div className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
          <form
            onSubmit={runAgent}
            className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-slate-700">Mandate</span>
              <select
                value={selectedMandateId}
                onChange={(event) => setSelectedMandateId(event.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 outline-none ring-sky-500 focus:ring-2"
                disabled={running}
              >
                {mandates.map((mandate) => (
                  <option key={mandate.id} value={mandate.id}>
                    {mandate.id.slice(0, 8)}… ·{' '}
                    {formatMoney(mandate.totalBudgetMinorUnits, mandate.currency)}
                  </option>
                ))}
              </select>
            </label>

            {selectedMandate ? (
              <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                <div className="flex items-center justify-between gap-3">
                  <span>Budget</span>
                  <span className="font-semibold text-slate-900">
                    {formatMoney(
                      selectedMandate.totalBudgetMinorUnits,
                      selectedMandate.currency,
                    )}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span>Per-purchase cap</span>
                  <span className="font-semibold text-slate-900">
                    {formatMoney(
                      selectedMandate.perPurchaseCapMinorUnits,
                      selectedMandate.currency,
                    )}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span>Approval threshold</span>
                  <span className="font-semibold text-slate-900">
                    {formatMoney(
                      selectedMandate.approvalThresholdMinorUnits,
                      selectedMandate.currency,
                    )}
                  </span>
                </div>
              </div>
            ) : null}

            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-slate-700">Shopping prompt</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={6}
                className="w-full resize-y rounded-xl border border-slate-300 px-3 py-2 leading-6 outline-none ring-sky-500 focus:ring-2"
                disabled={running}
                required
              />
            </label>

            <button
              type="submit"
              disabled={running || !selectedMandateId || prompt.trim().length === 0}
              className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? 'Agent is running…' : 'Run agent'}
            </button>

            {runStartedAt ? (
              <p className="text-xs text-slate-500">
                Last run started {formatDateTime(runStartedAt)}
              </p>
            ) : null}

            {runError ? <ErrorState message={runError} /> : null}
            {decisionsError ? <ErrorState message={decisionsError} /> : null}
          </form>

          <div className="space-y-4">
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    Guarded tool calls
                  </h2>
                  <p className="text-xs text-slate-500">
                    Live decisions from the audit log, newest first.
                  </p>
                </div>
                {running ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">
                    <span className="size-2 animate-pulse rounded-full bg-sky-500" />
                    Running
                  </span>
                ) : null}
              </div>

              {decisions.length === 0 ? (
                <div className="mt-4">
                  <EmptyState title={running ? 'Waiting for a guarded call' : 'No decisions yet'}>
                    {running
                      ? 'The agent may be searching or inspecting the catalog. Decisions appear when it calls create_order.'
                      : 'Run the agent to create a decision trail.'}
                  </EmptyState>
                </div>
              ) : (
                <ol className="mt-4 space-y-3">
                  {decisions.map((decision) => {
                    const order = proposedOrderFromDecision(decision);

                    return (
                      <li
                        key={decision.id}
                        className="rounded-xl border border-slate-200 p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <VerdictBadge verdict={decision.verdict} />
                            <span className="font-mono text-xs text-slate-500">
                              {decision.toolName}
                            </span>
                          </div>
                          <span className="text-xs text-slate-500">
                            {formatDateTime(decision.createdAt)}
                          </span>
                        </div>

                        {order ? (
                          <p className="mt-3 text-sm text-slate-700">
                            <span className="font-medium">{order.merchant}</span> ·{' '}
                            {order.category} ·{' '}
                            <span className="font-semibold">
                              {formatMoney(order.amountMinorUnits, order.currency)}
                            </span>
                          </p>
                        ) : null}

                        {decision.reasons.length > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {decision.reasons.map((reason) => (
                              <span
                                key={reason}
                                className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600"
                              >
                                {reasonLabel(reason)}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-3 text-xs text-slate-500">
                            No rule violations reported.
                          </p>
                        )}

                        <div className="mt-3 flex flex-wrap gap-3 text-xs font-semibold">
                          {decision.orderId ? (
                            <Link
                              href={`/orders/${decision.orderId}`}
                              className="text-sky-700 hover:text-sky-900"
                            >
                              View receipt →
                            </Link>
                          ) : null}
                          {decision.verdict === 'REQUIRE_APPROVAL' ? (
                            <Link
                              href="/approvals"
                              className="text-amber-700 hover:text-amber-900"
                            >
                              Resolve approval →
                            </Link>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {finalText ? (
              <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-800">
                  Agent response
                </h2>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-emerald-950">
                  {finalText}
                </p>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
