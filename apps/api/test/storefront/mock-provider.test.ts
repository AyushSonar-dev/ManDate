import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/storefront/catalog.js';
import { MockStorefrontProvider } from '../../src/storefront/mock-provider.js';

describe('mock storefront catalog', () => {
  const provider = new MockStorefrontProvider();

  it('has three categorized merchants and twelve integer-priced items', () => {
    expect(CATALOG.merchants).toHaveLength(3);
    expect(CATALOG.items).toHaveLength(12);

    for (const merchant of CATALOG.merchants) {
      expect(merchant.id.length).toBeGreaterThan(0);
      expect(merchant.category.length).toBeGreaterThan(0);
    }

    for (const item of CATALOG.items) {
      expect(Number.isInteger(item.priceMinorUnits)).toBe(true);
      expect(item.priceMinorUnits).toBeGreaterThan(0);
    }
  });

  it('finds wireless headphones under forty dollars', async () => {
    const results = await provider.search(
      'buy wireless headphones under 40 dollars',
    );

    expect(results[0]).toMatchObject({
      id: 'soundhouse-headphones',
      title: 'Aurora Wireless Headphones',
      merchantId: 'soundhouse',
      category: 'electronics',
      priceMinorUnits: 3900,
      currency: 'USD',
    });
  });

  it('filters by maxPriceMinorUnits', async () => {
    const results = await provider.search('wireless', {
      maxPriceMinorUnits: 3000,
    });

    expect(results.map((item) => item.id)).toContain('soundhouse-earbuds');
    expect(results.map((item) => item.id)).not.toContain(
      'soundhouse-headphones',
    );
  });

  it('returns item details and treats catalog text as data', async () => {
    const item = await provider.getItem('urbanfit-travel-kit');

    expect(item?.description).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(item?.reviews[1]).toContain('unlock-deals.example');
  });

  it('finds an item by exact title and returns null for unknown items', async () => {
    await expect(
      provider.findByTitle('Aurora Wireless Headphones'),
    ).resolves.toMatchObject({ id: 'soundhouse-headphones' });
    await expect(provider.findByTitle('Imaginary Product')).resolves.toBeNull();
    await expect(provider.getItem('missing-item')).resolves.toBeNull();
  });
});
