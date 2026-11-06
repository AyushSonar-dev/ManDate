import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import type { PrismaClient } from '@prisma/client';
import type { AgentEnv } from '../config/env.js';
import { loadAgentEnv } from '../config/env.js';
import { createIntentChecker } from '../guard/intent.js';
import { PrismaGuardStore } from '../guard/store.js';
import type { ToolkitTool } from '../guard/tool-wrapper.js';
import { createStorefrontProvider } from './provider.js';
import {
  runShoppingAgent,
  type AgentStepLog,
} from './run-agent.js';

export interface AgentRunInput {
  mandateId: string;
  prompt: string;
  onStep?: (step: AgentStepLog) => void;
}

export interface AgentRunResult {
  text: string;
  steps: AgentStepLog[];
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export function createAgentRunner(input: {
  env: AgentEnv;
  prisma: PrismaClient;
}): AgentRunner {
  const provider = createStorefrontProvider(input.env);
  const toolkit = new PayPalAgentToolkit({
    clientId: input.env.PAYPAL_CLIENT_ID,
    clientSecret: input.env.PAYPAL_CLIENT_SECRET,
    configuration: {
      actions: {
        orders: {
          create: true,
          get: true,
        },
      },
      context: {
        sandbox: true,
      },
    },
  });
  const google = createGoogleGenerativeAI({
    apiKey: input.env.GOOGLE_GENERATIVE_AI_API_KEY,
  });
  const model = google(input.env.GOOGLE_MODEL);
  const intentChecker = createIntentChecker({
    model,
    timeoutMs: input.env.INTENT_TIMEOUT_MS,
  });

  return {
    async run(runInput) {
      return runShoppingAgent({
        mandateId: runInput.mandateId,
        prompt: runInput.prompt,
        model,
        provider,
        store: new PrismaGuardStore(input.prisma),
        toolkitTools: toolkit.getTools() as unknown as Record<
          string,
          ToolkitTool
        >,
        intentChecker,
        maxSteps: input.env.AGENT_MAX_STEPS,
        ...(runInput.onStep === undefined ? {} : { onStep: runInput.onStep }),
      });
    },
  };
}

export function createLazyAgentRunner(prisma: PrismaClient): AgentRunner {
  let runner: AgentRunner | null = null;

  return {
    async run(input) {
      runner ??= createAgentRunner({
        env: loadAgentEnv(),
        prisma,
      });

      return runner.run(input);
    },
  };
}
