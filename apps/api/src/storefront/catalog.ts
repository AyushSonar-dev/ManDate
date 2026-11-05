import { readFileSync } from 'node:fs';
import { z } from 'zod';

const merchantSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  domains: z.array(z.string().trim().min(1)).min(1),
});

const itemSchema = z.object({
  id: z.string().trim().min(1),
  merchantId: z.string().trim().min(1),
  category: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string(),
  priceMinorUnits: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  inStock: z.boolean(),
  reviews: z.array(z.string()),
});

const catalogSchema = z
  .object({
    merchants: z.array(merchantSchema).min(3),
    items: z.array(itemSchema).min(12),
  })
  .superRefine((catalog, context) => {
    const merchantIds = new Set(catalog.merchants.map((merchant) => merchant.id));
    const itemIds = new Set<string>();

    for (const [index, item] of catalog.items.entries()) {
      if (!merchantIds.has(item.merchantId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'merchantId'],
          message: `Unknown merchant "${item.merchantId}"`,
        });
      }

      if (itemIds.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'id'],
          message: `Duplicate item id "${item.id}"`,
        });
      }

      itemIds.add(item.id);
    }
  });

export type CatalogData = z.infer<typeof catalogSchema>;

const CATALOG_URL = new URL('../../data/catalog.json', import.meta.url);

export const CATALOG: CatalogData = catalogSchema.parse(
  JSON.parse(readFileSync(CATALOG_URL, 'utf8')) as unknown,
);

export function merchantName(merchantId: string): string {
  return (
    CATALOG.merchants.find((merchant) => merchant.id === merchantId)?.name ??
    merchantId
  );
}

export function catalogRetailerMap(): Record<string, string> {
  const map: Record<string, string> = {};

  for (const merchant of CATALOG.merchants) {
    for (const domain of merchant.domains) {
      map[domain.toLowerCase()] = merchant.id;
    }
  }

  return map;
}
