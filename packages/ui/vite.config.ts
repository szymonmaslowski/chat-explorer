import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

const daemonUrl = `http://127.0.0.1:${process.env.CHAT_EXPLORER_PORT ?? 4517}`;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../server/src/shared', import.meta.url)),
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
