import { randomUUID } from 'node:crypto';
import { AttackRunStatus, DecisionVerdict } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../src/agent/service.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

const markers: string[] = [];

function newMarker(): string {
  const marker = `ui-api-test-${randomUUID()}`;
  markers.push(marker);
  return marker;
}

async function createMandate(marker: string) {
  return prisma.mandate.create({
    data: {
      totalBudgetMinorUnits: 100_000,
      perPurchaseCapMinorUnits: 20_000,
      approvalThresholdMinorUnits: 10_000,
      currency: 'USD',
      allowedMerchants: [marker],
      allowedCategories: ['books'],
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

async function cleanup(marker: string): Promise<void> {
  const mandates = await prisma.mandate.findMany({
    where: { allowedMerchants: { has: marker } },
    select: { id: true },
  });
  const mandateIds = mandates.map((mandate) => mandate.id);

  await prisma.attackRun.deleteMany({
    where: { name: { startsWith: `ui-api:${marker}:` } },
  });
  await prisma.agentRun.deleteMany({
    where: { mandateId: { in: mandateIds } },
  });
  await prisma.mandate.deleteMany({
    where: { id: { in: mandateIds } },
  });
}

afterEach(async () => {
  await Promise.all(markers.splice(0).map(cleanup));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /mandates/:id/decisions', () => {
  it('returns newest decisions with normalized reasons', async () => {
    const marker = newMarker();
    const mandate = await createMandate(marker);
    await prisma.decision.create({
      data: {
        mandateId: mandate.id,
        verdict: DecisionVerdict.ALLOW,
        reason: DecisionVerdict.ALLOW,
        toolName: 'create_order',
        requestPayload: { sequence: 1 },
        createdAt: new Date('2026-11-06T10:00:00.000Z'),
      },
    });
    const newest = await prisma.decision.create({
      data: {
        mandateId: mandate.id,
        verdict: DecisionVerdict.BLOCK,
        reason: 'MERCHANT_NOT_ALLOWED,CATEGORY_NOT_ALLOWED',
        toolName: 'create_order',
        requestPayload: { sequence: 2 },
        createdAt: new Date('2026-11-06T10:01:00.000Z'),
      },
    });

    const response = await request(createApp()).get(
      `/mandates/${mandate.id}/decisions?limit=1`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({
        id: newest.id,
        verdict: 'BLOCK',
        toolName: 'create_order',
        reasons: ['MERCHANT_NOT_ALLOWED', 'CATEGORY_NOT_ALLOWED'],
        requestPayload: { sequence: 2 },
      }),
    ]);
  });

  it('filters decisions by since and rejects invalid queries', async () => {
    const marker = newMarker();
    const mandate = await createMandate(marker);
    await prisma.decision.createMany({
      data: [
        {
          mandateId: mandate.id,
          verdict: DecisionVerdict.ALLOW,
          reason: DecisionVerdict.ALLOW,
          toolName: 'create_order',
          createdAt: new Date('2026-11-06T09:00:00.000Z'),
        },
        {
          mandateId: mandate.id,
          verdict: DecisionVerdict.BLOCK,
          reason: 'MERCHANT_NOT_ALLOWED',
          toolName: 'create_order',
          createdAt: new Date('2026-11-06T11:00:00.000Z'),
        },
      ],
    });

    const filtered = await request(createApp()).get(
      `/mandates/${mandate.id}/decisions?since=2026-11-06T10:00:00.000Z`,
    );

    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].verdict).toBe('BLOCK');

    const invalid = await request(createApp()).get(
      `/mandates/${mandate.id}/decisions?since=not-a-date`,
    );

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Invalid decision filter');
  });

  it('returns 404 for an unknown mandate', async () => {
    const response = await request(createApp()).get(
      '/mandates/00000000-0000-0000-0000-000000000000/decisions',
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Mandate not found' });
  });
});

describe('GET /scorecard/latest', () => {
  it('returns the most recent attack run', async () => {
    const marker = newMarker();
    await prisma.attackRun.create({
      data: {
        name: `ui-api:${marker}:older`,
        status: AttackRunStatus.PASSED,
        totalScenarios: 1,
        passedScenarios: 1,
        startedAt: new Date('2098-01-01T00:00:00.000Z'),
        completedAt: new Date('2098-01-01T00:00:01.000Z'),
        results: { setName: 'core', totalScenarios: 1, passedScenarios: 1 },
      },
    });
    const latest = await prisma.attackRun.create({
      data: {
        name: `ui-api:${marker}:latest`,
        status: AttackRunStatus.FAILED,
        totalScenarios: 2,
        passedScenarios: 1,
        startedAt: new Date('2099-01-01T00:00:00.000Z'),
        completedAt: new Date('2099-01-01T00:00:01.000Z'),
        results: {
          setName: 'heldout',
          totalScenarios: 2,
          passedScenarios: 1,
          categories: [{ category: 'spend_limits', passed: 1, total: 2 }],
          scenarios: [],
        },
      },
    });

    const response = await request(createApp()).get('/scorecard/latest');

    expect(response.status).toBe(200);
    expect(response.body.latest).toMatchObject({
      id: latest.id,
      status: 'FAILED',
      totalScenarios: 2,
      passedScenarios: 1,
    });
  });
});

async function waitForRunStatus(
  app: ReturnType<typeof createApp>,
  runId: string,
  expected: 'COMPLETED' | 'FAILED',
) {
  let lastStatus = '';

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/agent/runs/${runId}`);

    if (response.status === 200) {
      lastStatus = response.body.status;

      if (lastStatus === expected) {
        return response;
      }

      if (lastStatus === 'COMPLETED' || lastStatus === 'FAILED') {
        return response;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Agent run did not finish; last status was ${lastStatus}`);
}

describe('POST /agent/runs', () => {
  it('returns 202 immediately and completes the run in the background', async () => {
    const marker = newMarker();
    const mandate = await createMandate(marker);
    const calls: Array<{
      mandateId: string;
      prompt: string;
      runId: string;
    }> = [];
    const runner: AgentRunner = {
      async run(input) {
        if (input.runId === undefined) {
          throw new Error('Expected the run id to be provided');
        }

        calls.push({
          mandateId: input.mandateId,
          prompt: input.prompt,
          runId: input.runId,
        });
        await prisma.decision.create({
          data: {
            mandateId: input.mandateId,
            runId: input.runId,
            verdict: DecisionVerdict.ALLOW,
            reason: DecisionVerdict.ALLOW,
            toolName: 'create_order',
          },
        });
        return { text: 'Agent finished', steps: [] };
      },
    };
    const app = createApp({ agentRunner: runner });

    const response = await request(app).post('/agent/runs').send({
      mandateId: mandate.id,
      prompt: 'Buy one book',
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: 'RUNNING',
      run_id: response.body.runId,
    });
    expect(typeof response.body.runId).toBe('string');

    const finished = await waitForRunStatus(app, response.body.runId, 'COMPLETED');

    expect(finished.body).toMatchObject({
      id: response.body.runId,
      status: 'COMPLETED',
      result: 'Agent finished',
      error: null,
    });
    expect(finished.body.decisions).toHaveLength(1);
    expect(finished.body.decisions[0]).toMatchObject({
      runId: response.body.runId,
      verdict: 'ALLOW',
    });
    expect(calls).toEqual([
      {
        mandateId: mandate.id,
        prompt: 'Buy one book',
        runId: response.body.runId,
      },
    ]);
  });

  it('marks a failed run with a readable reason', async () => {
    const marker = newMarker();
    const mandate = await createMandate(marker);
    const runner: AgentRunner = {
      async run() {
        throw new Error('model provider unavailable');
      },
    };
    const app = createApp({ agentRunner: runner });

    const response = await request(app).post('/agent/runs').send({
      mandateId: mandate.id,
      prompt: 'Buy one book',
    });

    expect(response.status).toBe(202);

    const finished = await waitForRunStatus(app, response.body.runId, 'FAILED');

    expect(finished.body).toMatchObject({
      id: response.body.runId,
      status: 'FAILED',
      result: null,
      error: 'model provider unavailable',
      decisions: [],
    });
  });

  it('validates the request and reports an unconfigured runner', async () => {
    const runner: AgentRunner = {
      async run() {
        return { text: '', steps: [] };
      },
    };
    const configured = createApp({ agentRunner: runner });

    const invalid = await request(configured)
      .post('/agent/runs')
      .send({ mandateId: 'not-a-uuid', prompt: '' });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('Invalid agent run');

    const unavailable = await request(createApp())
      .post('/agent/runs')
      .send({ mandateId: randomUUID(), prompt: 'Buy one book' });

    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ error: 'Agent runner is not configured' });
  });
});

describe('GET /agent/runs/:id', () => {
  it('rejects an invalid id and returns 404 for an unknown run', async () => {
    const invalid = await request(createApp()).get('/agent/runs/not-a-uuid');

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'Invalid agent run id' });

    const unknown = await request(createApp()).get(
      '/agent/runs/00000000-0000-0000-0000-000000000000',
    );

    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'Agent run not found' });
  });
});
