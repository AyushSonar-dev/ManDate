export interface AgentCliArgs {
  mandateId: string;
  prompt: string;
}

export const AGENT_USAGE =
  'Usage: npm run agent -- --mandate <id> "<shopping request>"';

export function parseAgentCliArgs(argv: readonly string[]): AgentCliArgs {
  let mandateId: string | undefined;
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--mandate') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error(`--mandate requires a value\n${AGENT_USAGE}`);
      }

      mandateId = value;
      index += 1;
      continue;
    }

    if (argument?.startsWith('--mandate=')) {
      mandateId = argument.slice('--mandate='.length);
      continue;
    }

    if (argument?.startsWith('--')) {
      throw new Error(`Unknown option ${argument}\n${AGENT_USAGE}`);
    }

    if (argument) {
      promptParts.push(argument);
    }
  }

  if (!mandateId || mandateId.trim().length === 0) {
    throw new Error(`--mandate is required\n${AGENT_USAGE}`);
  }

  const prompt = promptParts.join(' ').trim();

  if (prompt.length === 0) {
    throw new Error(`A shopping request is required\n${AGENT_USAGE}`);
  }

  return { mandateId: mandateId.trim(), prompt };
}
