#!/usr/bin/env node
// Поддельный Claude Code для тестов исполнителя: читает --mcp-config, добавляет стикер
// в доску из задания через MCP и печатает итог, как `claude -p --output-format json`.
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const cfg = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const server = cfg.mcpServers.kayospace;
const board = /Доска: ([A-Za-z0-9_-]+)\./.exec(prompt)?.[1];
const client = new Client({ name: 'fake-claude', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  }),
);
await client.callTool({
  name: 'add_sticky',
  arguments: { board, text: 'Черновик от ИИ', x: 500, y: 0 },
});
await client.close();
console.log(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Добавил стикер.',
  }),
);
