import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { loadAgentEnv } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { createIntentChecker } from '../guard/intent.js';
import { PrismaGuardStore } from '../guard/store.js';
import type { ToolkitTool } from '../guard/tool-wrapper.js';
import { parseAgentCliArgs } from './cli-args.js';
import { createAgentLlmRuntime } from './llm.js';
import { createStorefrontProvider } from './provider.js';
import { runShoppingAgent, type AgentStepLog } from './run-agent.js';

function printStep(step: AgentStepLog): void {
  console.log(`\nStep ${step.stepNumber} (${step.finishReason})`);

  if (step.text.length > 0) {
    console.log(step.text);
  }

  for (const call of step.toolCalls) {
    console.log(`Tool call: ${call.toolName}`);
    console.log(JSON.stringify(call.args, null, 2));
  }

  for (const result of step.toolResults) {
    console.log(`Tool result: ${result.toolName}`);
    console.log(JSON.stringify(result.result, null, 2));
  }
}

async function main(): Promise<void> {
  const args = parseAgentCliArgs(process.argv.slice(2));
  const env = loadAgentEnv();
  const provider = createStorefrontProvider(env);
  const toolkit = new PayPalAgentToolkit({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
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
  const llm = createAgentLlmRuntime(env);
  const intentChecker = createIntentChecker({
    model: llm.intentModel,
    timeoutMs: env.INTENT_TIMEOUT_MS,
  });
  const result = await runShoppingAgent({
    mandateId: args.mandateId,
    prompt: args.prompt,
    models: llm.entries,
    provider,
    store: new PrismaGuardStore(prisma),
    toolkitTools: toolkit.getTools() as unknown as Record<string, ToolkitTool>,
    intentChecker,
    maxSteps: env.AGENT_MAX_STEPS,
    onStep: printStep,
  });

  console.log('\nFinal response:');
  console.log(result.text);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
