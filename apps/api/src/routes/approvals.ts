import { ApprovalStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import type { ApprovalService } from '../approvals/service.js';

const resolveApprovalSchema = z.object({
  approvedBy: z.string().trim().min(1).max(120).default('buyer'),
});

const rejectApprovalSchema = z.object({
  rejectedBy: z.string().trim().min(1).max(120).default('buyer'),
});

const listApprovalsSchema = z.object({
  status: z.nativeEnum(ApprovalStatus).optional(),
});

function approvalSummary(approval: {
  id: string;
  orderId: string | null;
  mandateId: string;
  status: ApprovalStatus;
  reason: string | null;
  resolvedBy: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
}) {
  return {
    id: approval.id,
    orderId: approval.orderId,
    mandateId: approval.mandateId,
    status: approval.status,
    reason: approval.reason,
    approvedBy: approval.resolvedBy,
    resolvedBy: approval.resolvedBy,
    requestedAt: approval.requestedAt,
    resolvedAt: approval.resolvedAt,
  };
}

export function createApprovalsRouter(service: ApprovalService): Router {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const parsed = listApprovalsSchema.safeParse(request.query);

      if (!parsed.success) {
        response.status(400).json({
          error: 'Invalid approval filter',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }

      const approvals = await service.list(parsed.data.status);

      response.status(200).json(approvals.map(approvalSummary));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/approve', async (request, response, next) => {
    try {
      const parsed = resolveApprovalSchema.safeParse(request.body ?? {});

      if (!parsed.success) {
        response.status(400).json({
          error: 'Invalid approval',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }

      const outcome = await service.approve(request.params.id, parsed.data);

      switch (outcome.kind) {
        case 'not_found':
          response.status(404).json({ error: 'Approval not found' });
          return;
        case 'conflict':
          response.status(409).json({
            error: outcome.message,
            approval: approvalSummary(outcome.approval),
            orderId: outcome.order?.id ?? null,
          });
          return;
        case 'blocked':
          response.status(403).json({
            status: 'DENIED',
            verdict: outcome.result.verdict,
            reasons: outcome.result.reasons,
            approval: approvalSummary(outcome.approval),
            orderId: outcome.order.id,
          });
          return;
        case 'pending_buyer_approval':
          response.status(202).json({
            status: 'PENDING_BUYER_APPROVAL',
            message: outcome.message,
            approval: approvalSummary(outcome.approval),
            orderId: outcome.order.id,
            paypalOrderId: outcome.paypalOrderId,
            approvalLink: outcome.approvalLink ?? null,
          });
          return;
        case 'captured':
          response.status(200).json({
            status: 'CAPTURED',
            approval: approvalSummary(outcome.approval),
            order: outcome.order,
            mandate: outcome.mandate,
            paypalOrderId: outcome.order.paypalOrderId,
            captureId: outcome.capture.captureId ?? outcome.order.captureId,
          });
          return;
        case 'paypal_error':
          response.status(502).json({
            status: 'PAYPAL_ERROR',
            error: outcome.message,
            approval: approvalSummary(outcome.approval),
            orderId: outcome.order.id,
          });
          return;
      }
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/reject', async (request, response, next) => {
    try {
      const parsed = rejectApprovalSchema.safeParse(request.body ?? {});

      if (!parsed.success) {
        response.status(400).json({
          error: 'Invalid rejection',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }

      const outcome = await service.reject(request.params.id, parsed.data);

      switch (outcome.kind) {
        case 'not_found':
          response.status(404).json({ error: 'Approval not found' });
          return;
        case 'conflict':
          response.status(409).json({
            error: outcome.message,
            approval: approvalSummary(outcome.approval),
            orderId: outcome.order?.id ?? null,
          });
          return;
        case 'rejected':
          response.status(200).json({
            status: 'DENIED',
            approval: approvalSummary(outcome.approval),
            order: outcome.order,
          });
          return;
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}
