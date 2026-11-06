import { Router } from 'express';
import { z, type ZodError } from 'zod';
import { prisma } from '../db/prisma.js';
import { createMandateSchema } from '../mandates/schema.js';
import { reasonsFromDecision } from '../orders/receipt.js';

export const mandatesRouter = Router();

const decisionsQuerySchema = z.object({
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function validationDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

mandatesRouter.post('/', async (request, response, next) => {
  try {
    const parsed = createMandateSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({
        error: 'Invalid mandate',
        details: validationDetails(parsed.error),
      });
      return;
    }

    const mandate = await prisma.mandate.create({
      data: parsed.data,
    });

    response.status(201).json(mandate);
  } catch (error) {
    next(error);
  }
});

mandatesRouter.get('/', async (_request, response, next) => {
  try {
    const mandates = await prisma.mandate.findMany({
      orderBy: { createdAt: 'desc' },
    });

    response.status(200).json(mandates);
  } catch (error) {
    next(error);
  }
});

mandatesRouter.get('/:id/decisions', async (request, response, next) => {
  try {
    const parsed = decisionsQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      response.status(400).json({
        error: 'Invalid decision filter',
        details: validationDetails(parsed.error),
      });
      return;
    }

    const mandate = await prisma.mandate.findUnique({
      where: { id: request.params.id },
      select: { id: true },
    });

    if (!mandate) {
      response.status(404).json({ error: 'Mandate not found' });
      return;
    }

    const decisions = await prisma.decision.findMany({
      where: {
        mandateId: request.params.id,
        ...(parsed.data.since === undefined
          ? {}
          : { createdAt: { gte: parsed.data.since } }),
      },
      orderBy: { createdAt: 'desc' },
      take: parsed.data.limit,
    });

    response.status(200).json(
      decisions.map((decision) => ({
        ...decision,
        reasons: reasonsFromDecision(decision),
      })),
    );
  } catch (error) {
    next(error);
  }
});

mandatesRouter.get('/:id', async (request, response, next) => {
  try {
    const mandate = await prisma.mandate.findUnique({
      where: { id: request.params.id },
    });

    if (!mandate) {
      response.status(404).json({ error: 'Mandate not found' });
      return;
    }

    response.status(200).json(mandate);
  } catch (error) {
    next(error);
  }
});
