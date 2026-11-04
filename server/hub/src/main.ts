/**
 * Запуск хаба: pnpm hub
 * Переменные окружения: PORT (4000), HOST (0.0.0.0), DATA_DIR (./data),
 * HUB_TOKEN (токен доступа — обязателен, если хаб в интернете), PUBLIC_HOST (домен хаба за HTTPS).
 */

import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { HUB_VERSION, startHub } from './hub';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const token = process.env.HUB_TOKEN?.trim() || undefined;
const publicHost = process.env.PUBLIC_HOST?.trim() || undefined;

if (!token && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.warn(
    'Внимание: HUB_TOKEN не задан — синхронизация открыта всем в сети. Для интернета задайте HUB_TOKEN.',
  );
}

const hub = await startHub({ port, host, dataDir, token, publicHost });

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a!.address);

console.log(`Kayospace hub ${HUB_VERSION}${token ? ' (доступ по токену)' : ''}`);
if (publicHost) console.log(`  публичный адрес: https://${publicHost}`);
console.log(`  данные:        ${dataDir}`);
console.log(`  MCP (агенты):  http://localhost:${hub.port}/mcp`);
console.log(`  синхронизация: ws://localhost:${hub.port}/sync/<доска>`);
for (const ip of lan) console.log(`  для планшета:  ws://${ip}:${hub.port}`);
console.log('');
const mcpUrl = publicHost ? `https://${publicHost}/mcp` : `http://localhost:${hub.port}/mcp`;
const header = token ? ' --header "Authorization: Bearer <HUB_TOKEN>"' : '';
console.log(`Claude Code: claude mcp add --transport http kayospace ${mcpUrl}${header}`);

const stop = async (): Promise<void> => {
  console.log('\nОстанавливаю хаб, сохраняю доски…');
  await hub.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
