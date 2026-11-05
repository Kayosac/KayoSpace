import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUB_PORT, HUB_TOKEN } from './tests/env';

/**
 * Проверки в настоящем браузере (Chromium). Перед запуском соберите приложения:
 *   pnpm --filter @kayospace/pen-lab build && pnpm --filter @kayospace/workspace build
 *   pnpm --filter @kayospace/e2e e2e
 * Хаб поднимается на время тестов с временной папкой данных и токеном.
 */

const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'kayospace-e2e-'));

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  // Режим разработки и замер скорости — отдельно: playwright.dev.config.ts, playwright.bench.config.ts.
  testIgnore: ['dev.spec.ts', 'bench.spec.ts'],
  use: {
    ...devices['Desktop Chrome'],
    // Установленный Chrome вместо скачанного Chromium: E2E_CHROME_CHANNEL=chrome.
    ...(process.env.E2E_CHROME_CHANNEL ? { channel: process.env.E2E_CHROME_CHANNEL } : {}),
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // Поддельный микрофон — для проверки голоса без устройства и без вопроса о разрешении.
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  webServer: [
    {
      command: 'pnpm --filter @kayospace/hub start',
      url: `http://127.0.0.1:${HUB_PORT}/health`,
      env: {
        PORT: String(HUB_PORT),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        HUB_TOKEN,
        HISTORY_QUIET_MS: '300',
        HISTORY_GAP_MS: '0',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @kayospace/pen-lab exec vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm --filter @kayospace/workspace exec vite preview --port 4174 --strictPort',
      url: 'http://localhost:4174',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
