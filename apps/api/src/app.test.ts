import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

const app = buildApp();

afterAll(async () => app.close());

describe('health endpoint', () => {
  it('reports a healthy service using the shared contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: 'branchwork-api',
      status: 'ok',
    });
  });
});
