import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';

export const HUB_PORT = 4100;
export const HUB_TOKEN = 'e2e-token';
export const HUB_ADDRESS = `127.0.0.1:${HUB_PORT}`;
export const PEN_LAB_URL = 'http://localhost:4173/';
export const WORKSPACE_URL = 'http://localhost:4174/';

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
