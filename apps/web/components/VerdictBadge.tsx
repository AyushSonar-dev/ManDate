import { reasonLabel, verdictClasses } from '@/lib/format';
import type { GuardVerdict } from '@/lib/types';

export function VerdictBadge({ verdict }: { verdict: GuardVerdict }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide ${verdictClasses(
        verdict,
      )}`}
    >
      {reasonLabel(verdict)}
    </span>
  );
}
