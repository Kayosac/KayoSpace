#!/usr/bin/env node
/**
 * `pnpm dev`: локальный хаб + приложение, сразу подключённые друг к другу.
 *
 *   - Хаб слушает только 127.0.0.1 и работает без токена (его не видно ни в сети, ни в интернете).
 *     Данные — в .dev-hub/ в корне репозитория, отдельно от настоящих досок.
 *   - Если хаб без токена уже запущен на этом порту (`pnpm hub`), используем его.
 *   - Приложение получает адрес в VITE_DEV_HUB и подключается само, без экрана подключения.
 *     В собранных версиях этого режима нет (см. apps/workspace/src/config.ts).
 *   - `tauri android dev` (задан TAURI_DEV_HOST): планшет не достучится до 127.0.0.1 компьютера,
 *     поэтому запускается только приложение, а к хабу планшет подключается как обычно.
 *
 * Переменные: KAYOSPACE_DEV_HUB_PORT (4000), KAYOSPACE_DEV_PORT (5180), KAYOSPACE_DEV_DATA (.dev-hub).
 * Остальные аргументы уходят Vite.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hubPort = Number(process.env.KAYOSPACE_DEV_HUB_PORT ?? 4000);
const appPort = process.env.KAYOSPACE_DEV_PORT;
const dataDir = resolve(root, process.env.KAYOSPACE_DEV_DATA ?? '.dev-hub');
const viteArgs = process.argv.slice(2).filter((a) => a !== '--');
const hubUrl = `http://127.0.0.1:${hubPort}`;

const children = [];
let stopping = false;

function run(name, args, env) {
  const child = spawn('pnpm', args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.log(`\n[dev] ${name} завершился (${signal ?? code}) — останавливаю остальное`);
    stop(code ?? 1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

/** Что отвечает хаб на этом порту: null — никто не отвечает. */
async function health() {
  try {
    const res = await fetch(`${hubUrl}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function startHub() {
  const existing = await health();
  if (existing?.ok && !existing.auth) {
    console.log(`[dev] использую уже запущенный хаб ${hubUrl}`);
    return;
  }
  if (existing?.ok) {
    console.error(
      `[dev] на ${hubUrl} работает хаб с токеном — для разработки нужен хаб без токена.\n` +
        `      Остановите его или задайте другой порт: KAYOSPACE_DEV_HUB_PORT=4001 pnpm dev`,
    );
    process.exit(1);
  }
  console.log(`[dev] локальный хаб ${hubUrl} (только этот компьютер), данные: ${dataDir}`);
  run('хаб', ['--filter', '@kayospace/hub', 'dev'], {
    HOST: '127.0.0.1',
    PORT: String(hubPort),
    DATA_DIR: dataDir,
    // Токен из окружения не наследуем: локальный хаб открыт только для 127.0.0.1.
    HUB_TOKEN: '',
    PUBLIC_HOST: '',
    PUBLIC_URL: '',
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if ((await health())?.ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error('[dev] хаб не запустился за 30 секунд');
  stop(1);
}

const lan = Boolean(process.env.TAURI_DEV_HOST);
if (!lan) await startHub();
if (!stopping) {
  const args = ['--filter', '@kayospace/workspace', 'dev'];
  const extra = [...viteArgs, ...(appPort ? ['--port', appPort] : [])];
  args.push(...extra);
  run('приложение', args, lan ? {} : { VITE_DEV_HUB: hubUrl });
}
