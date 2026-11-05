import type { PrismaClient } from '@prisma/client';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  createApprovalService,
  type ApprovalService,
} from './approvals/service.js';
import { prisma } from './db/prisma.js';
import type { PaypalOrders } from './paypal/orders.js';
import { healthRouter } from './routes/health.js';
import { mandatesRouter } from './routes/mandates.js';
import { createApprovalsRouter } from './routes/approvals.js';
import { createOrdersRouter } from './routes/orders.js';

export interface AppDependencies {
  prisma?: PrismaClient;
  paypalOrders?: PaypalOrders;
  approvalService?: ApprovalService;
  appBaseUrl?: string;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  const prismaClient = dependencies.prisma ?? prisma;
  const approvalService =
    dependencies.approvalService ??
    (dependencies.paypalOrders === undefined
      ? null
      : createApprovalService({
          prisma: prismaClient,
          paypalOrders: dependencies.paypalOrders,
          ...(dependencies.appBaseUrl === undefined
            ? {}
            : { appBaseUrl: dependencies.appBaseUrl }),
        }));

  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/health', healthRouter);
  app.use('/mandates', mandatesRouter);
  app.use('/orders', createOrdersRouter(prismaClient));

  if (approvalService !== null) {
    app.use('/approvals', createApprovalsRouter(approvalService));
  }

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      console.error(error);
      response.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
