import Fastify from 'fastify';

import { healthResponseSchema } from '@branchwork/contracts';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/health', () =>
    healthResponseSchema.parse({
      service: 'branchwork-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }),
  );

  return app;
}
