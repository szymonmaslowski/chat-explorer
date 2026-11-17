import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Writes the service worker with the app's files of this build and a version that changes with
// any of them, so the browser installs a new worker for a new build.
function serviceWorker(): Plugin {
  return {
    name: 'chat-explorer-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const publicFiles = readdirSync(new URL('public', import.meta.url));
      const builtFiles = Object.keys(bundle).filter((name) => name !== 'index.html');
      const hash = createHash('sha256');
      for (const name of [...builtFiles].sort()) hash.update(name);
      for (const name of [...publicFiles].sort()) {
        hash.update(readFileSync(new URL(`public/${name}`, import.meta.url)));
      }
      const appFiles = [
        '/',
        ...publicFiles.map((name) => `/${name}`),
        ...builtFiles.map((name) => `/${name}`),
      ];
      const source = readFileSync(new URL('service-worker/sw.js', import.meta.url), 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 16))
        .replace('__APP_FILES__', JSON.stringify(appFiles));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

const daemonUrl = `http://127.0.0.1:${process.env.CHAT_EXPLORER_PORT ?? 4517}`;

export default defineConfig({
  plugins: [vue(), serviceWorker()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // The daemon rejects foreign Host and Origin headers, so the dev proxy presents itself as the daemon.
      '/api': {
        target: daemonUrl,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            if (request.getHeader('origin')) request.setHeader('origin', daemonUrl);
          });
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
