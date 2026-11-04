/**
 * Запуск хаба: pnpm hub
 * Переменные окружения: PORT (4000), HOST (0.0.0.0), DATA_DIR (./data).
 */

import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { HUB_VERSION, startHub } from './hub';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? 'data');

const hub = await startHub({ port, host, dataDir });

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a!.address);

console.log(`Kayospace hub ${HUB_VERSION}`);
console.log(`  данные:        ${dataDir}`);
console.log(`  MCP (агенты):  http://localhost:${hub.port}/mcp`);
console.log(`  синхронизация: ws://localhost:${hub.port}/sync/<доска>`);
for (const ip of lan) console.log(`  для планшета:  ws://${ip}:${hub.port}`);
console.log('');
console.log(
  `Claude Code: claude mcp add --transport http kayospace http://localhost:${hub.port}/mcp`,
);

const stop = async (): Promise<void> => {
  console.log('\nОстанавливаю хаб, сохраняю доски…');
  await hub.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
