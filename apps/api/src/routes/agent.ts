import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import type { AgentRunner } from '../agent/service.js';
import { reasonsFromDecision } from '../orders/receipt.js';

const runAgentSchema = z.object({
  mandateId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(4_000),
});

const runIdSchema = z.string().uuid();

function readableError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'The agent run failed';
  }
}

async function executeRun(
  prisma: PrismaClient,
  runner: AgentRunner,
  run: { id: string; mandateId: string; prompt: string },
): Promise<void> {
  try {
    const result = await runner.run({
      mandateId: run.mandateId,
      prompt: run.prompt,
      runId: run.id,
    });

    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        result: result.text,
        error: null,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    const message = readableError(error);

    try {
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          result: null,
          error: message,
          completedAt: new Date(),
        },
      });
    } catch (updateError) {
      console.error('Failed to mark agent run as failed', updateError);
    }
  }
}

export function createAgentRouter(
  runner: AgentRunner | null,
  prisma: PrismaClient,
): Router {
  const router = Router();

  router.post('/runs', async (request, response, next) => {
    try {
      const parsed = runAgentSchema.safeParse(request.body);

      if (!parsed.success) {
        response.status(400).json({
          error: 'Invalid agent run',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }

      if (runner === null) {
        response.status(503).json({
          error: 'Agent runner is not configured',
        });
        return;
      }

      const mandate = await prisma.mandate.findUnique({
        where: { id: parsed.data.mandateId },
        select: { id: true },
      });
      const run = await prisma.agentRun.create({
        data: {
          mandateId: mandate?.id ?? null,
          prompt: parsed.data.prompt,
          status: 'RUNNING',
        },
      });

      response.status(202).json({
        runId: run.id,
        run_id: run.id,
        status: run.status,
      });

      void executeRun(prisma, runner, {
        id: run.id,
        mandateId: parsed.data.mandateId,
        prompt: run.prompt,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs/:id', async (request, response, next) => {
    try {
      const parsed = runIdSchema.safeParse(request.params.id);

      if (!parsed.success) {
        response.status(400).json({ error: 'Invalid agent run id' });
        return;
      }

      const run = await prisma.agentRun.findUnique({
        where: { id: parsed.data },
        include: {
          decisions: { orderBy: { createdAt: 'desc' } },
        },
      });

      if (!run) {
        response.status(404).json({ error: 'Agent run not found' });
        return;
      }

      const { decisions, ...runFields } = run;

      response.status(200).json({
        ...runFields,
        runId: run.id,
        run_id: run.id,
        decisions: decisions.map((decision) => ({
          ...decision,
          reasons: reasonsFromDecision(decision),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
