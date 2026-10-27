import { createMiddleware } from 'hono/factory';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// Blocks DNS rebinding (foreign Host) and other websites posting to the daemon (foreign Origin).
export function guardLocalRequests(port: number, publicUrl: string | null) {
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedHosts = new Set(localHosts);
  const allowedOrigins = new Set(localHosts.map((host) => `http://${host}`));
  if (publicUrl) {
    allowedHosts.add(new URL(publicUrl).host);
    allowedOrigins.add(publicUrl);
  }
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
