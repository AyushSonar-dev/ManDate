import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

const app = createApp();
const testMerchant = 'mandates-test-merchant';
const otherMerchant = 'mandates-test-merchant-other';

function validMandate(overrides: Record<string, unknown> = {}) {
  return {
    totalBudgetMinorUnits: 100_000,
    perPurchaseCapMinorUnits: 20_000,
    approvalThresholdMinorUnits: 10_000,
    currency: 'usd',
    allowedMerchants: [testMerchant, otherMerchant],
    allowedCategories: ['books', 'electronics'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  await prisma.mandate.deleteMany({
    where: {
      allowedMerchants: {
        has: testMerchant,
      },
    },
  });
}

beforeAll(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('POST /mandates', () => {
  it('creates a mandate and returns integer minor-unit money fields', async () => {
    const body = validMandate();

    const response = await request(app).post('/mandates').send(body);

    expect(response.status).toBe(201);
    expect(response.body.id).toEqual(expect.any(String));
    expect(response.body.totalBudgetMinorUnits).toBe(body.totalBudgetMinorUnits);
    expect(response.body.perPurchaseCapMinorUnits).toBe(body.perPurchaseCapMinorUnits);
    expect(response.body.approvalThresholdMinorUnits).toBe(body.approvalThresholdMinorUnits);
    expect(response.body.currency).toBe('USD');
    expect(response.body.allowedMerchants).toEqual(body.allowedMerchants);
    expect(response.body.allowedCategories).toEqual(body.allowedCategories);
    expect(new Date(response.body.expiresAt).toISOString()).toBe(body.expiresAt);
  });

  it.each([
    ['per-purchase cap above total budget', { perPurchaseCapMinorUnits: 100_001 }, 'perPurchaseCapMinorUnits'],
    ['approval threshold above per-purchase cap', { approvalThresholdMinorUnits: 20_001 }, 'approvalThresholdMinorUnits'],
    ['expiry in the past', { expiresAt: new Date(Date.now() - 1_000).toISOString() }, 'expiresAt'],
    ['expiry that is not a date', { expiresAt: 'not-a-date' }, 'expiresAt'],
    ['currency shorter than 3 letters', { currency: 'US' }, 'currency'],
    ['currency longer than 3 letters', { currency: 'USDD' }, 'currency'],
    ['empty merchant allowlist', { allowedMerchants: [] }, 'allowedMerchants'],
    ['empty category allowlist', { allowedCategories: [] }, 'allowedCategories'],
    ['non-integer money amount', { totalBudgetMinorUnits: 100.5 }, 'totalBudgetMinorUnits'],
  ])('rejects %s', async (_name, overrides, expectedPath) => {
    const response = await request(app)
      .post('/mandates')
      .send(validMandate(overrides));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid mandate');
    expect(response.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expectedPath }),
      ]),
    );
  });
});

describe('GET /mandates', () => {
  it('lists created mandates', async () => {
    const created = await request(app).post('/mandates').send(validMandate());

    const response = await request(app).get('/mandates');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.body.id }),
      ]),
    );
  });
});

describe('GET /mandates/:id', () => {
  it('returns a mandate by id', async () => {
    const created = await request(app).post('/mandates').send(validMandate());

    const response = await request(app).get(`/mandates/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(created.body);
  });

  it('returns 404 for an unknown mandate', async () => {
    const response = await request(app).get('/mandates/00000000-0000-0000-0000-000000000000');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Mandate not found' });
  });
});
