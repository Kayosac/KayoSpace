import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  HUB_ADDRESS,
  HUB_TOKEN,
  WORKSPACE_URL,
  drawWave,
  hubElements,
  pairCode,
  shot,
} from './env';

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
/** Цвет или толщина: кнопка на панели → заготовка в окне (окно закрывается само). */
async function pick(page: Page, what: 'color' | 'size', name: string): Promise<void> {
  await page.getByTestId(`${what}-button`).click();
  await page.getByTestId(`${what}-popover`).getByRole('radio', { name }).click();
  await expect(page.getByTestId(`${what}-popover`)).toHaveCount(0);
}
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

  await pick(b, 'color', 'Красный');
  await pick(b, 'size', 'Толстое');
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
  // Щелчок колеса доводится плавно за несколько кадров — ждём, пока вид остановится.
  await expect
    .poll(async () => {
      const z = (await camera(page)).zoom;
      await page.waitForTimeout(60);
      return (await camera(page)).zoom === z;
    })
    .toBe(true);

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

  // Подключаем устройство к хабу по коду через панель настроек (шестерёнка на панели инструментов).
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByTestId('open-connect').click();
  await page.getByTestId('connect-hub').fill(HUB_ADDRESS);
  await page.getByTestId('connect-code').fill(await pairCode(request));
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('connect-screen')).toHaveCount(0);
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await expect.poll(() => hubElements(request, board)).toBe(2);
  await page.screenshot({ path: shot('workspace-settings.png') });
});

test('старый неверный токен: экран подключения с причиной, доска продолжает работать', async ({
  browser,
}) => {
  const page = await openDevice(browser, { ...synced, hubToken: 'wrong', board: 'e2e-bad-token' });
  await expect(page.getByTestId('connect-screen')).toContainText('отключили');
  await page.getByRole('button', { name: 'Пока без хаба' }).click();
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'off');
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

test('планшет без клавиатуры: проекты, доски и названия — только касаниями', async ({
  browser,
}) => {
  // Ни одного нажатия клавиш: текст вводится как с экранной клавиатуры (fill), действия — касанием.
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    SETTINGS_KEY,
    JSON.stringify({ board: 'e2e-touch-only' }),
  ] as const);
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  const focused = () => page.evaluate(() => document.activeElement?.tagName ?? null);

  await page.getByTestId('board-title').tap();
  const panel = page.getByTestId('boards-panel');
  await expect(panel).toBeVisible();
  // Панель не открывает клавиатуру сама.
  expect(await focused()).not.toBe('INPUT');

  // Новый проект: название и кнопка «Создать».
  await page.getByTestId('add-project').tap();
  await page.getByTestId('new-project-name').fill('Ремонт');
  // Клавиатуру спрятали, тапнув по пустому месту панели, — ввод не пропадает.
  await panel.getByRole('heading', { name: 'Доски' }).tap();
  await expect(page.getByTestId('new-project-name')).toHaveValue('Ремонт');
  await page.getByTestId('new-project-create').tap();
  const tabs = page.getByTestId('projects');
  await expect(tabs.getByRole('tab', { name: 'Ремонт' })).toHaveAttribute('aria-selected', 'true');

  // Переименование проекта сохраняется касанием холста — без Enter.
  await page.getByTestId('project-name').fill('Ремонт кухни');
  await page.getByTestId('stage').tap({ position: { x: 900, y: 600 } });
  await expect(tabs.getByRole('tab', { name: 'Ремонт кухни' })).toBeVisible();

  // Название доски сохраняется и при закрытии панели крестиком.
  await page.getByTestId('board-name').fill('Кухня');
  await panel.getByRole('button', { name: 'Закрыть' }).tap();
  await expect(page.getByTestId('board-title')).toHaveText('Кухня');

  // Новая доска — кнопкой в списке, в выбранном проекте.
  await page.getByTestId('board-title').tap();
  await page.getByLabel('Найти или создать доску').fill('Смета');
  await page.getByRole('button', { name: /Создать «Смета» в «Ремонт кухни»/ }).tap();
  await expect(page.getByTestId('board-title')).toHaveText('Смета');
  await page.getByTestId('board-title').tap();
  await expect(page.getByRole('option', { name: /Смета/ })).toHaveCount(1);
  await page.screenshot({ path: shot('touch-only.png') });

  // Отмена ввода проекта — тоже касанием.
  await page.getByTestId('add-project').tap();
  await page.getByTestId('new-project-name').fill('Лишний');
  await page.getByRole('button', { name: 'Не создавать проект' }).tap();
  await expect(tabs.getByRole('tab', { name: 'Лишний' })).toHaveCount(0);
  await context.close();
});

test('ластик стирает часть штриха, как кисть; отмена возвращает всё одним шагом', async ({
  browser,
}) => {
  const page = await openDevice(browser, { board: 'e2e-eraser' });
  await pick(page, 'size', 'Толстое');
  await page.mouse.move(300, 300);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(300 + i * 20, 300);
  await page.mouse.up();
  await expect.poll(() => elements(page)).toBe(1);

  await page.getByRole('radio', { name: 'Ластик', exact: true }).click();
  await pick(page, 'size', 'Большой ластик');
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
  await pick(page, 'color', 'Синий');
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
    const board = `e2e-ai-${Date.now()}`;
    const page = await openDevice(browser, { ...synced, board });
    await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
    await page.keyboard.press('n');
    await page.mouse.click(300, 300);
    await page.keyboard.type('Идея для резюме');
    await page.keyboard.press('Escape');
    await expect.poll(() => hubElements(request, board)).toBe(1);

    // Выделить стикер → «✦ ИИ» → «Резюме».
    await page.keyboard.press('v');
    await page.keyboard.press('Control+a');
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

  test('«нарисуй … сюда»: ИИ кладёт картинку в предпросмотр, «Вставить» — на доску', async ({
    browser,
    request,
  }) => {
    const board = `e2e-ai-image-${Date.now()}`;
    const page = await openDevice(browser, { ...synced, board });
    await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
    await page.keyboard.press('Control+j');
    const prompt = page.getByTestId('ai-prompt');
    await prompt.getByRole('textbox').fill('Нарисуй солнце над морем сюда');
    await page.keyboard.press('Enter');
    const bar = page.getByTestId('ai-bar');
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    await expect(bar).toContainText('Нарисовал картинку.');
    expect((await boardElements(page)).length).toBe(0);
    await page.waitForTimeout(500); // картинка подгружается с хаба в предпросмотр
    await page.screenshot({ path: shot('workspace-ai-image-preview.png') });
    await bar.getByRole('button', { name: 'Вставить' }).click();
    await expect
      .poll(async () => (await boardElements(page)).map((e) => e.type))
      .toEqual(['image']);
    await expect.poll(() => hubElements(request, board)).toBe(1);
  });

  test('голос (планшет): микрофон → «Стоп» → текст в поле запроса', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1180, height: 820 },
      hasTouch: true,
      isMobile: true,
      permissions: ['microphone'],
    });
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
      SETTINGS_KEY,
      JSON.stringify({ ...synced, board: `e2e-voice-${Date.now()}` }),
    ] as const);
    const page = await context.newPage();
    // На хабе тестов нет ключа OpenAI — отвечаем за хаб: голос включён, запись распознана.
    let audioBytes = 0;
    await page.route('**/api/features', (r) =>
      r.fulfill({ json: { imageGen: true, voice: true } }),
    );
    await page.route('**/api/voice', async (r) => {
      audioBytes = r.request().postDataBuffer()?.length ?? 0;
      await r.fulfill({ json: { text: 'Нарисуй солнце над морем' } });
    });
    await page.goto(WORKSPACE_URL);
    await page.waitForFunction(() => window.__kayospace?.engine);
    await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
    await page.getByRole('button', { name: 'ИИ' }).first().tap();
    const prompt = page.getByTestId('ai-prompt');
    const mic = prompt.getByTestId('ai-mic');
    await mic.tap();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: shot('voice-recording.png') });
    await mic.tap();
    await expect(prompt.getByRole('textbox')).toHaveValue('Нарисуй солнце над морем');
    expect(audioBytes).toBeGreaterThan(500);
    await expect(prompt.getByRole('button', { name: 'Спросить' })).toBeEnabled();
    await context.close();
  });

  test('чат с ИИ: переписка, ответ с правками — предпросмотр и «Вставить»', async ({
    browser,
    request,
  }) => {
    const board = `e2e-chat-${Date.now()}`;
    const page = await openDevice(browser, { ...synced, board });
    await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
    await page.getByRole('button', { name: 'Чат с ИИ' }).click();
    const chat = page.getByTestId('chat-panel');
    await chat.getByTestId('chat-text').fill('Добавь стикер с идеей');
    await chat.getByTestId('chat-send').click();
    const bar = page.getByTestId('ai-bar');
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    const list = chat.getByTestId('chat-list');
    await expect(list).toContainText('Добавь стикер с идеей');
    await expect(list).toContainText('Добавил стикер.');
    await expect(list).toContainText('«Вставить» внизу');
    await page.screenshot({ path: shot('chat-panel.png') });
    await bar.getByRole('button', { name: 'Вставить' }).click();
    await expect.poll(() => hubElements(request, board)).toBe(1);
    // Второе сообщение — разговор продолжается.
    await chat.getByTestId('chat-text').fill('Спасибо');
    await chat.getByTestId('chat-send').click();
    await expect(bar).toHaveAttribute('data-state', 'ready', { timeout: 45_000 });
    await expect(list.locator('.chat-msg')).toHaveCount(4);
    await bar.getByRole('button', { name: 'Отменить' }).click();
  });

  test('свой запрос (Ctrl+J): результат можно не вставлять', async ({ browser }) => {
    const board = `e2e-ai-prompt-${Date.now()}`;
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

test('устройства: подключение по коду из «Добавить», отключение, повторный код', async ({
  browser,
}) => {
  const board = 'e2e-pairing';
  // A — уже подключённое устройство (старые настройки сами меняются на токен устройства).
  const a = await openDevice(browser, { ...synced, board });
  await expect(a.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await a.getByRole('button', { name: 'Настройки' }).click();
  // Другие проверки тоже подключали устройства к этому хабу — ищем отмеченное «это устройство».
  await expect(a.locator('[data-testid="device"][data-current]')).toContainText('это устройство');
  await a.getByTestId('add-device').click();
  const codeEl = a.getByTestId('pair-code');
  await expect(codeEl).toHaveAttribute('data-code', /^\d{6}$/);
  const code = (await codeEl.getAttribute('data-code'))!;
  await expect(a.getByTestId('pair')).toContainText(`${HUB_ADDRESS}`);
  await a.screenshot({ path: shot('devices-pair.png') });

  // B — новое устройство: вводит адрес хаба и код, без токенов.
  const b = await openDevice(browser, { board }, { colorScheme: 'dark' });
  await b.getByRole('button', { name: 'Настройки' }).click();
  await b.getByTestId('open-connect').click();
  await b.getByTestId('connect-hub').fill(HUB_ADDRESS);
  await b.getByTestId('connect-code').fill(code.slice(0, 3) + ' ' + code.slice(3));
  await b.getByTestId('connect-name').fill('Планшет');
  await b.screenshot({ path: shot('devices-connect.png') });
  await b.getByTestId('connect-submit').click();
  await expect(b.getByTestId('connect-screen')).toHaveCount(0);
  await expect(b.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  // Токен не попал в настройки (localStorage) — он в хранилище секретов.
  const stored = await b.evaluate(() => localStorage.getItem('kayospace.workspace.v1') ?? '');
  expect(stored).not.toContain('kd_');

  // A видит новое устройство сразу, в открытом окне «Добавить».
  await expect(a.getByTestId('pair-done')).toContainText('Планшет');
  await drawWave(b, 300, 300);
  await expect.poll(() => elements(a)).toBe(1);

  // A отключает B: у B — экран подключения с причиной, синхронизация остановлена.
  await a.getByRole('button', { name: 'Готово' }).click();
  const tablet = a.getByTestId('device').filter({ hasText: 'Планшет' });
  await tablet.getByRole('button', { name: 'Отключить' }).click();
  await tablet.getByRole('button', { name: 'Точно отключить?' }).click();
  await expect(a.getByTestId('device').filter({ hasText: 'Планшет' })).toHaveCount(0);
  await expect(b.getByTestId('connect-screen')).toContainText('отключили');
  await expect(b.getByTestId('sync')).not.toHaveAttribute('data-sync', 'synced');

  // Тот же код второй раз не подходит.
  await b.getByTestId('connect-hub').fill(HUB_ADDRESS);
  await b.getByTestId('connect-code').fill(code);
  await b.getByTestId('connect-submit').click();
  await expect(b.getByTestId('connect-error')).toContainText('не подошёл');
  await b.screenshot({ path: shot('devices-revoked.png') });

  // A работает дальше (рисуем правее открытой панели настроек).
  await drawWave(a, 700, 450);
  await expect.poll(() => elements(a)).toBe(2);
});

type El = {
  id: string;
  type: string;
  x: number;
  y: number;
  h: number;
  z: string;
  style: { color?: string };
  props: Record<string, unknown>;
};
const allElements = (page: Page): Promise<El[]> =>
  page.evaluate(() =>
    [
      ...(
        window.__kayospace!.engine as unknown as {
          scene: { items: Map<string, { element: El }> };
        }
      ).scene.items.values(),
    ].map((i) => i.element),
  );

test('фреймы, выделитель, порядок слоёв, выравнивание, экспорт, мини-карта', async ({
  browser,
  request,
}) => {
  const board = 'e2e-frames';
  const page = await openDevice(browser, { ...synced, board });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  const sticky = async (x: number, y: number, text: string) => {
    await page.keyboard.press('n');
    await page.mouse.click(x, y);
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
  };
  await sticky(300, 300, 'Альфа');
  await sticky(520, 430, 'Бета');

  // Фрейм рамкой вокруг стикеров: он под ними, сразу выделен — можно переименовать.
  await page.keyboard.press('f');
  await page.mouse.move(150, 150);
  await page.mouse.down();
  await page.mouse.move(700, 600, { steps: 8 });
  await page.mouse.up();
  const name = page.getByTestId('frame-name');
  await expect(name).toHaveValue('Фрейм 1');
  await name.fill('Неделя');
  await name.press('Enter');
  const frameOf = async () => (await allElements(page)).find((e) => e.type === 'frame')!;
  await expect.poll(async () => (await frameOf())?.props.name).toBe('Неделя');
  const before = await allElements(page);
  const f0 = before.find((e) => e.type === 'frame')!;
  expect(before.filter((e) => e.type === 'sticky').every((s) => s.z > f0.z)).toBe(true);

  // Перенос фрейма за заголовок везёт содержимое.
  await page.keyboard.press('Escape');
  await page.mouse.move(200, 137);
  await page.mouse.down();
  await page.mouse.move(400, 137, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await frameOf()).x - f0.x)).toBe(200);
  const moved = await allElements(page);
  for (const s of before.filter((e) => e.type === 'sticky')) {
    expect(Math.round(moved.find((e) => e.id === s.id)!.x - s.x)).toBe(200);
  }
  await page.screenshot({ path: shot('frames.png') });

  // Выделитель (маркера больше нет: M ничего не выбирает).
  await page.keyboard.press('m');
  await page.keyboard.press('i');
  await drawWave(page, 760, 720, 200);
  await expect
    .poll(async () =>
      (await allElements(page))
        .filter((e) => e.type === 'stroke')
        .map((e) => [e.props.tool, e.style.color ?? null]),
    )
    .toEqual([['highlighter', '#f5d90a']]);
  await expect(page.getByRole('radio', { name: 'Маркер' })).toHaveCount(0);

  // Порядок слоёв: Альфа под Бету, но над фреймом; Ctrl+] — обратно наверх.
  const z = async (text: string) =>
    (await allElements(page)).find((e) => e.props.content === text)!.z;
  await page.keyboard.press('v');
  await page.mouse.click(500, 300); // Альфа после переноса
  await page.getByTestId('selection-more').click();
  await page.getByRole('menuitem', { name: /На задний план/ }).click();
  await expect.poll(async () => (await z('Альфа')) < (await z('Бета'))).toBe(true);
  expect((await z('Альфа')) > (await frameOf()).z).toBe(true);
  await page.keyboard.press('Control+BracketRight');
  await expect.poll(async () => (await z('Альфа')) > (await z('Бета'))).toBe(true);

  // Выравнивание: обе по левому краю.
  await page.keyboard.down('Shift');
  await page.mouse.click(720, 430); // Бета
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('selection-menu').locator('.count')).toHaveText('2');
  await page.getByTestId('selection-more').click();
  await page.getByRole('menuitem', { name: 'По левому краю' }).click();
  await expect
    .poll(async () => {
      const notes = (await allElements(page)).filter((e) => e.type === 'sticky');
      return Math.round(notes[0]!.x) === Math.round(notes[1]!.x);
    })
    .toBe(true);
  await expect.poll(() => hubElements(request, board)).toBe(4);

  // Мини-карта: нажатие переносит вид.
  const cam0 = await camera(page);
  const map = page.getByTestId('minimap');
  await expect(map).toBeVisible();
  const box = (await map.boundingBox())!;
  await page.mouse.click(box.x + 8, box.y + box.height - 8);
  await expect.poll(async () => (await camera(page)).x).not.toBe(cam0.x);

  // Экспорт: PNG доски и PDF — по странице на фрейм.
  await page.keyboard.press('Escape');
  await page.getByTestId('board-title').click();
  await expect(page.getByTestId('frames-list')).toContainText('Неделя');
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-png').click(),
  ]);
  expect(png.suggestedFilename()).toBe('e2e-frames.png');
  const pngBytes = readFileSync((await png.path())!);
  expect(pngBytes.subarray(1, 4).toString()).toBe('PNG');
  // Панель досок остаётся открытой — сразу PDF.
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-pdf').click(),
  ]);
  const pdfText = readFileSync((await pdf.path())!).toString('latin1');
  expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
  expect(pdfText).toContain('/Count 1');
  await expect(page.locator('.toast')).toHaveText('Файл сохранён');
});

test('проекты: создать, положить доску, новая доска — в выбранный проект, видно на другом устройстве', async ({
  browser,
  request,
}) => {
  const a = await openDevice(browser, { ...synced, board: 'e2e-proj-a' });
  await expect(a.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await drawWave(a, 300, 300);
  await a.getByTestId('board-title').click();
  await a.getByTestId('add-project').click();
  await a.getByLabel('Название нового проекта').fill('Ремонт');
  await a.getByLabel('Название нового проекта').press('Enter');
  const projects = a.getByTestId('projects');
  await expect(projects.getByRole('tab', { name: 'Ремонт' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Открытая доска пока без проекта — в списке проекта её нет; кладём её туда.
  await expect(a.getByRole('option', { name: /e2e-proj-a/ })).toHaveCount(0);
  await a.getByTestId('board-project').selectOption({ label: 'Ремонт' });
  await expect(a.getByRole('option', { name: /e2e-proj-a/ })).toHaveCount(1);
  // Новая доска создаётся в выбранном проекте.
  await a.getByLabel('Найти или создать доску').fill('Смета');
  await a.screenshot({ path: shot('projects.png') });
  await a.keyboard.press('Enter');
  await expect(a.getByTestId('board-title')).toHaveText('Смета');
  await drawWave(a, 300, 300);

  // Хаб и второе устройство видят проект.
  await expect
    .poll(async () => {
      const res = await request.get(`http://${HUB_ADDRESS}/api/boards`, {
        headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      });
      const list = (await res.json()) as { id: string; project: { name: string } | null }[];
      return list
        .filter((b) => b.project?.name === 'Ремонт')
        .map((b) => b.id)
        .sort().length;
    })
    .toBe(2);
  const b = await openDevice(browser, { ...synced, board: 'e2e-proj-b' }, { colorScheme: 'dark' });
  await expect(b.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await b.getByTestId('board-title').click();
  await b.getByTestId('projects').getByRole('tab', { name: 'Ремонт' }).click();
  await expect(b.getByRole('option', { name: /Смета/ })).toHaveCount(1);
  await expect(b.getByRole('option', { name: /e2e-proj-a/ })).toHaveCount(1);
  await expect(b.getByRole('option', { name: /e2e-proj-b/ })).toHaveCount(0);
  await b.screenshot({ path: shot('projects-dark.png') });

  // Удалить проект: доски остаются, просто без проекта.
  await b.getByRole('button', { name: 'Удалить проект' }).click();
  await expect(b.getByTestId('projects').getByRole('tab')).toHaveCount(1);
  await expect(b.getByRole('option', { name: /Смета/ })).toHaveCount(1);
});

test('резервные копии: доска из копии открывается рядом с исходной', async ({
  browser,
  request,
}) => {
  const page = await openDevice(browser, { ...synced, board: 'e2e-backup' });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await drawWave(page, 300, 300);
  await expect.poll(() => hubElements(request, 'e2e-backup')).toBe(1);
  const made = await request.post(`http://${HUB_ADDRESS}/api/backups`, {
    headers: { Authorization: `Bearer ${HUB_TOKEN}` },
  });
  expect(made.ok()).toBe(true);
  // После копии доску очистили — восстанавливаем.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await expect.poll(() => hubElements(request, 'e2e-backup')).toBe(0);

  await page.getByRole('button', { name: 'Настройки' }).click();
  const section = page.getByTestId('backups');
  await expect(section.getByTestId('backups-last')).toContainText('Всего копий');
  await section.getByTestId('restore-open').click();
  const row = section.getByTestId('backup-boards').locator('li', { hasText: 'открыта' });
  await expect(row).toContainText('1 эл.');
  await page.screenshot({ path: shot('backups.png') });
  await row.getByRole('button', { name: 'Восстановить' }).click();
  await section.getByRole('button', { name: 'Открыть' }).click();
  await expect(page.getByTestId('board-title')).toContainText('(копия от');
  await expect.poll(() => elements(page)).toBe(1);
});

test('«Поделиться» (Android): текст и картинка ложатся во «Входящие» лентой', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    SETTINGS_KEY,
    JSON.stringify({ board: 'e2e-before-share', connectSkipped: true }),
  ] as const);
  // Оболочка Tauri: плагин отдаёт присланное один раз, остальные команды ничего не делают.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=';
  await context.addInitScript((data) => {
    let shared: unknown = {
      subject: 'Статья про холсты',
      text: 'https://example.com/canvas',
      files: [{ name: 'скрин.png', mime: 'image/png', data }],
    };
    let cb = 0;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      transformCallback: () => ++cb,
      unregisterCallback: () => {},
      invoke: async (cmd: string) => {
        if (cmd === 'plugin:share-target|take') {
          const out = shared ?? { files: [] };
          shared = null;
          return out;
        }
        return null;
      },
    };
  }, png);
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  await expect(page.getByTestId('board-title')).toHaveText('Входящие');
  await expect.poll(() => elements(page)).toBe(2);
  const els = (await allElements(page)).map((e) => ({
    type: e.type,
    y: e.y,
    h: e.h,
    content: e.props.content ?? null,
  }));
  const text = els.find((e) => e.type === 'text')!;
  const image = els.find((e) => e.type === 'image')!;
  expect(text.content).toBe('Статья про холсты\nhttps://example.com/canvas');
  // Картинка — под текстом, не поверх.
  expect(image.y).toBeGreaterThanOrEqual(text.y + text.h);
  await page.screenshot({ path: shot('share-inbox.png') });
  await context.close();
});

test('обновление на компьютере: «Проверить обновления» → «Установить» → перезапуск', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    SETTINGS_KEY,
    JSON.stringify({ board: 'e2e-update', connectSkipped: true }),
  ] as const);
  // Оболочка Tauri: модуль обновлений нашёл 0.99.0; записываем, какие команды пришли.
  await context.addInitScript(() => {
    const calls: string[] = [];
    let cb = 0;
    (window as unknown as Record<string, unknown>).__updateCalls = calls;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      transformCallback: () => ++cb,
      unregisterCallback: () => {},
      invoke: async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'plugin:updater|check') {
          return {
            rid: 1,
            currentVersion: '0.10.0',
            version: '0.99.0',
            date: null,
            body: 'Что нового',
            rawJson: {},
          };
        }
        if (cmd === 'plugin:share-target|take') return { files: [] };
        return null;
      },
    };
  });
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-status')).toHaveText('Доступна версия 0.99.0.');
  const banner = page.getByTestId('update-banner');
  await expect(banner).toContainText('Доступна версия 0.99.0');
  await page.screenshot({ path: shot('update.png') });
  await banner.getByTestId('update-install').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __updateCalls: string[] }).__updateCalls),
    )
    .toEqual(
      expect.arrayContaining(['plugin:updater|download_and_install', 'plugin:process|restart']),
    );
  await context.close();
});

test('палитра и толщина касанием: круг, ползунок, недавние; у выделителя свой цвет', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    SETTINGS_KEY,
    JSON.stringify({ board: 'e2e-palette' }),
  ] as const);
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  const st = () =>
    page.evaluate(() => {
      const engine = window.__kayospace!.engine as unknown as {
        getState(): { color: string | null; size: number; penKind: string };
      };
      const s = engine.getState();
      return { color: s.color, size: s.size, penKind: s.penKind };
    });

  // На панели — одна кнопка цвета и одна толщины вместо рядов кружков.
  await expect(page.getByRole('radio', { name: 'Красный' })).toHaveCount(0);
  await page.getByTestId('color-button').tap();
  const pop = page.getByTestId('color-popover');
  await expect(pop).toBeVisible();
  // Касание правого края круга — красный тон, полная насыщенность.
  const wheel = pop.getByTestId('color-wheel');
  const box = (await wheel.boundingBox())!;
  await wheel.tap({ position: { x: box.width - 6, y: box.height / 2 } });
  await expect.poll(async () => (await st()).color).toMatch(/^#[0-9a-f]{6}$/);
  const custom = (await st()).color!;
  expect(Number.parseInt(custom.slice(1, 3), 16)).toBeGreaterThan(180); // красный канал
  await page.screenshot({ path: shot('palette.png') });
  // Касание холста закрывает окно и ничего не рисует.
  await page.getByTestId('stage').tap({ position: { x: 900, y: 300 } });
  await expect(pop).toHaveCount(0);
  expect(await elements(page)).toBe(0);
  // Свой цвет — в недавних.
  await page.getByTestId('color-button').tap();
  await expect(pop.getByRole('radio', { name: `Недавний ${custom}` })).toBeVisible();
  await pop.getByRole('radio', { name: 'Синий' }).tap();
  await expect(pop).toHaveCount(0);
  expect((await st()).color).toBe('#3e63dd');

  // Толщина — ползунком.
  await page.getByTestId('size-button').tap();
  const sizePop = page.getByTestId('size-popover');
  await sizePop.getByTestId('size-slider').fill('1000');
  await expect.poll(async () => (await st()).size).toBe(48);
  await expect(sizePop.getByTestId('size-value')).toHaveText('48 px');
  await page.screenshot({ path: shot('size.png') });
  await sizePop.getByRole('radio', { name: 'Среднее' }).tap();
  expect((await st()).size).toBe(3);

  // У выделителя свои цвет и толщина; ручка свои помнит.
  await page.getByRole('radio', { name: 'Выделитель' }).tap();
  await page.getByTestId('color-button').tap();
  await pop.getByRole('radio', { name: 'Зелёный' }).tap();
  expect(await st()).toEqual({ color: '#30a46c', size: 3, penKind: 'highlighter' });
  await page.getByRole('radio', { name: 'Ручка' }).tap();
  expect(await st()).toEqual({ color: '#3e63dd', size: 3, penKind: 'pen' });
  await context.close();
});

test('поиск по всем доскам ведёт к стикеру; фон доски общий для устройств', async ({
  browser,
  request,
}) => {
  const a = await openDevice(browser, { ...synced, board: 'e2e-find-a' });
  await expect(a.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await a.keyboard.press('n');
  await a.mouse.click(700, 500);
  await a.keyboard.type('Квартальный отчёт');
  await a.keyboard.press('Escape');
  await expect.poll(() => hubElements(request, 'e2e-find-a')).toBe(1);
  // Фон — в панели досок.
  await a.getByTestId('board-title').click();
  await a.getByRole('radio', { name: 'Клетка' }).click();
  await expect
    .poll(() =>
      a.evaluate(
        () =>
          (
            window.__kayospace!.engine as unknown as { getState(): { background: string } }
          ).getState().background,
      ),
    )
    .toBe('grid');
  await a.screenshot({ path: shot('background-grid.png') });

  // Другое устройство, другая доска: ищем — находим — переходим.
  const b = await openDevice(browser, { ...synced, board: 'e2e-find-b' });
  await expect(b.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await b.getByTestId('board-title').click();
  await b.getByLabel('Найти или создать доску').fill('квартал');
  const found = b.getByTestId('found');
  await expect(found.getByRole('button')).toHaveCount(1);
  await expect(found).toContainText('Квартальный отчёт');
  await b.screenshot({ path: shot('search.png') });
  await found.getByRole('button').click();
  await expect(b.getByTestId('board-title')).toHaveText('e2e-find-a');
  await expect(b.getByTestId('selection-menu').locator('.count')).toHaveText('1');
  const bg = await b.evaluate(
    () =>
      (window.__kayospace!.engine as unknown as { getState(): { background: string } }).getState()
        .background,
  );
  expect(bg).toBe('grid');
});

test('агент через MCP раскладывает стикеры — на устройстве видно, что он сделал, и это можно отменить', async ({
  browser,
  request,
}) => {
  const board = 'e2e-agent';
  const page = await openDevice(browser, { ...synced, board });
  await expect(page.getByTestId('sync')).toHaveAttribute('data-sync', 'synced');
  await drawWave(page, 300, 300);
  await expect.poll(() => hubElements(request, board)).toBe(1);

  // Агент — настоящий клиент MCP, как Claude Code.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${HUB_ADDRESS}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${HUB_TOKEN}`, 'User-Agent': 'claude-code/2.0' },
      },
    }),
  );
  const r = (await client.callTool({
    name: 'add_elements',
    arguments: {
      board,
      items: [{ text: 'Идея 1' }, { text: 'Идея 2' }, { text: 'Идея 3' }],
      newFrame: 'От агента',
    },
  })) as { isError?: boolean };
  expect(r.isError).toBeFalsy();
  await expect.poll(() => hubElements(request, board)).toBe(5);

  const bar = page.getByTestId('agent-bar');
  await expect(bar).toContainText('Claude Code');
  await expect(bar).toContainText('добавил 4');
  await bar.getByRole('button', { name: 'Показать' }).click();
  await page.screenshot({ path: shot('agent-activity.png') });

  // Картинка доски для агента — с рукописным штрихом.
  const view = (await client.callTool({ name: 'view_board', arguments: { board } })) as {
    content: { type: string; mimeType?: string }[];
  };
  expect(view.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
  await client.close();

  // Отменить — и на устройстве, и на хабе остаётся только своё.
  await page.getByTestId('agent-revert').click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => elements(page)).toBe(1);
  await expect.poll(() => hubElements(request, board)).toBe(1);
  // Отмену можно отменить: агентские правки возвращаются.
  await page.getByRole('button', { name: 'Отменить', exact: true }).first().click();
  await expect.poll(() => elements(page)).toBe(5);
});

test('планшет: корзина, удаление и возврат доски — касаниями; агент кладёт картинку', async ({
  browser,
  request,
}) => {
  const a = 'e2e-del-a';
  const b = 'e2e-del-b';
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'e2e-images', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${HUB_ADDRESS}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${HUB_TOKEN}` } },
    }),
  );
  type Result = { isError?: boolean; content: { text?: string }[] };
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as Result;
  await call('create_board', { board: a, name: 'Первая' });
  await call('create_board', { board: b, name: 'Вторая' });
  const added = await call('add_elements', {
    board: a,
    items: [{ text: 'Оставить' }, { text: 'Выбросить' }],
  });
  const ids = (JSON.parse(added.content[0]!.text!) as { added: { id: string }[] }).added;

  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [
      SETTINGS_KEY,
      JSON.stringify({ ...synced, board: a, recentBoards: [{ id: b, name: 'Вторая' }] }),
    ] as const,
  );
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  await expect.poll(() => elements(page)).toBe(2);

  // Агент выбросил стикер — человек видит его в корзине (отдельная панель) и возвращает.
  await call('delete_elements', { board: a, ids: [ids[1]!.id] });
  await expect.poll(() => elements(page)).toBe(1);
  await page.getByTestId('board-title').tap();
  await page.getByTestId('open-trash').tap();
  const trashPanel = page.getByTestId('trash-panel');
  await expect(trashPanel).toBeVisible();
  await expect(page.getByTestId('boards-panel')).toHaveCount(0);
  const trash = trashPanel.getByTestId('trash-board').filter({ hasText: 'Первая' });
  await expect(trash).toContainText('Выбросить');
  await expect(trash).toContainText('удалил агент');
  await expect(trash).toContainText('открыта');
  await page.screenshot({ path: shot('trash-panel.png') });
  await trash.getByRole('button', { name: 'Вернуть' }).tap();
  await expect.poll(() => elements(page)).toBe(2);
  await expect(trash).toHaveCount(0);
  await trashPanel.getByRole('button', { name: 'Закрыть' }).tap();

  // Удалить доску — в два касания; открывается другая, удалённую можно вернуть из корзины.
  await page.getByTestId('board-title').tap();
  const del = page.getByTestId('delete-board');
  await del.tap();
  await expect(del).toHaveText('Точно удалить доску?');
  await del.tap();
  await expect(page.getByTestId('board-title')).toHaveText('Вторая');
  await expect(page.getByRole('option', { name: /Первая/ })).toHaveCount(0);
  await expect(page.getByTestId('open-trash')).toContainText('досок: 1');
  await expect.poll(async () => (await call('list_boards', {})).content[0]!.text).not.toContain(a);
  await page.getByTestId('open-trash').tap();
  const gone = page.getByTestId('deleted-boards');
  await expect(gone).toContainText('Первая');
  await page.screenshot({ path: shot('deleted-boards.png') });
  await gone.getByRole('button', { name: 'Вернуть' }).tap();
  await expect(page.getByTestId('board-title')).toHaveText('Первая');
  await expect.poll(() => elements(page)).toBe(2);
  // Возврат открывает доску — панель закрывается сама.
  await expect(page.getByTestId('trash-panel')).toHaveCount(0);

  // Агент кладёт картинку файлом — устройство показывает её.
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#3e63dd';
    ctx.fillRect(0, 0, 320, 200);
    return c.toDataURL('image/png');
  });
  const img = await call('add_images', { board: a, images: [{ data: png, alt: 'Синий' }] });
  expect(img.isError).toBeFalsy();
  await expect.poll(() => elements(page)).toBe(3);
  await expect.poll(() => hubElements(request, a)).toBe(3);
  await page.screenshot({ path: shot('agent-image.png') });
  await client.close();
  await context.close();
});

/** Маленький настоящий PDF: по странице A4 на строку текста. */
function makePdf(lines: string[]): Buffer {
  const objs: string[] = [];
  const pageIds = lines.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  lines.forEach((text, i) => {
    const stream = `BT /F1 48 Tf 72 700 Td (${text}) Tj ET 0 0 1 rg 72 400 200 150 re f`;
    objs[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('планшет: доска из шаблона, PDF страницами, презентация по фреймам — касаниями', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [SETTINGS_KEY, JSON.stringify({ board: `e2e-present-${Date.now()}` })] as const,
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[present] ошибка страницы: ${e.message}`));
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  const frameNames = () =>
    page.evaluate(() =>
      (window.__kayospace!.engine as unknown as { getFrames(): { name: string }[] })
        .getFrames()
        .map((f) => f.name),
    );

  // Новая доска из шаблона «Канбан» — колонки уже на месте.
  await page.getByTestId('board-title').tap();
  await page.getByLabel('Найти или создать доску').fill('Спринт');
  await page.getByTestId('templates').getByRole('button', { name: 'Канбан' }).tap();
  await expect(page.getByTestId('board-title')).toHaveText('Спринт');
  await expect.poll(frameNames).toEqual(['Сделать', 'В работе', 'Готово']);
  await page.screenshot({ path: shot('template-kanban.png') });

  // PDF — кнопкой «Картинка или PDF»: каждая страница во фрейме.
  await page.getByTestId('image-input').setInputFiles({
    name: 'Договор.pdf',
    mimeType: 'application/pdf',
    buffer: makePdf(['Page one', 'Page two']),
  });
  await expect
    .poll(async () => (await frameNames()).sort(), { timeout: 20_000 })
    .toEqual(['В работе', 'Готово', 'Договор — стр. 1', 'Договор — стр. 2', 'Сделать']);
  await expect(page.locator('.toast')).toContainText('PDF на доске: 2 стр.');
  expect((await boardElements(page)).filter((e) => e.type === 'image')).toHaveLength(2);
  // Фрейм страницы шире самой страницы — его удобно брать за поля.
  const pageFrame = await page.evaluate(
    () =>
      (
        window.__kayospace!.engine as unknown as {
          getFrames(): { name: string; bounds: { minX: number; maxX: number } }[];
        }
      )
        .getFrames()
        .find((f) => f.name === 'Договор — стр. 1')!.bounds,
  );
  expect(pageFrame.maxX - pageFrame.minX).toBe(864);
  await page.screenshot({ path: shot('pdf-pages.png') });

  // Презентация: «Показать» в списке досок; касание справа — вперёд, слева — назад.
  const before = await camera(page);
  await page.getByTestId('board-title').tap();
  await page.getByTestId('present').tap();
  const title = page.getByTestId('present-title');
  await expect(title).toContainText('1 / 5');
  await expect(title).toContainText('Сделать');
  await expect(page.locator('.toolbar')).toBeHidden();
  const surface = page.getByTestId('present-surface');
  await surface.tap({ position: { x: 1000, y: 400 } });
  await expect(title).toContainText('2 / 5');
  await surface.tap({ position: { x: 100, y: 400 } });
  await expect(title).toContainText('1 / 5');
  await page.getByRole('button', { name: 'Вперёд' }).tap();
  await page.getByRole('button', { name: 'Вперёд' }).tap();
  await page.getByRole('button', { name: 'Вперёд' }).tap();
  await expect(title).toContainText('4 / 5');
  await expect(title).toContainText('Договор — стр. 1');
  await page.screenshot({ path: shot('presentation.png') });
  await page.getByRole('button', { name: 'Выйти из презентации' }).tap();
  await expect(page.getByTestId('presentation')).toHaveCount(0);
  await expect(page.locator('.toolbar')).toBeVisible();
  expect(await camera(page)).toEqual(before);
  await context.close();
});

test('планшет: история доски — версии картинками, «Вернуть» и «Копией» касаниями', async ({
  browser,
}) => {
  const board = `e2e-history-${Date.now()}`;
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'e2e-history', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${HUB_ADDRESS}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${HUB_TOKEN}` } },
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{ content: { text?: string }[] }>;
  await call('create_board', { board, name: 'История' });
  await call('add_elements', { board, items: [{ text: 'Было' }] });
  await new Promise((r) => setTimeout(r, 1000));
  const added = await call('add_elements', { board, items: [{ text: 'Стало' }, { text: 'Ещё' }] });
  expect(added.content[0]!.text).toContain('added');
  await new Promise((r) => setTimeout(r, 1000));

  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [SETTINGS_KEY, JSON.stringify({ ...synced, board })] as const,
  );
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  await expect.poll(() => elements(page)).toBe(2 + 1);

  await page.getByTestId('board-title').tap();
  await page.getByTestId('open-history').tap();
  const panel = page.getByTestId('history-panel');
  const versions = panel.getByTestId('version');
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText('3 эл.');
  await expect(versions.last()).toContainText('1 эл.');
  await expect(versions.first().locator('img')).toBeVisible();
  await page.screenshot({ path: shot('history-panel.png') });

  // Вернуть первую версию — в два касания; доска снова как была.
  const restore = versions.last().getByRole('button', { name: 'Вернуть' });
  await restore.tap();
  await versions.last().getByRole('button', { name: 'Точно вернуть?' }).tap();
  await expect.poll(() => elements(page)).toBe(1);
  await expect(page.locator('.toast')).toContainText('Доска возвращена');

  // Копией — новая доска рядом с той версией, где было три элемента.
  await expect(versions.first()).toContainText('1 эл.');
  await panel.getByTestId('version').nth(1).getByRole('button', { name: 'Копией' }).tap();
  await expect(page.getByTestId('board-title')).toContainText('версия от');
  await expect.poll(() => elements(page)).toBe(3);
  await client.close();
  await context.close();
});

test('планшет: стикер — задачей, срок и статус касаниями; «Задачи» со всех досок', async ({
  browser,
}) => {
  const board = `e2e-tasks-${Date.now()}`;
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'e2e-tasks', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${HUB_ADDRESS}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${HUB_TOKEN}` } },
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{ content: { text?: string }[] }>;
  await call('create_board', { board, name: 'Дела' });
  await call('add_elements', { board, items: [{ text: 'Позвонить мастеру' }], at: { x: 0, y: 0 } });
  // Задача, которую поставил агент на другой доске.
  await call('add_elements', {
    board: `${board}-2`,
    items: [{ text: 'Отчёт агента', task: { status: 'doing', high: true } }],
  });

  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [SETTINGS_KEY, JSON.stringify({ ...synced, board })] as const,
  );
  const page = await context.newPage();
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  await expect.poll(() => elements(page)).toBe(1);
  await page.evaluate(() =>
    (window.__kayospace!.engine as unknown as { zoomToFit(): void }).zoomToFit(),
  );
  // На планшете выделяют пером; здесь — выделяем стикер напрямую, дальше всё касаниями.
  await page.getByRole('radio', { name: 'Выделение' }).tap();
  await page.evaluate(() => {
    const e = window.__kayospace!.engine as unknown as { selectAll(): void };
    e.selectAll();
  });
  await page.getByTestId('task-button').tap();
  const panel = page.getByTestId('task-panel');
  await panel.getByRole('radio', { name: 'В работе' }).tap();
  await panel.getByTestId('task-due').fill('2026-01-15');
  await panel.getByRole('checkbox', { name: 'Отметить важной' }).tap();
  const task = () =>
    page.evaluate(() => {
      const items = [
        ...(
          window.__kayospace!.engine as unknown as {
            scene: { items: Map<string, { element: { props: { task?: unknown } } }> };
          }
        ).scene.items.values(),
      ];
      return items[0]!.element.props.task;
    });
  await expect.poll(task).toEqual({ status: 'doing', due: '2026-01-15', high: true });
  await page.screenshot({ path: shot('task-sticky.png') });

  // «Задачи»: обе доски, просроченная — красным; отметить «Готово» кружком.
  await page.getByRole('button', { name: 'Задачи', exact: true }).tap();
  const tasks = page.getByTestId('tasks-panel');
  await expect(tasks.getByTestId('task-row')).toHaveCount(2);
  await expect(tasks).toContainText('Отчёт агента');
  await expect(tasks.getByTestId('task-row').first()).toContainText('Позвонить мастеру');
  await page.screenshot({ path: shot('tasks-panel.png') });
  await tasks
    .getByTestId('task-row')
    .filter({ hasText: 'Отчёт агента' })
    .getByRole('checkbox')
    .tap();
  await expect(tasks.getByTestId('task-row')).toHaveCount(1);
  await tasks.getByRole('tab', { name: 'Готово' }).tap();
  await expect(tasks.getByTestId('task-row')).toContainText('Отчёт агента');
  const listed = JSON.parse((await call('list_tasks', { status: 'done' })).content[0]!.text!) as {
    tasks: { text: string }[];
  }[];
  expect(listed.flatMap((b) => b.tasks.map((t) => t.text))).toEqual(['Отчёт агента']);
  await client.close();
  await context.close();
});

test('планшет: Настройки → OpenAI — лимиты и рукописное касаниями', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    SETTINGS_KEY,
    JSON.stringify({ ...synced, board: `e2e-openai-${Date.now()}` }),
  ] as const);
  const page = await context.newPage();
  // На хабе тестов нет ключа OpenAI — отвечаем за хаб.
  let state = {
    limits: { images: 30, voice: 100, handwriting: 500 },
    handwriting: true,
    usage: {
      images: { used: 3, limit: 30 },
      voice: { used: 0, limit: 100 },
      handwriting: { used: 12, limit: 500 },
    },
  };
  const puts: unknown[] = [];
  await page.route('**/api/openai', async (r) => {
    if (r.request().method() === 'PUT') {
      const patch = r.request().postDataJSON() as {
        limits?: Record<string, number>;
        handwriting?: boolean;
      };
      puts.push(patch);
      state = {
        ...state,
        limits: { ...state.limits, ...patch.limits },
        handwriting: patch.handwriting ?? state.handwriting,
      };
    }
    await r.fulfill({ json: state });
  });
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);
  await page.getByRole('button', { name: 'Настройки' }).tap();
  const section = page.getByTestId('openai-settings');
  await expect(section).toContainText('сегодня 3');
  await section.getByTestId('limit-images').fill('10');
  await section.getByTestId('save-limits').tap();
  await expect(section).toContainText('Сохранено');
  await section.getByTestId('handwriting-toggle').tap();
  await expect(section.getByTestId('handwriting-toggle')).not.toBeChecked();
  expect(puts).toEqual([
    { limits: { images: 10, voice: 100, handwriting: 500 } },
    { handwriting: false },
  ]);
  await page.screenshot({ path: shot('openai-settings.png') });
  await context.close();
});

async function mcpClient(name: string) {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${HUB_ADDRESS}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${HUB_TOKEN}` } },
    }),
  );
  const call = async (tool: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name: tool, arguments: args })) as { content: { text?: string }[] })
      .content[0]?.text ?? '';
  return { client, call };
}

test('канбан: задачи колонками, перенос перетаскиванием и касанием', async ({ browser }) => {
  const board = `e2e-kanban-${Date.now()}`;
  const { client, call } = await mcpClient('e2e-kanban');
  await call('create_board', { board, name: 'Канбан-тест' });
  await call('add_elements', {
    board,
    items: [
      { text: 'Заказать плитку', task: { status: 'todo' } },
      { text: 'Вызвать электрика', task: { status: 'todo', high: true } },
    ],
  });
  const page = await openDevice(browser, { ...synced, board });
  await expect.poll(() => elements(page)).toBe(2);
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByTestId('open-kanban').click();
  const kanban = page.getByTestId('kanban');
  await kanban.getByRole('tab', { name: 'Канбан-тест' }).click();
  const todo = page.getByTestId('kanban-todo');
  const doing = page.getByTestId('kanban-doing');
  const done = page.getByTestId('kanban-done');
  await expect(todo.getByTestId('kanban-card')).toHaveCount(2);
  // Перетащить карточку в «В работе».
  const card = todo.getByTestId('kanban-card').filter({ hasText: 'Заказать плитку' });
  const from = (await card.boundingBox())!;
  const to = (await doing.boundingBox())!;
  await page.mouse.move(from.x + 30, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 10 });
  await page.mouse.up();
  await expect(doing.getByTestId('kanban-card')).toHaveCount(1);
  await expect(doing).toContainText('Заказать плитку');
  // Касание — действия: «→ Готово».
  await todo.getByTestId('kanban-card').click();
  await todo.getByTestId('kanban-actions').getByRole('button', { name: '→ Готово' }).click();
  await expect(done.getByTestId('kanban-card')).toHaveCount(1);
  await page.screenshot({ path: shot('kanban.png') });
  await expect
    .poll(async () => {
      const l = JSON.parse(await call('list_tasks', { board })) as {
        tasks: { text: string; task: { status: string } }[];
      }[];
      return Object.fromEntries(l.flatMap((b) => b.tasks.map((t) => [t.text, t.task.status])));
    })
    .toEqual({ 'Заказать плитку': 'doing', 'Вызвать электрика': 'done' });
  await client.close();
  await page.context().close();
});

test('планшет: документ — заголовок, чек-лист и фрагмент доски касаниями; агент читает и дописывает', async ({
  browser,
}) => {
  const board = `e2e-doc-board-${Date.now()}`;
  const { client, call } = await mcpClient('e2e-pages');
  await call('create_board', { board, name: 'Кухня' });
  await call('add_frame', { board, name: 'Схема', x: 0, y: 0, w: 600, h: 400 });
  await call('add_elements', { board, items: [{ text: 'Мойка у окна' }], at: { x: 60, y: 60 } });

  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [SETTINGS_KEY, JSON.stringify({ ...synced, board })] as const,
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[документ] ошибка страницы: ${e.message}`));
  await page.goto(WORKSPACE_URL);
  await page.waitForFunction(() => window.__kayospace?.engine);

  // Новый документ — из списка досок.
  await page.getByTestId('board-title').tap();
  await page.getByLabel('Найти или создать доску').fill('План ремонта');
  await page.getByTestId('create-page').tap();
  const view = page.getByTestId('page-view');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('page-title')).toHaveValue('План ремонта');
  await expect(page.getByTestId('board-title')).toHaveText('План ремонта');

  // Текст и заголовок — кнопкой.
  const editor = page.getByTestId('page-editor');
  await editor.fill('Закупки');
  await view.getByRole('button', { name: 'Заголовок', exact: true }).tap();
  await expect(editor.locator('h1')).toHaveText('Закупки');

  // Агент находит документ и дописывает чек-лист.
  const list = JSON.parse(await call('list_boards', {})) as {
    id: string;
    name: string;
    kind: string;
  }[];
  const doc = list.find((b) => b.name === 'План ремонта');
  expect(doc).toMatchObject({ kind: 'page' });
  await expect.poll(() => call('read_page', { page: doc!.id })).toContain('# Закупки');
  await call('write_page', {
    page: doc!.id,
    markdown: '- [ ] Купить плитку\n- [ ] Позвонить мастеру',
  });
  const items = editor.locator('ul[data-type="taskList"] > li');
  await expect(items).toHaveCount(2);
  // Отметить пункт — касанием.
  await items.first().getByRole('checkbox').tap();
  await expect.poll(() => call('read_page', { page: doc!.id })).toContain('- [x] Купить плитку');

  // Фрагмент доски: доска → фрейм.
  await page.getByTestId('embed-open').tap();
  const picker = page.getByTestId('embed-picker');
  await picker.getByTestId('embed-board').filter({ hasText: 'Кухня' }).tap();
  await picker.getByTestId('embed-frame').filter({ hasText: 'Схема' }).tap();
  const embed = page.getByTestId('page-embed');
  await expect(embed).toHaveCount(1);
  await expect
    .poll(() => embed.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(100);
  await expect
    .poll(() => call('read_page', { page: doc!.id }))
    .toMatch(new RegExp(`\\[\\[board:${board}#[A-Za-z0-9_-]+\\|Схема\\]\\]`));
  await page.screenshot({ path: shot('page.png') });

  // Касание фрагмента открывает доску.
  await embed.getByRole('button', { name: 'Открыть', exact: true }).tap();
  await expect(view).toHaveCount(0);
  await expect(page.getByTestId('board-title')).toHaveText('Кухня');
  await page.waitForFunction(() => window.__kayospace?.engine);
  await client.close();
  await context.close();
});
