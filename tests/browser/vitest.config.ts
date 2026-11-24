/**
 * Browser tests (task T2.8, R15.10, R9.3): Vitest browser mode drives Playwright Chromium, so the
 * same canonical vectors and the same storage conformance suite run inside a real browser.
 *
 *   npx playwright install chromium
 *   npx vitest run -c tests/browser/vitest.config.ts
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: p('../..'),
  resolve: {
    alias: [
      { find: '@weave/core/protocol', replacement: p('../../packages/core/src/protocol.ts') },
      { find: '@weave/core', replacement: p('../../packages/core/src/index.ts') },
      {
        find: '@weave/storage/memory',
        replacement: p('../../packages/storage/src/memory/index.ts'),
      },
      {
        find: '@weave/storage/indexeddb',
        replacement: p('../../packages/storage/src/indexeddb/index.ts'),
      },
    ],
  },
  test: {
    include: ['tests/browser/**/*.browser.test.ts'],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
      screenshotFailures: false,
    },
  },
});
