import { expect, test, type Browser, type Page } from '@playwright/test';
import { HUB_ADDRESS, HUB_TOKEN, WORKSPACE_URL, drawWave, hubElements, shot } from './env';

const SETTINGS_KEY = 'kayospace.workspace.v1';

/** Открыть приложение в отдельном «устройстве» (свой профиль браузера) с заданными настройками. */
async function openDevice(
  browser: Browser,
  settings: Record<string, unknown>,
  opts: { colorScheme?: 'light' | 'dark' } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: opts.colorScheme ?? 'light',
  });
  await context.addInitScript(
    ([key, value]) => {
      // Только при первом открытии: перезагрузка страницы не должна сбрасывать настройки.
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [SETTINGS_KEY, JSON.stringify(settings)] as const,
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${settings.board}] ошибка страницы: ${e.message}`));
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  return page;
}

const synced = { hubUrl: HUB_ADDRESS, hubToken: HUB_TOKEN, syncOn: true };
const elements = (page: Page) => page.evaluate(() => window.__kayospace!.engine.scene.size);
const camera = (page: Page) => page.evaluate(() => window.__kayospace!.engine.getCamera());

declare global {
  interface Window {
    __kayospace?: {
      engine: {
        scene: { size: number };
        getCamera(): { x: number; y: number; zoom: number };
      };
      session: { getState(): { loaded: boolean; sync: string } };
    };
  }
}

test('два устройства: штрихи и отмена синхронизируются через хаб', async ({ browser, request }) => {
  const board = 'e2e-two-devices';
  const a = await openDevice(browser, { ...synced, board });
  const b = await openDevice(browser, { ...synced, board }, { colorScheme: 'dark' });
  await expect(a.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await expect(b.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');

  await drawWave(a, 400, 300);
  await expect.poll(() => elements(b)).toBe(1);
  await expect.poll(() => hubElements(request, board)).toBe(1);

  await b.getByRole('radio', { name: 'Красный' }).click();
  await b.getByRole('radio', { name: 'Толстое' }).click();
  await drawWave(b, 400, 450);
  await expect.poll(() => elements(a)).toBe(2);

  // Отмена на A убирает только свой штрих — и у B тоже.
  await a.keyboard.press('Control+z');
  await expect.poll(() => elements(a)).toBe(1);
  await expect.poll(() => elements(b)).toBe(1);
  await a.keyboard.press('Control+Shift+z');
  await expect.poll(() => elements(b)).toBe(2);

  await a.screenshot({ path: shot('workspace-light.png') });
  await b.screenshot({ path: shot('workspace-dark.png') });
});

test('навигация: масштаб колесом с Ctrl, сдвиг колесом, пробел и «показать всё»', async ({
  browser,
}) => {
  const page = await openDevice(browser, { board: 'e2e-nav' });
  await drawWave(page, 300, 300);
  const c0 = await camera(page);
  expect(c0.zoom).toBe(1);

  await page.mouse.move(640, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(1.2);
  await expect(page.getByTestId('zoom')).not.toHaveText('100%');

  const c1 = await camera(page);
  await page.mouse.wheel(120, 60);
  await expect.poll(async () => (await camera(page)).x).toBeGreaterThan(c1.x);

  const c2 = await camera(page);
  await page.keyboard.down('Space');
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(700, 450, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const c3 = await camera(page);
  expect((c2.x - c3.x) * c3.zoom).toBeCloseTo(100, 0);
  expect(await elements(page)).toBe(1); // перетаскивание с пробелом не рисует

  await page.keyboard.press('Shift+Digit1');
  await page.getByRole('button', { name: 'Показать всё' }).click();
  await page.screenshot({ path: shot('workspace-fit.png') });
});

test('офлайн: доска сохраняется на устройстве и уезжает на хаб после подключения', async ({
  browser,
  request,
}) => {
  const board = 'e2e-offline';
  const page = await openDevice(browser, { board, syncOn: false });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'off');
  await drawWave(page, 300, 300);
  await drawWave(page, 300, 450);
  await expect.poll(() => elements(page)).toBe(2);

  await page.waitForTimeout(500); // y-indexeddb пишет асинхронно
  await page.reload();
  await page.waitForFunction(() => window.__kayospace?.session.getState().loaded);
  await expect.poll(() => elements(page)).toBe(2);
  expect(await hubElements(request, board)).toBe(0);

  // Включаем синхронизацию через панель настроек.
  await page.getByTestId('sync').click();
  await page.getByLabel('Синхронизировать через хаб').check();
  await page.getByLabel('Адрес хаба').fill(HUB_ADDRESS);
  await page.getByLabel('Токен').fill(HUB_TOKEN);
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await expect.poll(() => hubElements(request, board)).toBe(2);
  await page.screenshot({ path: shot('workspace-settings.png') });
});

test('неверный токен: понятное сообщение, доска продолжает работать', async ({ browser }) => {
  const page = await openDevice(browser, { ...synced, hubToken: 'wrong', board: 'e2e-bad-token' });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'unauthorized');
  await expect(page.getByTestId('sync')).toContainText('токен');
  await drawWave(page, 300, 300);
  await expect.poll(() => elements(page)).toBe(1);
});

test('планшет: перо рисует, палец двигает холст, щипок масштабирует', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    colorScheme: 'dark',
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    SETTINGS_KEY,
    JSON.stringify({ board: 'e2e-tablet' }),
  ] as const);
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, pts: [number, number, number][]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: type as 'touchStart',
      touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })),
    });
  const pen = (type: string, x: number, y: number, force = 0.5) =>
    cdp.send('Input.dispatchMouseEvent', {
      type: type as 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      pointerType: 'pen',
      force,
    });

  await pen('mousePressed', 300, 300, 0.3);
  for (let i = 1; i <= 30; i++)
    await pen('mouseMoved', 300 + i * 10, 300 + Math.sin(i / 4) * 50, 0.2 + i / 40);
  await pen('mouseReleased', 600, 300);
  await expect.poll(() => elements(page)).toBe(1);

  const c0 = await camera(page);
  await touch('touchStart', [[600, 600, 1]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[600 - i * 10, 600 - i * 5, 1]]);
  await touch('touchEnd', []);
  const c1 = await camera(page);
  expect((c1.x - c0.x) * c1.zoom).toBeCloseTo(100, 0);
  expect(await elements(page)).toBe(1); // палец не рисует

  await touch('touchStart', [
    [500, 400, 1],
    [600, 400, 2],
  ]);
  for (let i = 1; i <= 10; i++)
    await touch('touchMove', [
      [500 - i * 10, 400, 1],
      [600 + i * 10, 400, 2],
    ]);
  await touch('touchEnd', []);
  expect((await camera(page)).zoom).toBeCloseTo(3, 1);

  await page.screenshot({ path: shot('workspace-tablet.png') });
});
