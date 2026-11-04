import { Router } from 'express';
import type { ZodError } from 'zod';
import { prisma } from '../db/prisma.js';
import { createMandateSchema } from '../mandates/schema.js';

export const mandatesRouter = Router();

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
