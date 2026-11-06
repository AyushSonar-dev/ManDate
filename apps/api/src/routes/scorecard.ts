import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';

export function createScorecardRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/latest', async (_request, response, next) => {
    try {
      const latest = await prisma.attackRun.findFirst({
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      });

      response.status(200).json({ latest });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
