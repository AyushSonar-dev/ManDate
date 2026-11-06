'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { VerdictBadge } from '@/components/VerdictBadge';
import { apiGet, errorMessage } from '@/lib/api';
import {
  formatDateTime,
  reasonLabel,
} from '@/lib/format';
import type { LatestScorecard } from '@/lib/types';

const statusClasses: Record<string, string> = {
  PASSED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  FAILED: 'border-rose-200 bg-rose-50 text-rose-700',
  RUNNING: 'border-sky-200 bg-sky-50 text-sky-700',
  PENDING: 'border-amber-200 bg-amber-50 text-amber-700',
};

export default function ScorecardPage() {
  const [data, setData] = useState<LatestScorecard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiGet<LatestScorecard>('/scorecard/latest'));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <LoadingState label="Loading latest scorecard…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  const latest = data?.latest ?? null;

  if (!latest) {
    return (
      <EmptyState title="No red-team runs yet">
        Run <code className="rounded bg-slate-100 px-1.5 py-0.5">npm run redteam -- --set=core</code>{' '}
        to create the first scorecard.
      </EmptyState>
    );
  }

  const results = latest.results;
  const failures = results?.scenarios.filter((scenario) => !scenario.passed) ?? [];
  const passRate =
    latest.totalScenarios === 0
      ? 0
      : Math.round((latest.passedScenarios / latest.totalScenarios) * 100);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
            Adversarial validation
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Red-team scorecard
          </h1>
          <p className="mt-1 font-mono text-xs text-slate-500">{latest.name}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <section className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Status
          </p>
          <p className="mt-3">
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                statusClasses[latest.status] ?? statusClasses.PENDING
              }`}
            >
              {reasonLabel(latest.status)}
            </span>
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Passed
          </p>
          <p className="mt-2 text-2xl font-semibold">
            {latest.passedScenarios}/{latest.totalScenarios}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Pass rate
          </p>
          <p className="mt-2 text-2xl font-semibold">{passRate}%</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Set
          </p>
          <p className="mt-2 text-2xl font-semibold capitalize">
            {results?.setName ?? '—'}
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Run details</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-slate-500">Started</dt>
            <dd className="mt-1">{formatDateTime(latest.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Completed</dt>
            <dd className="mt-1">{formatDateTime(latest.completedAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Marker</dt>
            <dd className="mt-1 break-all font-mono text-xs">
              {results?.marker ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Failures</dt>
            <dd className="mt-1">{failures.length}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Categories</h2>
        {!results || results.categories.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No category scores in this run.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {results.categories.map((category) => {
              const rate =
                category.total === 0
                  ? 0
                  : Math.round((category.passed / category.total) * 100);

              return (
                <div key={category.category}>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium capitalize">
                      {reasonLabel(category.category)}
                    </span>
                    <span className="text-slate-500">
                      {category.passed}/{category.total}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${
                        rate === 100 ? 'bg-emerald-500' : 'bg-amber-500'
                      }`}
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Scenarios</h2>
        {!results || results.scenarios.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No per-scenario results in this run.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {results.scenarios.map((scenario) => (
              <li
                key={scenario.id}
                className="rounded-xl border border-slate-200 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                        scenario.passed
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-rose-200 bg-rose-50 text-rose-700'
                      }`}
                    >
                      {scenario.passed ? 'PASS' : 'FAIL'}
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      {scenario.id}
                    </span>
                    <span className="text-xs text-slate-500">
                      {reasonLabel(scenario.category)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span>expected</span>
                    <VerdictBadge verdict={scenario.expectedVerdict} />
                    <span>actual</span>
                    <VerdictBadge verdict={scenario.actualVerdict} />
                  </div>
                </div>

                <p className="mt-2 text-sm font-medium text-slate-800">
                  {scenario.name}
                </p>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {scenario.expectedReasons.map((reason) => (
                    <span
                      key={`expected-${reason}`}
                      className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600"
                    >
                      expected: {reasonLabel(reason)}
                    </span>
                  ))}
                  {scenario.actualReasons.map((reason) => (
                    <span
                      key={`actual-${reason}`}
                      className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600"
                    >
                      actual: {reasonLabel(reason)}
                    </span>
                  ))}
                </div>

                {!scenario.passed && scenario.trail ? (
                  <details className="mt-3 text-xs text-slate-600">
                    <summary className="cursor-pointer font-semibold text-slate-700">
                      Failure trail
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                      {JSON.stringify(scenario.trail, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
