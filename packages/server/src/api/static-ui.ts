import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Context } from 'hono';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export function serveUi(uiDirectory: string | null) {
  return (context: Context) => {
    if (!uiDirectory || !existsSync(uiDirectory)) {
      return context.text('The chat-explorer UI is not built.', 500);
    }
    const requested = normalize(join(uiDirectory, decodeURIComponent(context.req.path)));
    const isInside = requested.startsWith(uiDirectory);
    const isFile = isInside && existsSync(requested) && statSync(requested).isFile();
    const file = isFile ? requested : join(uiDirectory, 'index.html');
    const contentType = contentTypes[extname(file)] ?? 'application/octet-stream';
    const cacheControl = file.includes(`${join(uiDirectory, 'assets')}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    return context.body(readFileSync(file), 200, {
      'content-type': contentType,
      'cache-control': cacheControl,
    });
  };
}
