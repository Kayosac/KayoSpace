import { networkInterfaces } from 'node:os';
import { expect, test } from '@playwright/test';
import { DEV_APP_PORT, DEV_HUB_PORT, drawWave } from './env';

const HUB = `http://127.0.0.1:${DEV_HUB_PORT}`;

test('pnpm dev: локальный хаб, приложение подключено само — без токенов и ввода', async ({
  page,
  request,
}) => {
  await page.goto(`http://localhost:${DEV_APP_PORT}/`);
  await page.waitForFunction(() => (window as { __kayospace?: unknown }).__kayospace);
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await expect(page.getByTestId('connect-screen')).toHaveCount(0);

  // Хаб без токена: ни приложению, ни нам ключ не нужен.
  const health = await (await request.get(`${HUB}/health`)).json();
  expect(health).toMatchObject({ ok: true, auth: false });

  await drawWave(page, 300, 300);
  await expect
    .poll(async () => {
      const boards = (await (await request.get(`${HUB}/api/boards`)).json()) as {
        id: string;
        elements: number;
      }[];
      return boards.find((b) => b.id === 'main')?.elements ?? 0;
    })
    .toBe(1);

  await page.getByRole('button', { name: 'Настройки' }).click();
  await expect(page.getByTestId('hub-info')).toContainText('Локальный хаб разработки');
  await expect(page.getByTestId('hub-info')).toContainText(HUB);
});

test('pnpm dev: хаб слушает только 127.0.0.1', async () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  test.skip(lan.length === 0, 'у машины нет сетевых адресов кроме 127.0.0.1');
  for (const ip of lan) {
    const reached = await fetch(`http://${ip}:${DEV_HUB_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      () => true,
      () => false,
    );
    expect(reached, `хаб виден по ${ip}`).toBe(false);
  }
});
