import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

// Tests import workspace packages by name; map them to source so tests need no build step.
export default defineConfig({
  resolve: {
    alias: [
      { find: '@weave/core/protocol', replacement: p('./packages/core/src/protocol.ts') },
      { find: '@weave/core', replacement: p('./packages/core/src/index.ts') },
      { find: '@weave/storage/memory', replacement: p('./packages/storage/src/memory/index.ts') },
      { find: '@weave/storage/file', replacement: p('./packages/storage/src/file/index.ts') },
      {
        find: '@weave/storage/indexeddb',
        replacement: p('./packages/storage/src/indexeddb/index.ts'),
      },
      {
        find: '@weave/transport/in-process',
        replacement: p('./packages/transport/src/in-process/index.ts'),
      },
      { find: '@weave/transport/http', replacement: p('./packages/transport/src/http/index.ts') },
      { find: '@weave/relay', replacement: p('./packages/relay/src/index.ts') },
      { find: '@weave/testing', replacement: p('./packages/testing/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/browser/**', 'apps/*/test/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
