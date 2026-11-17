import { defineConfig } from 'vitest/config';

// Tests read the other packages' sources, as type checks do, so nothing has to be built first.
const conditions = ['chat-explorer-source', 'module', 'node'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
