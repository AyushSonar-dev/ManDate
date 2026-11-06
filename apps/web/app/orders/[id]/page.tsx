'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { VerdictBadge } from '@/components/VerdictBadge';
import { ApiError, apiGet, errorMessage } from '@/lib/api';
import {
  formatDateTime,
  formatMoney,
  proposedOrderFromDecision,
  reasonLabel,
} from '@/lib/format';
import type { OrderReceipt } from '@/lib/types';

const statusClasses: Record<string, string> = {
  CREATED: 'border-sky-200 bg-sky-50 text-sky-700',
  APPROVED: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  CAPTURED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  FAILED: 'border-rose-200 bg-rose-50 text-rose-700',
  PENDING: 'border-amber-200 bg-amber-50 text-amber-700',
  DENIED: 'border-rose-200 bg-rose-50 text-rose-700',
};

export default function OrderPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const loadReceipt = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);

    try {
      const result = await apiGet<OrderReceipt>(
        `/orders/${encodeURIComponent(id)}/receipt`,
      );
      setReceipt(result);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 404) {
        setNotFound(true);
        setReceipt(null);
        return;
      }
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadReceipt();
  }, [loadReceipt]);

  if (loading) {
    return <LoadingState label="Loading order receipt…" />;
  }

  if (notFound) {
    return (
      <EmptyState
        title="Order not found"
        action={
          <Link href="/approvals" className="font-semibold text-sky-700">
            Back to approvals
          </Link>
        }
      >
        No receipt exists for <span className="font-mono">{id}</span>.
      </EmptyState>
    );
  }

  if (error || !receipt) {
    return <ErrorState message={error ?? 'Receipt unavailable'} onRetry={() => void loadReceipt()} />;
  }

  const { order, mandate, approvals, decisions, rules } = receipt;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
            Audit receipt
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {order.merchant}
          </h1>
          <p className="mt-1 font-mono text-xs text-slate-500">{order.id}</p>
        </div>
        <Link
          href="/approvals"
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Back to approvals
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Order
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                statusClasses[order.status] ?? statusClasses.CREATED
              }`}
            >
              {reasonLabel(order.status)}
            </span>
            <span className="text-lg font-semibold">
              {formatMoney(order.amountMinorUnits, order.currency)}
            </span>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Category</dt>
              <dd className="font-medium">{order.category}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Created</dt>
              <dd>{formatDateTime(order.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Updated</dt>
              <dd>{formatDateTime(order.updatedAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            PayPal
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-slate-500">Order ID</dt>
              <dd className="mt-1 break-all font-mono text-xs">
                {receipt.paypalOrderId ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Capture ID</dt>
              <dd className="mt-1 break-all font-mono text-xs">
                {receipt.captureId ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Approved by</dt>
              <dd className="mt-1">{receipt.approvedBy ?? '—'}</dd>
            </div>
          </dl>
          {order.approvalLink ? (
            <a
              href={order.approvalLink}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block text-xs font-semibold text-sky-700 hover:text-sky-900"
            >
              PayPal approval link ↗
            </a>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Mandate
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Budget</dt>
              <dd className="font-medium">
                {formatMoney(
                  mandate.totalBudgetMinorUnits,
                  mandate.currency,
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Spent</dt>
              <dd className="font-medium">
                {formatMoney(mandate.spentMinorUnits, mandate.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Per purchase</dt>
              <dd className="font-medium">
                {formatMoney(
                  mandate.perPurchaseCapMinorUnits,
                  mandate.currency,
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Threshold</dt>
              <dd className="font-medium">
                {formatMoney(
                  mandate.approvalThresholdMinorUnits,
                  mandate.currency,
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-4 font-mono text-[11px] text-slate-500">
            {mandate.id}
          </p>
        </section>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Items</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 font-medium">Item</th>
                <th className="py-2 text-right font-medium">Qty</th>
                <th className="py-2 text-right font-medium">Unit</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {order.items.map((item, index) => (
                <tr key={`${item.name}-${index}`}>
                  <td className="py-2">{item.name}</td>
                  <td className="py-2 text-right">{item.quantity}</td>
                  <td className="py-2 text-right">
                    {formatMoney(item.unitAmountMinorUnits, order.currency)}
                  </td>
                  <td className="py-2 text-right font-medium">
                    {formatMoney(
                      item.unitAmountMinorUnits * item.quantity,
                      order.currency,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Decision trail</h2>
        <ol className="mt-4 space-y-3">
          {decisions.map((decision) => {
            const proposed = proposedOrderFromDecision(decision);

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
                {proposed ? (
                  <p className="mt-2 text-sm text-slate-700">
                    {proposed.merchant} · {proposed.category} ·{' '}
                    {formatMoney(
                      proposed.amountMinorUnits,
                      proposed.currency,
                    )}
                  </p>
                ) : null}
                {decision.reasons.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
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
                  <p className="mt-2 text-xs text-slate-500">
                    No rule violations reported.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Rules</h2>
          <p className="mt-1 text-xs text-slate-500">
            Failed rules are taken from the latest decision; passed rules are the
            remaining guard rule set.
          </p>
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <p className="font-medium text-rose-700">Failed</p>
              {rules.failed.length === 0 ? (
                <p className="mt-1 text-slate-500">None</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {rules.failed.map((rule) => (
                    <span
                      key={rule}
                      className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700"
                    >
                      {reasonLabel(rule)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="font-medium text-emerald-700">Passed</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {rules.passed.map((rule) => (
                  <span
                    key={rule}
                    className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700"
                  >
                    {reasonLabel(rule)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Approvals</h2>
          {approvals.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No approval records.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {approvals.map((approval) => (
                <li
                  key={approval.id}
                  className="rounded-xl border border-slate-200 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`rounded-full border px-2 py-1 text-xs font-semibold ${
                        statusClasses[approval.status] ?? statusClasses.PENDING
                      }`}
                    >
                      {reasonLabel(approval.status)}
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatDateTime(approval.requestedAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-slate-700">
                    {approval.reason ?? 'No reason recorded'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Resolved by {approval.approvedBy ?? '—'} ·{' '}
                    {formatDateTime(approval.resolvedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
