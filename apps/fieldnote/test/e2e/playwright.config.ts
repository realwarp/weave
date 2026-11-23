/**
 * FIELDNOTE smoke test (task T3.F2): the real relay process plus the Vite dev server, driven in
 * Chromium.   npx playwright test -c apps/fieldnote/test/e2e
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const port = 5198;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', headless: true },
  webServer: {
    command: 'node scripts/dev.mjs fieldnote',
    cwd: root,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      WEAVE_RELAY_PORT: '8798',
      FIELDNOTE_PORT: String(port),
      WEAVE_RELAY_DATA: join(mkdtempSync(join(tmpdir(), 'fieldnote-e2e-')), 'relay'),
    },
  },
});
