import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { requestStoreFor } from '../store/requests.js';
import type { RunStore } from '../store/runs.js';
import type { ChatStore } from '../store/store.js';
import { registerJobTools } from './job-tools.js';

// What coding containers reach, on a port of its own: the job tools and nothing else. The port a
// request arrives on decides what it can reach, which a container can't forge, unlike a Host
// header or a path. Every other route answers 404 here.
export function createToolsApp(options: { store: ChatStore; runs: RunStore; toolsPort: number }) {
  const app = new Hono();
  // Defence in depth only: each tool call needs the token of a live lease.
  const allowedHosts = new Set([
    `host.docker.internal:${options.toolsPort}`,
    `127.0.0.1:${options.toolsPort}`,
  ]);
  app.use(
    '*',
    createMiddleware(async (context, next) => {
      const host = context.req.header('host');
      if (!host || !allowedHosts.has(host)) return context.text('Forbidden host', 403);
      await next();
    }),
  );
  // The coordinator's request tools and the notes requests are job tools too.
  registerJobTools(app, {
    store: options.store,
    runs: options.runs,
    requests: requestStoreFor(options.store, options.runs),
  });
  app.notFound((context) => context.json({ error: 'not_found', message: 'Not found.' }, 404));
  app.onError((error, context) => {
    console.error(error);
    return context.json({ error: 'internal', message: 'Internal error' }, 500);
  });
  return app;
}
