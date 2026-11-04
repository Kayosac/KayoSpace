import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_APP_PORT, DEV_HUB_PORT } from './tests/env';

/**
 * Режим разработки: `pnpm dev` с нуля (свой локальный хаб на 127.0.0.1, приложение подключается само).
 *   pnpm --filter @kayospace/e2e e2e:dev
 * Порты отдельные от обычных проверок; данные хаба — во временной папке.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'kayospace-dev-e2e-'));

export default defineConfig({
  testDir: './tests',
  testMatch: 'dev.spec.ts',
  outputDir: './test-results-dev',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ...(process.env.E2E_CHROME_CHANNEL ? { channel: process.env.E2E_CHROME_CHANNEL } : {}),
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'node ../scripts/dev.mjs',
    url: `http://localhost:${DEV_APP_PORT}`,
    env: {
      KAYOSPACE_DEV_HUB_PORT: String(DEV_HUB_PORT),
      KAYOSPACE_DEV_PORT: String(DEV_APP_PORT),
      KAYOSPACE_DEV_DATA: dataDir,
      // Настоящий токен в окружении не должен попасть в локальный хаб.
      HUB_TOKEN: 'must-be-ignored',
    },
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
