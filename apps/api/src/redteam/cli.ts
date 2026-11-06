import { loadEnv } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import {
  REDTEAM_SET_NAMES,
  formatScorecard,
  runRedteam,
  type RedteamSetName,
} from './runner.js';

function parseSet(argv: readonly string[]): RedteamSetName {
  const value = argv
    .find((argument) => argument.startsWith('--set='))
    ?.slice('--set='.length);

  if (value === undefined || value.length === 0) {
    return 'core';
  }

  if (!(REDTEAM_SET_NAMES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown red-team set "${value}". Use one of: ${REDTEAM_SET_NAMES.join(', ')}`,
    );
  }

  return value as RedteamSetName;
}

async function main(): Promise<void> {
  loadEnv();
  const setName = parseSet(process.argv.slice(2));
  const report = await runRedteam({ prisma, setName });

  console.log(formatScorecard(report));

  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
