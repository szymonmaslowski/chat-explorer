import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

const daemonUrl = `http://127.0.0.1:${process.env.CHAT_EXPLORER_PORT ?? 4517}`;

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': { target: daemonUrl, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
