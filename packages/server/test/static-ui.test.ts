import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { serveUi } from '../src/api/static-ui.js';

function uiApp() {
  const directory = mkdtempSync(join(tmpdir(), 'chat-explorer-ui-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html>');
  writeFileSync(join(directory, 'assets', 'index.js'), '');
  const app = new Hono();
  app.get('*', serveUi(directory));
  return app;
}

describe('serving the UI', () => {
  it('sends a Content-Security-Policy that allows nothing from other hosts', async () => {
    const app = uiApp();
    for (const path of ['/e/chat_x', '/assets/index.js']) {
      const policy = (await app.request(path)).headers.get('content-security-policy');
      expect(policy).toContain("script-src 'self';");
      expect(policy).toContain("style-src 'self';");
      expect(policy).not.toContain('unsafe');
      expect(policy).toContain("img-src 'self' data: blob:;");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toMatch(/https?:|\*/);
    }
  });
});
