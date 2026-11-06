'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { ApiError, apiGet, apiPost, errorMessage } from '@/lib/api';
import { formatDateTime, formatMoney, toMinorUnits } from '@/lib/format';
import type { Mandate } from '@/lib/types';

interface MandateForm {
  totalBudget: string;
  perPurchaseCap: string;
  approvalThreshold: string;
  currency: string;
  allowedMerchants: string;
  allowedCategories: string;
  expiresAt: string;
}

function defaultExpiry(): string {
  const date = new Date(Date.now() + 7 * 86_400_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

const initialForm: MandateForm = {
  totalBudget: '100.00',
  perPurchaseCap: '25.00',
  approvalThreshold: '10.00',
  currency: 'USD',
  allowedMerchants: 'Book Nook, Tech Corner',
  allowedCategories: 'books, electronics',
  expiresAt: '',
};

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function fieldErrors(error: unknown): string[] {
  if (!(error instanceof ApiError)) {
    return [];
  }

  if (
    typeof error.data !== 'object' ||
    error.data === null ||
    !Array.isArray((error.data as { details?: unknown }).details)
  ) {
    return [];
  }

  return ((error.data as { details: unknown[] }).details).map((detail) => {
    if (typeof detail !== 'object' || detail === null) {
      return String(detail);
    }
    const entry = detail as { path?: unknown; message?: unknown };
    return `${typeof entry.path === 'string' ? entry.path : 'field'}: ${
      typeof entry.message === 'string' ? entry.message : 'invalid'
    }`;
  });
}

export default function MandatePage() {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<MandateForm>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string[]>([]);
  const [created, setCreated] = useState<Mandate | null>(null);

  async function loadMandates() {
    setLoading(true);
    setError(null);
    try {
      const result = await apiGet<Mandate[]>('/mandates');
      setMandates(result);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMandates();
  }, []);

  useEffect(() => {
    setForm((current) =>
      current.expiresAt.length > 0
        ? current
        : { ...current, expiresAt: defaultExpiry() },
    );
  }, []);

  function update(field: keyof MandateForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setValidation([]);
    setCreated(null);

    try {
      if (!form.expiresAt) {
        throw new Error('Choose an expiry date');
      }

      const payload = {
        totalBudgetMinorUnits: toMinorUnits(form.totalBudget),
        perPurchaseCapMinorUnits: toMinorUnits(form.perPurchaseCap),
        approvalThresholdMinorUnits: toMinorUnits(
          form.approvalThreshold || '0',
        ),
        currency: form.currency,
        allowedMerchants: splitList(form.allowedMerchants),
        allowedCategories: splitList(form.allowedCategories),
        expiresAt: new Date(form.expiresAt).toISOString(),
      };
      const mandate = await apiPost<Mandate>('/mandates', payload);
      setCreated(mandate);
      setMandates((current) => [mandate, ...current]);
    } catch (submitFailure) {
      setSubmitError(errorMessage(submitFailure));
      setValidation(fieldErrors(submitFailure));
    } finally {
      setSubmitting(false);
    }
  }

  const current = created ?? mandates[0] ?? null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
          Step 1
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Set a mandate</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Amounts are entered in dollars and stored by the API as integer minor
          units. The new mandate becomes the most recent mandate for the run
          screen.
        </p>
      </div>

      {loading ? <LoadingState label="Loading mandates…" /> : null}
      {error ? <ErrorState message={error} onRetry={() => void loadMandates()} /> : null}

      {!loading && !error ? (
        <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <form
            onSubmit={submit}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium text-slate-700">Total budget</span>
                <input
                  value={form.totalBudget}
                  onChange={(event) => update('totalBudget', event.target.value)}
                  inputMode="decimal"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-sky-500 focus:ring-2"
                  required
                />
              </label>

              <label className="space-y-1.5 text-sm">
                <span className="font-medium text-slate-700">Per-purchase cap</span>
                <input
                  value={form.perPurchaseCap}
                  onChange={(event) => update('perPurchaseCap', event.target.value)}
                  inputMode="decimal"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-sky-500 focus:ring-2"
                  required
                />
              </label>

              <label className="space-y-1.5 text-sm">
                <span className="font-medium text-slate-700">Approval threshold</span>
                <input
                  value={form.approvalThreshold}
                  onChange={(event) =>
                    update('approvalThreshold', event.target.value)
                  }
                  inputMode="decimal"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-sky-500 focus:ring-2"
                />
              </label>

              <label className="space-y-1.5 text-sm">
                <span className="font-medium text-slate-700">Currency</span>
                <input
                  value={form.currency}
                  onChange={(event) => update('currency', event.target.value.toUpperCase())}
                  maxLength={3}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 uppercase outline-none ring-sky-500 focus:ring-2"
                  required
                />
              </label>

              <label className="space-y-1.5 text-sm sm:col-span-2">
                <span className="font-medium text-slate-700">Allowed merchants</span>
                <input
                  value={form.allowedMerchants}
                  onChange={(event) =>
                    update('allowedMerchants', event.target.value)
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-sky-500 focus:ring-2"
                  placeholder="Comma separated"
                  required
                />
              </label>

              <label className="space-y-1.5 text-sm sm:col-span-2">
                <span className="font-medium text-slate-700">Allowed categories</span>
                <input
                  value={form.allowedCategories}
                  onChange={(event) =>
                    update('allowedCategories', event.target.value)
                  }
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-sky-500 focus:ring-2"
                  placeholder="Comma separated"
                  required
                />
              </label>

              <label className="space-y-1.5 text-sm sm:col-span-2">
                <span className="font-medium text-slate-700">Expires at</span>
                <input
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(event) => update('expiresAt', event.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none ring-sky-500 focus:ring-2"
                  required
                />
              </label>
            </div>

            {submitError ? (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <p className="font-semibold">{submitError}</p>
                {validation.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {validation.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {created ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                Mandate {created.id.slice(0, 8)}… created.{' '}
                <Link href="/run" className="font-semibold underline">
                  Run the agent
                </Link>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="mt-5 w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Creating mandate…' : 'Create mandate'}
            </button>
          </form>

          <div className="space-y-4">
            {current ? (
              <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Current mandate
                    </p>
                    <p className="mt-1 font-mono text-xs text-slate-500">
                      {current.id}
                    </p>
                  </div>
                  <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700">
                    {current.currency}
                  </span>
                </div>

                <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Total budget</dt>
                    <dd className="mt-1 text-lg font-semibold">
                      {formatMoney(current.totalBudgetMinorUnits, current.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Spent</dt>
                    <dd className="mt-1 text-lg font-semibold">
                      {formatMoney(current.spentMinorUnits, current.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Per-purchase cap</dt>
                    <dd className="mt-1 font-medium">
                      {formatMoney(current.perPurchaseCapMinorUnits, current.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Approval threshold</dt>
                    <dd className="mt-1 font-medium">
                      {formatMoney(
                        current.approvalThresholdMinorUnits,
                        current.currency,
                      )}
                    </dd>
                  </div>
                </dl>

                <div className="mt-5 space-y-3 text-sm">
                  <div>
                    <p className="text-slate-500">Merchants</p>
                    <p className="mt-1 text-slate-800">
                      {current.allowedMerchants.join(', ')}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Categories</p>
                    <p className="mt-1 text-slate-800">
                      {current.allowedCategories.join(', ')}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Expires</p>
                    <p className="mt-1 text-slate-800">
                      {formatDateTime(current.expiresAt)}
                    </p>
                  </div>
                </div>
              </section>
            ) : (
              <EmptyState title="No mandates yet">
                Create one on the left, then use it to run the shopping agent.
              </EmptyState>
            )}

            <section className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
              <p className="font-semibold text-slate-900">Recent mandates</p>
              {mandates.length === 0 ? (
                <p className="mt-2">None.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {mandates.slice(0, 5).map((mandate) => (
                    <li
                      key={mandate.id}
                      className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                    >
                      <span className="font-mono text-xs text-slate-600">
                        {mandate.id.slice(0, 8)}…
                      </span>
                      <span className="text-xs text-slate-500">
                        {formatDateTime(mandate.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
