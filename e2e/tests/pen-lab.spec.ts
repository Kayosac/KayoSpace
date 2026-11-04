import { expect, test } from '@playwright/test';
import { HUB_ADDRESS, HUB_TOKEN, PEN_LAB_URL, drawWave, hubElements, shot } from './env';

test('Pen Lab: синхронизация устанавливается, держится и доносит штрих до хаба', async ({
  page,
  request,
}) => {
  const board = 'e2e-penlab';
  await page.addInitScript(
    ([hubUrl, hubToken, board]) => {
      localStorage.setItem(
        'kayospace.penlab.v1',
        JSON.stringify({ hubUrl, hubToken, board, syncOn: true }),
      );
    },
    [HUB_ADDRESS, HUB_TOKEN, board],
  );
  await page.goto(PEN_LAB_URL);
  const badge = page.locator('#sync-badge');
  await expect(badge).toHaveText(/синхронизировано/);
  // Регрессия 0.5.0: синхронизация перезапускалась каждый кадр и не доходила до «синхронизировано».
  await page.waitForTimeout(2000);
  await expect(badge).toHaveText(/синхронизировано/);

  const box = (await page.locator('#stage').boundingBox())!;
  await drawWave(page, box.x + box.width * 0.3, box.y + box.height * 0.5);
  await expect.poll(() => hubElements(request, board)).toBe(1);
  await page.screenshot({ path: shot('pen-lab.png') });
});
