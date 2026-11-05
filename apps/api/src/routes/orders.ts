import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { getOrderReceipt } from '../orders/receipt.js';

export function createOrdersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/:id/receipt', async (request, response, next) => {
    try {
      const receipt = await getOrderReceipt(prisma, request.params.id);

      if (!receipt) {
        response.status(404).json({ error: 'Order not found' });
        return;
      }

      response.status(200).json(receipt);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
