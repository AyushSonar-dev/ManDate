import { describe, expect, it } from 'vitest';
import { createStorefrontOrderContextResolver } from '../../src/agent/order-context.js';
import { MockStorefrontProvider } from '../../src/storefront/mock-provider.js';

describe('createStorefrontOrderContextResolver', () => {
  const provider = new MockStorefrontProvider();
  const resolve = createStorefrontOrderContextResolver(provider, 'mandate-1');

  it('derives merchant and category from exact catalog item titles', async () => {
    await expect(
      resolve({
        items: [
          {
            name: 'Aurora Wireless Headphones',
            quantity: 1,
            itemCost: 39,
            itemTotal: 39,
          },
        ],
      }),
    ).resolves.toEqual({
      mandateId: 'mandate-1',
      merchant: 'soundhouse',
      category: 'electronics',
    });
  });

  it('fails closed to an unresolved context for an unknown title', async () => {
    await expect(
      resolve({
        items: [
          {
            name: 'Imaginary Product',
            quantity: 1,
            itemCost: 1,
            itemTotal: 1,
          },
        ],
      }),
    ).resolves.toMatchObject({
      mandateId: 'mandate-1',
      merchant: '__unresolved_catalog_item__',
      category: '__unresolved_catalog_item__',
    });
  });

  it('fails closed when a cart mixes merchants', async () => {
    await expect(
      resolve({
        items: [
          { name: 'Aurora Wireless Headphones', quantity: 1, itemCost: 39 },
          { name: 'Practical TypeScript', quantity: 1, itemCost: 28 },
        ],
      }),
    ).resolves.toMatchObject({
      merchant: '__unresolved_catalog_item__',
      category: '__unresolved_catalog_item__',
    });
  });
});
