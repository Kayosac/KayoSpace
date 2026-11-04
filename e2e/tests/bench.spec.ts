import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BENCH_PORT } from './env';

interface Bench {
  elements: number;
  loadMs: number;
  fullPaint: Record<string, { p50: number; max: number; visible: number }>;
  pan: Record<string, { frameP50: number; frameP95: number; paintP50: number; paintP95: number }>;
  zoom: { frameP50: number; frameP95: number; paintP50: number; paintP95: number };
}

/**
 * Пороги — с запасом на машины CI без видеокарты. Кадр браузера — 16,7 мс.
 * Сдвиг — каждый кадр (60 кадров/с). Зум растягивает картинку композитором браузера: в обычном Chrome
 * это тоже 60 кадров/с (в том числе при замедлении процессора в 3 раза), а урезанный безголовый Chromium
 * на машинах GitHub композит программно — там требуем не меньше 30 кадров/с (до оптимизации было ~1,5).
 */
test('доска на 20 000 объектов: загрузка, сдвиг и зум без рывков', async ({ page }) => {
  page.on('pageerror', (e) => console.log(`ошибка стенда: ${e.message}`));
  await page.goto(`http://localhost:${BENCH_PORT}/bench.html`);
  await page.waitForFunction(() => (window as { __bench?: unknown }).__bench, null, {
    timeout: 240_000,
  });
  const r = (await page.evaluate(() => (window as { __bench?: unknown }).__bench)) as
    Bench | { error: string };
  if ('error' in r) throw new Error(r.error);

  const rows = [
    `| Замер (20 000 объектов) | Результат |`,
    `| --- | --- |`,
    `| Загрузка доски | ${r.loadMs} мс |`,
    ...Object.entries(r.fullPaint).map(
      ([k, v]) => `| Полная отрисовка, ${k} (${v.visible} на экране) | ${v.p50} мс |`,
    ),
    ...Object.entries(r.pan).map(
      ([k, v]) => `| Сдвиг, ${k}: кадр p50 / p95 | ${v.frameP50} / ${v.frameP95} мс |`,
    ),
    `| Зум щипком: кадр p50 / p95 | ${r.zoom.frameP50} / ${r.zoom.frameP95} мс |`,
  ];
  console.log(rows.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`);
  }

  expect(r.elements).toBe(20_000);
  expect(r.loadMs).toBeLessThan(3000);
  for (const [name, v] of Object.entries(r.pan)) {
    expect(v.frameP50, `сдвиг ${name}`).toBeLessThan(25);
  }
  expect(r.zoom.frameP50, 'зум').toBeLessThan(35);
  expect(r.fullPaint['всё']!.p50, 'вся доска на экране').toBeLessThan(250);
});
