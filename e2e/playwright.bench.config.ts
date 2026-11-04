import { defineConfig, devices } from '@playwright/test';
import { BENCH_PORT } from './tests/env';

/**
 * Замер скорости холста на доске из 20 000 объектов (шаг 1.7):
 *   pnpm --filter @kayospace/e2e e2e:bench
 * Стенд — apps/workspace/bench.html на дев-сервере Vite (в сборку приложения не входит).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'bench.spec.ts',
  outputDir: './test-results-bench',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ...(process.env.E2E_CHROME_CHANNEL ? { channel: process.env.E2E_CHROME_CHANNEL } : {}),
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `pnpm --filter @kayospace/workspace exec vite --port ${BENCH_PORT} --strictPort`,
    url: `http://localhost:${BENCH_PORT}/bench.html`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
