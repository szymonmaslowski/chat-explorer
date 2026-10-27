import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = 4519;
const home = join(tmpdir(), 'chat-explorer-e2e');
const server = '../server/dist';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: 'chrome',
    viewport: { width: 1100, height: 700 },
  },
  webServer: {
    command: `rm -rf "${home}" && node ${server}/dev/seed.js && node ${server}/daemon/main.js`,
    url: `http://127.0.0.1:${port}/api/health`,
    // Without `claude` on PATH, background sessions fail to start instead of running Claude.
    env: {
      CHAT_EXPLORER_HOME: home,
      CHAT_EXPLORER_PORT: String(port),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    reuseExistingServer: false,
  },
});
