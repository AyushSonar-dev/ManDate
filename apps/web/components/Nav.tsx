'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/mandate', label: 'Mandate' },
  { href: '/run', label: 'Run agent' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/scorecard', label: 'Scorecard' },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-slate-200/80 bg-white/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <Link href="/" className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-slate-950 text-sm font-bold text-white">
            MG
          </span>
          <span>
            <span className="block text-sm font-semibold tracking-tight text-slate-950">
              Mandate Guard
            </span>
            <span className="block text-xs text-slate-500">
              Spending authorization for shopping agents
            </span>
          </span>
        </Link>

        <nav className="flex flex-wrap gap-1 text-sm">
          {links.map((link) => {
            const active =
              pathname === link.href || pathname.startsWith(`${link.href}/`);

            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-lg px-3 py-2 font-medium transition ${
                  active
                    ? 'bg-slate-950 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
