/**
 * Запуск исполнителя ИИ: pnpm ai-worker
 * Переменные: HUB_URL (адрес хаба), HUB_TOKEN, WORKER_NAME (как показывать), CLAUDE_MODEL (sonnet),
 * CLAUDE_BIN (claude). Claude Code должен быть установлен и войти в аккаунт: на сервере —
 * переменная CLAUDE_CODE_OAUTH_TOKEN из `claude setup-token`, на компьютере — обычный вход `claude`.
 */

import { hostname } from 'node:os';
import { workLoop } from './worker';

const hubUrl = process.env.HUB_URL?.trim();
const token = process.env.HUB_TOKEN?.trim() ?? '';
if (!hubUrl) {
  console.error('Задайте HUB_URL — адрес хаба, например https://1-2-3-4.sslip.io:8443');
  process.exit(1);
}

const name = process.env.WORKER_NAME?.trim() || hostname();
console.log(`Исполнитель ИИ «${name}» → ${hubUrl}. Жду задачи…`);
const ctrl = new AbortController();
process.on('SIGINT', () => ctrl.abort());
process.on('SIGTERM', () => ctrl.abort());
await workLoop({
  hubUrl,
  token,
  name,
  ...(process.env.CLAUDE_BIN ? { claudeBin: process.env.CLAUDE_BIN } : {}),
  ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
  signal: ctrl.signal,
});
