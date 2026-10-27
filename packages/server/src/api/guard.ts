import { createMiddleware } from 'hono/factory';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// Blocks DNS rebinding (foreign Host) and other websites posting to the daemon (foreign Origin).
export function guardLocalRequests(port: number) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));
  return createMiddleware(async (context, next) => {
    const host = context.req.header('host');
    if (!host || !allowedHosts.has(host)) return context.text('Forbidden host', 403);
    const origin = context.req.header('origin');
    if (!safeMethods.has(context.req.method) && origin && !allowedOrigins.has(origin)) {
      return context.text('Forbidden origin', 403);
    }
    await next();
  });
}
