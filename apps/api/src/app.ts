import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  logger?: boolean;
}

/** Builds the Fastify instance without listening, so tests can drive it with inject(). */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
