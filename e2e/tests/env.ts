import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';

export const HUB_PORT = 4100;
export const HUB_TOKEN = 'e2e-token';
export const HUB_ADDRESS = `127.0.0.1:${HUB_PORT}`;
export const PEN_LAB_URL = 'http://localhost:4173/';
export const WORKSPACE_URL = 'http://localhost:4174/';
/** `pnpm dev` в проверке режима разработки (порты не из списка запрещённых для fetch). */
export const DEV_HUB_PORT = 4211;
export const DEV_APP_PORT = 5211;
/** Стенд замера скорости (дев-сервер приложения). */
export const BENCH_PORT = 5213;

/** Скриншоты для просмотра (в CI уходят в ветку ci-previews). */
export function shot(name: string): string {
  const dir =
    process.env.SCREENSHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'screens');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/** Сколько элементов на доске у хаба (через REST с токеном). */
export async function hubElements(request: APIRequestContext, board: string): Promise<number> {
  const res = await request.get(`http://${HUB_ADDRESS}/api/boards`, {
    headers: { Authorization: `Bearer ${HUB_TOKEN}` },
  });
  if (!res.ok()) throw new Error(`хаб ответил ${res.status()}`);
  const boards = (await res.json()) as { id: string; elements: number }[];
  return boards.find((b) => b.id === board)?.elements ?? 0;
}

/** Выдать код подключения устройства (как `pnpm pair`) ключом администратора. */
export async function pairCode(request: APIRequestContext): Promise<string> {
  const res = await request.post(`http://${HUB_ADDRESS}/api/devices/pair`, {
    headers: { Authorization: `Bearer ${HUB_TOKEN}` },
  });
  if (!res.ok()) throw new Error(`хаб ответил ${res.status()}`);
  return ((await res.json()) as { code: string }).code;
}

/** Провести мышью волнистую линию от (x, y). */
export async function drawWave(page: Page, x: number, y: number, len = 300): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (len * i) / steps, y + Math.sin(i / 4) * 40);
  }
  await page.mouse.up();
}
