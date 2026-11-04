import { z } from 'zod';

const minorUnitsSchema = z.number().int();

export const createMandateSchema = z
  .object({
    totalBudgetMinorUnits: minorUnitsSchema.positive(),
    perPurchaseCapMinorUnits: minorUnitsSchema.positive(),
    approvalThresholdMinorUnits: minorUnitsSchema.nonnegative(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter code')
      .transform((value) => value.toUpperCase()),
    allowedMerchants: z.array(z.string().trim().min(1)).min(1, 'allowedMerchants must not be empty'),
    allowedCategories: z.array(z.string().trim().min(1)).min(1, 'allowedCategories must not be empty'),
    expiresAt: z.coerce
      .date()
      .refine((value) => value.getTime() > Date.now(), 'expiresAt must be in the future'),
  })
  .superRefine((mandate, context) => {
    if (mandate.perPurchaseCapMinorUnits > mandate.totalBudgetMinorUnits) {
      context.addIssue({
        code: 'custom',
        path: ['perPurchaseCapMinorUnits'],
        message: 'perPurchaseCapMinorUnits must not exceed totalBudgetMinorUnits',
      });
    }

    if (mandate.approvalThresholdMinorUnits > mandate.perPurchaseCapMinorUnits) {
      context.addIssue({
        code: 'custom',
        path: ['approvalThresholdMinorUnits'],
        message: 'approvalThresholdMinorUnits must not exceed perPurchaseCapMinorUnits',
      });
    }
  });

export type CreateMandateInput = z.infer<typeof createMandateSchema>;
