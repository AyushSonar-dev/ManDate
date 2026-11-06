import { Router } from 'express';
import { z } from 'zod';
import type { AgentRunner } from '../agent/service.js';

const runAgentSchema = z.object({
  mandateId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(4_000),
});

export function createAgentRouter(runner: AgentRunner | null): Router {
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

      const result = await runner.run(parsed.data);

      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
