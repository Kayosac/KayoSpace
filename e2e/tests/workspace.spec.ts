import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  // Включаем синхронизацию через панель настроек (шестерёнка на панели инструментов).
  await page.getByRole('button', { name: 'Настройки' }).click();
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

  // Тап двумя пальцами — отменить, тремя — повторить; холст при этом не сдвигается.
  const before = await camera(page);
  await touch('touchStart', [
    [400, 600, 1],
    [480, 600, 2],
  ]);
  await touch('touchMove', [
    [402, 601, 1],
    [483, 600, 2],
  ]);
  await touch('touchEnd', []);
  await expect.poll(() => elements(page)).toBe(0);
  expect(await camera(page)).toEqual(before);
  await touch('touchStart', [
    [400, 600, 1],
    [480, 600, 2],
    [560, 600, 3],
  ]);
  await touch('touchEnd', []);
  await expect.poll(() => elements(page)).toBe(1);

  await page.screenshot({ path: shot('workspace-tablet.png') });
});

test('ластик стирает часть штриха, как кисть; отмена возвращает всё одним шагом', async ({
  browser,
}) => {
  const page = await openDevice(browser, { board: 'e2e-eraser' });
  await page.getByRole('radio', { name: 'Толстое' }).click();
  await page.mouse.move(300, 300);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(300 + i * 20, 300);
  await page.mouse.up();
  await expect.poll(() => elements(page)).toBe(1);

  await page.getByRole('radio', { name: 'Ластик', exact: true }).click();
  await page.getByRole('radio', { name: 'Большой ластик' }).click();
  await page.mouse.move(600, 220);
  await page.mouse.down();
  await page.mouse.move(600, 380, { steps: 12 });
  await page.screenshot({ path: shot('workspace-eraser.png') });
  await page.mouse.up();
  await expect.poll(() => elements(page)).toBe(2);

  await page.keyboard.press('Control+z');
  await expect.poll(() => elements(page)).toBe(1);
});

test('выделение: рамка, перемещение, масштаб, копия, перекраска, удаление — и всё уходит на хаб', async ({
  browser,
  request,
}) => {
  const board = 'e2e-select';
  const page = await openDevice(browser, { ...synced, board });
  const other = await openDevice(browser, { ...synced, board });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await drawWave(page, 200, 250, 200);
  await drawWave(page, 200, 420, 200);
  await drawWave(page, 700, 300, 200);
  await expect.poll(() => hubElements(request, board)).toBe(3);

  const selected = () =>
    page.evaluate(() => (window.__kayospace!.engine as unknown as Sel).getSelection().length);
  const selBounds = () =>
    page.evaluate(() => (window.__kayospace!.engine as unknown as Sel).getSelectionBounds()!);

  await page.keyboard.press('v');
  await page.mouse.move(150, 180);
  await page.mouse.down();
  await page.mouse.move(450, 500, { steps: 10 });
  await page.mouse.up();
  expect(await selected()).toBe(2);
  await expect(page.getByTestId('selection-menu')).toBeVisible();

  // Перетаскивание: обе линии сдвигаются, на другом устройстве тоже.
  const b0 = await selBounds();
  await page.mouse.move(300, 260);
  await page.mouse.down();
  await page.mouse.move(400, 310, { steps: 10 });
  await page.mouse.up();
  const b1 = await selBounds();
  expect(b1.minX - b0.minX).toBeCloseTo(100, 0);
  expect(b1.minY - b0.minY).toBeCloseTo(50, 0);
  await expect
    .poll(() =>
      other.evaluate(() => {
        const items = [...(window.__kayospace!.engine as unknown as Sel).scene.items.values()];
        return Math.min(...items.map((i) => i.bounds.minX));
      }),
    )
    .toBeCloseTo(b1.minX, 0);

  // Масштаб за правый нижний угол: левый верхний угол на месте.
  const cam = await camera(page);
  const hx = (b1.maxX - cam.x) * cam.zoom + 6;
  const hy = (b1.maxY - cam.y) * cam.zoom + 6;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 80, hy + 80, { steps: 10 });
  await page.mouse.up();
  const b2 = await selBounds();
  expect(b2.maxX - b2.minX).toBeGreaterThan((b1.maxX - b1.minX) * 1.2);
  expect(b2.minX).toBeCloseTo(b1.minX, 0);
  await page.screenshot({ path: shot('workspace-selection.png') });

  // Копия рядом, перекраска, удаление через меню.
  await page.keyboard.press('Control+d');
  await expect.poll(() => elements(page)).toBe(5);
  await page.getByRole('radio', { name: 'Синий' }).click();
  await page.getByTestId('selection-menu').getByRole('button', { name: 'Удалить' }).click();
  await expect.poll(() => elements(page)).toBe(3);
  await expect.poll(() => hubElements(request, board)).toBe(3);
  await expect(page.getByTestId('selection-menu')).toBeHidden();

  // Отмена удаления возвращает копии.
  await page.keyboard.press('Control+z');
  await expect.poll(() => elements(page)).toBe(5);
});

interface Sel {
  getSelection(): string[];
  getSelectionBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null;
  scene: { items: Map<string, { bounds: { minX: number } }> };
}

test('стикеры, текст, фигуры, стрелка с привязкой и доски', async ({ browser, request }) => {
  const board = 'e2e-notes';
  const page = await openDevice(browser, { ...synced, board });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  const kinds = () =>
    page.evaluate(() =>
      [
        ...(
          window.__kayospace!.engine as unknown as {
            scene: {
              items: Map<string, { element: { type: string; props: Record<string, unknown> } }>;
            };
          }
        ).scene.items.values(),
      ].map((i) => i.element),
    );

  // Стикер: тап — сразу ввод текста; Esc — сохранить.
  await page.keyboard.press('n');
  await page.mouse.click(300, 300);
  await expect(page.getByTestId('note-editor')).toBeFocused();
  await page.keyboard.type('Первая мысль');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('note-editor')).toBeHidden();

  // Текст.
  await page.keyboard.press('t');
  await page.mouse.click(250, 150);
  await page.keyboard.type('Заголовок');
  await page.mouse.click(1000, 650); // тап мимо тоже сохраняет

  // Пустой стикер не остаётся на доске.
  await page.keyboard.press('n');
  await page.mouse.click(900, 200);
  await page.keyboard.press('Escape');

  // Прямоугольник и стрелка от стикера к прямоугольнику.
  await page.keyboard.press('r');
  await page.mouse.move(650, 250);
  await page.mouse.down();
  await page.mouse.move(850, 400, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('a');
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(750, 320, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => (await kinds()).map((e) => e.type).sort())
    .toEqual(['arrow', 'shape', 'sticky', 'text']);
  const els = await kinds();
  const sticky = els.find((e) => e.type === 'sticky')!;
  expect(sticky.props.content).toBe('Первая мысль');
  const arrow = els.find((e) => e.type === 'arrow')!;
  expect((arrow.props.start as { kind: string }).kind).toBe('element');
  expect((arrow.props.end as { kind: string }).kind).toBe('element');
  await expect.poll(() => hubElements(request, board)).toBe(4);

  // Двойной тап по стикеру (выбрать, потом ещё раз) — правка.
  await page.keyboard.press('v');
  await page.mouse.click(300, 300);
  await page.mouse.click(300, 300);
  await expect(page.getByTestId('note-editor')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await kinds()).find((e) => e.type === 'sticky')!.props.content)
    .toBe('Первая мысль!');
  await page.screenshot({ path: shot('workspace-notes.png') });

  // Доски: переименовать текущую, создать новую через Ctrl+K, вернуться.
  await page.getByTestId('board-title').click();
  await page.getByTestId('board-name').fill('Мысли');
  await page.getByTestId('board-name').press('Enter');
  await expect(page.getByTestId('board-title')).toHaveText('Мысли');
  await expect
    .poll(async () => {
      const res = await request.get(`http://${HUB_ADDRESS}/api/boards`, {
        headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      });
      return ((await res.json()) as { id: string; name: string | null }[]).find(
        (b) => b.id === board,
      )?.name;
    })
    .toBe('Мысли');
  // Панель ещё открыта — сразу ищем/создаём доску.
  await page.getByLabel('Найти или создать доску').fill('Вторая доска');
  await page.screenshot({ path: shot('workspace-boards.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('board-title')).toHaveText('Вторая доска');
  await expect.poll(() => elements(page)).toBe(0);
  await page.keyboard.press('Control+k');
  await page.getByRole('option', { name: /Мысли/ }).click();
  await expect(page.getByTestId('board-title')).toHaveText('Мысли');
  await expect.poll(() => elements(page)).toBe(4);
});

test('поворот холста, поворот стикера, рисунок на стикере, текст по размеру стикера', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    SETTINGS_KEY,
    JSON.stringify({ board: 'e2e-rotate' }),
  ] as const);
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  type Eng = {
    scene: {
      items: Map<string, { id: string; element: Record<string, unknown>; fit?: { size: number } }>;
      childrenOf(id: string): string[];
    };
    getCamera(): { rotation?: number };
  };
  const cdp = await context.newCDPSession(page);
  const pen = (type: string, x: number, y: number) =>
    cdp.send('Input.dispatchMouseEvent', {
      type: type as 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      pointerType: 'pen',
      force: 0.5,
    });
  const touch = (type: string, pts: [number, number, number][]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: type as 'touchStart',
      touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })),
    });
  const sticky = () =>
    page.evaluate(() => {
      const e = window.__kayospace!.engine as unknown as Eng;
      const it = [...e.scene.items.values()].find((i) => i.element.type === 'sticky')!;
      return {
        id: it.id,
        rotation: (it.element.rotation as number) ?? 0,
        y: it.element.y as number,
        font: it.fit?.size ?? 0,
        children: e.scene.childrenOf(it.id).length,
      };
    });

  // Короткий текст в стикере — крупным шрифтом.
  await page.keyboard.press('n');
  await page.mouse.click(300, 300);
  await page.keyboard.type('Идея');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await sticky()).font).toBeGreaterThan(40);

  // Рисунок пером поверх стикера становится его частью и едет вместе с ним.
  await page.keyboard.press('p');
  await pen('mousePressed', 240, 360);
  for (let i = 1; i <= 20; i++) await pen('mouseMoved', 240 + i * 6, 360 + Math.sin(i / 3) * 10);
  await pen('mouseReleased', 360, 360);
  await expect.poll(async () => (await sticky()).children).toBe(1);
  const strokeY = () =>
    page.evaluate(() => {
      const e = window.__kayospace!.engine as unknown as Eng;
      return [...e.scene.items.values()].find((i) => i.element.type === 'stroke')!.element
        .y as number;
    });
  await page.keyboard.press('v');
  await page.mouse.click(300, 230);
  const y0 = (await sticky()).y;
  const s0 = await strokeY();
  await page.mouse.move(300, 230);
  await page.mouse.down();
  await page.mouse.move(300, 330, { steps: 6 });
  await page.mouse.up();
  expect((await sticky()).y - y0).toBeCloseTo(100, 0);
  expect((await strokeY()) - s0).toBeCloseTo(100, 0);

  // Поворот стикера за круглую ручку над рамкой.
  const b = await page.evaluate(() =>
    (
      window.__kayospace!.engine as unknown as {
        getSelectionBounds(): { minX: number; minY: number; maxX: number; maxY: number };
      }
    ).getSelectionBounds(),
  );
  const cx = (b.minX + b.maxX) / 2 + 590; // камера по умолчанию: (0, 0) мира — в центре экрана
  const cy = (b.minY + b.maxY) / 2 + 410;
  const radius = cy - (b.minY + 410 - 32);
  await page.mouse.move(cx, cy - radius);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * (Math.PI / 4);
    await page.mouse.move(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
  }
  await page.mouse.up();
  expect(Math.round(((await sticky()).rotation * 180) / Math.PI)).toBe(45);

  // Поворот холста двумя пальцами; кнопка-компас выравнивает обратно.
  await page.mouse.click(1000, 650); // снять выделение
  await touch('touchStart', [
    [500, 500, 1],
    [700, 500, 2],
  ]);
  for (let i = 1; i <= 15; i++) {
    const a = (i / 15) * (Math.PI / 3);
    await touch('touchMove', [
      [600 - Math.cos(a) * 100, 500 - Math.sin(a) * 100, 1],
      [600 + Math.cos(a) * 100, 500 + Math.sin(a) * 100, 2],
    ]);
  }
  await touch('touchEnd', []);
  const rot = await page.evaluate(
    () => (window.__kayospace!.engine as unknown as Eng).getCamera().rotation ?? 0,
  );
  expect((rot * 180) / Math.PI).toBeGreaterThan(30);
  await page.screenshot({ path: shot('workspace-rotated.png') });
  await page.getByTestId('compass').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window.__kayospace!.engine as unknown as Eng).getCamera().rotation ?? 0),
    )
    .toBe(0);
});

test('картинка: вставка с устройства уезжает на хаб и видна на другом устройстве', async ({
  browser,
}) => {
  const board = 'e2e-images';
  const a = await openDevice(browser, { ...synced, board });
  const b = await openDevice(browser, { ...synced, board });
  await expect(a.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await a
    .getByTestId('image-input')
    .setInputFiles(join(import.meta.dirname, '..', 'fixtures', 'gradient.png'));
  const imageOn = (p: Page) =>
    p.evaluate(() => {
      const e = window.__kayospace!.engine as unknown as {
        scene: {
          items: Map<string, { element: { type: string; w: number; props: { assetId?: string } } }>;
        };
      };
      const it = [...e.scene.items.values()].find((i) => i.element.type === 'image');
      return it ? { w: Math.round(it.element.w), id: it.element.props.assetId ?? '' } : null;
    });
  await expect.poll(() => imageOn(b)).not.toBeNull();
  const img = (await imageOn(b))!;
  expect(img.w).toBe(160);
  // Файл — на хабе, по SHA-256.
  await expect
    .poll(async () => {
      const res = await fetch(`http://${HUB_ADDRESS}/api/assets/${img.id}`, {
        headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      });
      return res.status;
    })
    .toBe(200);
  await b.waitForTimeout(4000); // второе устройство скачивает (с повтором, если файл ещё ехал) и рисует
  await b.screenshot({ path: shot('workspace-image.png') });
});

/** Элементы доски на устройстве: тип, текст и рамка. */
const boardElements = (page: Page) =>
  page.evaluate(() =>
    [
      ...(
        window.__kayospace!.engine as unknown as {
          scene: {
            items: Map<
              string,
              { element: { type: string; x: number; y: number; props: Record<string, unknown> } }
            >;
          };
        }
      ).scene.items.values(),
    ].map((i) => ({
      type: i.element.type,
      x: i.element.x,
      content: (i.element.props.content as string | undefined) ?? null,
    })),
  );

test('вставка из буфера: текст — надписью, картинка — картинкой', async ({ browser, request }) => {
  const board = 'e2e-paste';
  const page = await openDevice(browser, { ...synced, board });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await page.mouse.move(400, 300);
  // Текст из другой программы.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Список дел:\nпозвонить\nкупить перо');
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
  });
  await expect
    .poll(async () => (await boardElements(page)).find((e) => e.type === 'text')?.content)
    .toBe('Список дел:\nпозвонить\nкупить перо');
  // Картинка (как скриншот в буфере).
  const png = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'gradient.png')).toString(
    'base64',
  );
  await page.mouse.move(800, 300);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
  }, png);
  await expect
    .poll(async () => (await boardElements(page)).filter((e) => e.type === 'image').length)
    .toBe(1);
  await expect.poll(() => hubElements(request, board)).toBe(2);
  await page.screenshot({ path: shot('workspace-paste.png') });
});

test.describe('ИИ в доске', () => {
  let worker: ChildProcess | null = null;

  test.beforeAll(() => {
    // Исполнитель с поддельным Claude Code: добавляет в черновик стикер «Черновик от ИИ».
    const root = join(import.meta.dirname, '..', '..');
    const fake = join(root, 'server', 'hub', 'test', 'fake-claude.mjs');
    chmodSync(fake, 0o755);
    worker = spawn('pnpm', ['--filter', '@kayospace/hub', 'ai-worker'], {
      cwd: root,
      env: {
        ...process.env,
        HUB_URL: `http://${HUB_ADDRESS}`,
        HUB_TOKEN,
        WORKER_NAME: 'e2e',
        CLAUDE_BIN: fake,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
  });

  test.afterAll(() => {
    if (worker?.pid) {
      try {
        process.kill(-worker.pid, 'SIGTERM');
      } catch {
        worker.kill('SIGTERM');
      }
    }
  });

  test('действие над выделением: предпросмотр, «Вставить», отмена одним шагом', async ({
    browser,
    request,
  }) => {
    const board = 'e2e-ai';
    const page = await openDevice(browser, { ...synced, board });
    await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
    await page.keyboard.press('n');
    await page.mouse.click(300, 300);
    await page.keyboard.type('Идея для резюме');
    await page.keyboard.press('Escape');
    await expect.poll(() => hubElements(request, board)).toBe(1);

    // Выделить стикер → «✦ ИИ» → «Резюме».
    await page.keyboard.press('v');
    await page.mouse.click(300, 300);
    await page.getByTestId('selection-menu').getByRole('button', { name: 'ИИ' }).click();
    await page.getByRole('menuitem', { name: 'Резюме' }).click();
    const bar = page.getByTestId('ai-bar');
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    await expect(bar).toContainText('Добавил стикер.');
    // Предпросмотр: в доске ещё ничего не поменялось.
    expect((await boardElements(page)).length).toBe(1);
    await page.screenshot({ path: shot('workspace-ai-preview.png') });

    await bar.getByRole('button', { name: 'Вставить' }).click();
    await expect(bar).toBeHidden();
    await expect
      .poll(async () => (await boardElements(page)).map((e) => e.content).sort())
      .toEqual(['Идея для резюме', 'Черновик от ИИ']);
    await expect.poll(() => hubElements(request, board)).toBe(2);
    await page.screenshot({ path: shot('workspace-ai-applied.png') });

    // «Отменить» убирает правку ИИ целиком.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await boardElements(page)).length).toBe(1);
  });

  test('свой запрос (Ctrl+J): результат можно не вставлять', async ({ browser }) => {
    const board = 'e2e-ai-prompt';
    const page = await openDevice(browser, { ...synced, board });
    await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
    await page.keyboard.press('Control+j');
    const prompt = page.getByTestId('ai-prompt');
    await expect(prompt).toBeVisible();
    await prompt.getByRole('textbox').fill('Набросай идею');
    await page.screenshot({ path: shot('workspace-ai-prompt.png') });
    await page.keyboard.press('Enter');
    const bar = page.getByTestId('ai-bar');
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    await bar.getByRole('button', { name: 'Отменить' }).click();
    await expect(bar).toBeHidden();
    expect((await boardElements(page)).length).toBe(0);
  });
});
