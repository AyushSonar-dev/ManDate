import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mandate Guard',
  description: 'Spending authorization for AI shopping agents',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-slate-950 antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-xs text-slate-500 sm:px-6 lg:px-8">
          Sandbox only. Guard decisions are deterministic; AI checks can only
          tighten a verdict.
        </footer>
      </body>
    </html>
  );
}
