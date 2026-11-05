/**
 * Запуск хаба: pnpm hub
 * Переменные окружения: PORT (4000), HOST (0.0.0.0), DATA_DIR (./data),
 * HUB_TOKEN (ключ администратора — обязателен, если хаб в интернете), PUBLIC_HOST (домен хаба за HTTPS),
 * PUBLIC_URL (внешний адрес для ссылок подключения, например https://1-2-3-4.sslip.io:8443),
 * BACKUP_INTERVAL_HOURS (как часто снимать резервную копию досок, 6; 0 — не снимать).
 */

import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { HUB_VERSION, startHub } from './hub';
import { openAiFromEnv } from './openai';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const token = process.env.HUB_TOKEN?.trim() || undefined;
const publicHost = process.env.PUBLIC_HOST?.trim() || undefined;
/** «https://x.sslip.io:443/» → «https://x.sslip.io»: стандартный порт в QR не нужен. */
function originOf(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url.trim()).origin;
  } catch {
    console.warn(`PUBLIC_URL не похож на адрес: ${url}`);
    return undefined;
  }
}
const publicUrl = originOf(process.env.PUBLIC_URL);
const internalHosts = (process.env.INTERNAL_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

if (!token && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.warn(
    'Внимание: HUB_TOKEN не задан — синхронизация открыта всем в сети. Для интернета задайте HUB_TOKEN.',
  );
}

const backupHours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 6);
const backupIntervalMs = Number.isFinite(backupHours) ? Math.max(0, backupHours) * 3_600_000 : 0;

const openai = openAiFromEnv();

const hub = await startHub({
  port,
  host,
  dataDir,
  token,
  publicHost,
  publicUrl,
  internalHosts,
  backupIntervalMs,
  openai,
  // Для проверок: версии истории — почти сразу (по умолчанию — после 2 минут затишья).
  ...(process.env.HISTORY_QUIET_MS ? { historyQuietMs: Number(process.env.HISTORY_QUIET_MS) } : {}),
  ...(process.env.HISTORY_GAP_MS ? { historyGapMs: Number(process.env.HISTORY_GAP_MS) } : {}),
});

const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);
const lan = loopbackOnly
  ? []
  : Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a!.address);

console.log(`Kayospace hub ${HUB_VERSION}${token ? ' (доступ по токену)' : ''}`);
if (publicHost) console.log(`  публичный адрес: https://${publicHost}`);
console.log(`  данные:        ${dataDir}`);
console.log(
  backupIntervalMs > 0
    ? `  копии:         ${hub.backups.dir} (раз в ${backupHours} ч, если были изменения)`
    : '  копии:         выключены (BACKUP_INTERVAL_HOURS=0)',
);
console.log(
  openai
    ? `  OpenAI:        картинки (${openai.imageModel ?? 'gpt-image-2'}) и голос — включены`
    : '  OpenAI:        выключен (нет OPENAI_API_KEY): «нарисуй» — силами Claude, голоса нет',
);
if (loopbackOnly) console.log('  доступен только с этого компьютера (127.0.0.1)');
console.log(`  MCP (агенты):  http://localhost:${hub.port}/mcp`);
console.log(`  синхронизация: ws://localhost:${hub.port}/sync/<доска>`);
for (const ip of lan) console.log(`  для планшета:  ws://${ip}:${hub.port}`);
console.log('');
const mcpUrl = publicHost ? `https://${publicHost}/mcp` : `http://localhost:${hub.port}/mcp`;
const header = token ? ' --header "Authorization: Bearer <HUB_TOKEN>"' : '';
console.log(`Claude Code: claude mcp add --transport http kayospace ${mcpUrl}${header}`);
console.log('Подключить устройство: pnpm pair (QR и код в терминале)');

const stop = async (): Promise<void> => {
  console.log('\nОстанавливаю хаб, сохраняю доски…');
  await hub.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
