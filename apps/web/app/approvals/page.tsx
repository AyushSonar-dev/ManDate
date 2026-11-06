'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { ApiError, apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime, reasonLabel } from '@/lib/format';
import type { Approval } from '@/lib/types';

type Outcome = {
  tone: 'success' | 'error';
  message: string;
};

function outcomeMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) {
    return fallback;
  }

  const record = body as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : '';
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof record.error === 'string'
        ? record.error
        : '';

  if (status === 'CAPTURED') {
    return 'Approved and captured in PayPal sandbox.';
  }

  if (status === 'PENDING_BUYER_APPROVAL') {
    return message || 'Approved. PayPal still requires buyer approval.';
  }

  if (status === 'DENIED') {
    return message || 'Approval denied.';
  }

  return message || fallback;
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actor, setActor] = useState('buyer');
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const loadApprovals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiGet<Approval[]>('/approvals?status=PENDING');
      setApprovals(result);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  async function resolve(
    approval: Approval,
    action: 'approve' | 'reject',
  ) {
    const key = `${approval.id}:${action}`;
    setBusy(key);
    setOutcome(null);

    try {
      const result = await apiPost<Record<string, unknown>>(
        `/approvals/${approval.id}/${action}`,
        action === 'approve'
          ? { approvedBy: actor.trim() || 'buyer' }
          : { rejectedBy: actor.trim() || 'buyer' },
      );
      setOutcome({
        tone: 'success',
        message: outcomeMessage(result, 'Approval resolved.'),
      });
      await loadApprovals();
    } catch (resolutionError) {
      setOutcome({
        tone: 'error',
        message: outcomeMessage(
          resolutionError instanceof ApiError
            ? resolutionError.data
            : null,
          errorMessage(resolutionError),
        ),
      });

      if (
        resolutionError instanceof ApiError &&
        [403, 409, 502].includes(resolutionError.status)
      ) {
        await loadApprovals();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">
          Human check
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Approvals</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Purchases above the mandate threshold wait here. Blocked and
          pre-approval orders never call PayPal.
        </p>
      </div>

      <label className="block max-w-sm space-y-1.5 text-sm">
        <span className="font-medium text-slate-700">Resolving as</span>
        <input
          value={actor}
          onChange={(event) => setActor(event.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 outline-none ring-sky-500 focus:ring-2"
          placeholder="buyer"
        />
      </label>

      {outcome ? (
        <div
          className={`rounded-2xl border p-4 text-sm ${
            outcome.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          {outcome.message}
        </div>
      ) : null}

      {loading ? <LoadingState label="Loading approvals…" /> : null}
      {error ? (
        <ErrorState message={error} onRetry={() => void loadApprovals()} />
      ) : null}

      {!loading && !error && approvals.length === 0 ? (
        <EmptyState title="No pending approvals">
          Orders below the threshold proceed automatically; orders that trip a
          hard limit are blocked instead.
        </EmptyState>
      ) : null}

      {!loading && !error && approvals.length > 0 ? (
        <ul className="space-y-4">
          {approvals.map((approval) => (
            <li
              key={approval.id}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                      Pending
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      {approval.id}
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-medium text-slate-900">
                    {approval.reason
                      ? reasonLabel(approval.reason)
                      : 'Purchase requires approval'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Requested {formatDateTime(approval.requestedAt)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    Mandate {approval.mandateId}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {approval.orderId ? (
                    <Link
                      href={`/orders/${approval.orderId}`}
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      View order
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void resolve(approval, 'reject')}
                    disabled={busy !== null}
                    className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                  >
                    {busy === `${approval.id}:reject` ? 'Rejecting…' : 'Reject'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolve(approval, 'approve')}
                    disabled={busy !== null}
                    className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {busy === `${approval.id}:approve` ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
