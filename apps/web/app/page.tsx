import Link from 'next/link';

const cards = [
  {
    href: '/mandate',
    title: 'Set a mandate',
    body: 'Define total budget, per-purchase cap, approval threshold, merchants, categories, currency, and expiry.',
  },
  {
    href: '/run',
    title: 'Run the agent',
    body: 'Give a shopping prompt and watch guarded tool calls appear with their verdicts and reasons.',
  },
  {
    href: '/approvals',
    title: 'Resolve approvals',
    body: 'Review purchases above the approval threshold, then approve or reject them.',
  },
  {
    href: '/scorecard',
    title: 'Red-team scorecard',
    body: 'Inspect the latest attack-suite result, category scores, and any failing decision trails.',
  },
];

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-8 p-8 lg:grid-cols-[1.4fr_1fr] lg:p-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-700">
              Mandate Guard console
            </p>
            <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              An authorization layer between an AI agent and PayPal.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">
              Hard limits are deterministic. Every guarded order gets an{' '}
              <strong className="text-slate-900">ALLOW</strong>,{' '}
              <strong className="text-slate-900">BLOCK</strong>, or{' '}
              <strong className="text-slate-900">REQUIRE_APPROVAL</strong>{' '}
              verdict, and every decision is written to the audit log.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/mandate"
                className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Create a mandate
              </Link>
              <Link
                href="/run"
                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Run the agent
              </Link>
            </div>
          </div>

          <div className="rounded-2xl bg-slate-950 p-6 text-slate-100">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300">
              Fail closed
            </p>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              <li>Deterministic limits run before any PayPal call.</li>
              <li>Blocked and approval verdicts never call PayPal.</li>
              <li>AI intent checks can only tighten an ALLOW.</li>
              <li>Errors, timeouts, and bad model output never ALLOW.</li>
              <li>Money is stored as integer minor units.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md"
          >
            <h2 className="text-lg font-semibold text-slate-950">{card.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">{card.body}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-sky-700 group-hover:text-sky-900">
              Open →
            </span>
          </Link>
        ))}
      </section>
    </div>
  );
}
