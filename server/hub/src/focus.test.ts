import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElements, makeDocCard, makeSticky, setBoardName } from '@kayospace/board';
import { writePage } from '@kayospace/page';
import type { Actor } from '@kayospace/model';
import { buildPrompt } from './ai';
import { chatContext, type ChatMessage } from './chat';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'я' };

describe('ИИ смотрит на видимое или выделенное (решение 0020)', () => {
  it('задание просит читать только область; всю доску — по прямой просьбе', () => {
    const prompt = buildPrompt({
      board: 'b',
      action: 'chat',
      prompt: 'что тут?',
      selection: [],
      area: { minX: 0, minY: 0, maxX: 1000, maxY: 600 },
      image: null,
    });
    expect(prompt).toContain('человек видит на экране');
    expect(prompt).toContain('region={"x":-40,"y":-40,"w":1080,"h":680}');
    expect(prompt).toContain('Всю доску (read_board без region)');
    const selected = buildPrompt({
      board: 'b',
      action: 'summarize',
      selection: ['a'],
      area: { minX: 10, minY: 10, maxX: 20, maxY: 20 },
      image: null,
      prompt: '',
    });
    expect(selected).toContain('человек выделил');
  });

  it('история разговора: последние реплики целиком, старые — кратко', () => {
    const long = 'слово '.repeat(200);
    const msgs: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: `${i}: ${long}`,
      at: i,
    }));
    const lines = chatContext(msgs).split('\n').slice(1);
    expect(lines).toHaveLength(8);
    expect(lines[0]!.length).toBeLessThan(200);
    expect(lines[7]!.length).toBeGreaterThan(1000);
  });
});

describe('read_board с region', () => {
  let dir: string;
  let hub: Hub;
  let client: Client;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-focus-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
    client = new Client({ name: 'focus-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
  });
  afterEach(async () => {
    await client.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('только элементы в области; JSON и markdown', async () => {
    const doc = await hub.store.get('big');
    addElements(doc, [
      makeSticky('Видно', { x: 0, y: 0, actor: me }),
      makeSticky('Далеко', { x: 5000, y: 5000, actor: me }),
    ]);
    const read = async (args: Record<string, unknown>) =>
      (
        (await client.callTool({ name: 'read_board', arguments: { board: 'big', ...args } })) as {
          content: { text: string }[];
        }
      ).content[0]!.text;
    const region = { x: -50, y: -50, w: 500, h: 500 };
    const md = await read({ region });
    expect(md).toContain('Видно');
    expect(md).not.toContain('Далеко');
    expect(md).toContain('1 из 2 элементов');
    const json = JSON.parse(await read({ format: 'json', region })) as {
      elements: unknown[];
      totalElements: number;
    };
    expect(json.elements).toHaveLength(1);
    expect(json.totalElements).toBe(2);
    expect(await read({})).toContain('Далеко');
  });

  it('карточка документа в области — сразу с содержимым и фрагментом доски', async () => {
    const page = await hub.store.get('pg_notes');
    setBoardName(page, 'Заметки');
    writePage(page, '# Смета\n\nПлитка — 1200\n\n[[board:big|Схема]]');
    const doc = await hub.store.get('big');
    addElements(doc, [
      makeSticky('На схеме', { x: 0, y: 0, actor: me }),
      makeDocCard('pg_notes', { x: 300, y: 0 }, { title: 'Заметки', actor: me }),
    ]);
    const call = async (args: Record<string, unknown>) =>
      (
        (await client.callTool({ name: 'read_board', arguments: { board: 'big', ...args } })) as {
          content: { text: string }[];
        }
      ).content[0]!.text;
    const md = await call({ region: { x: -50, y: -50, w: 800, h: 400 } });
    expect(md).toContain('Документ «Заметки»');
    expect(md).toContain('Плитка — 1200');
    expect(md).toContain('На схеме');
    // Вне области — содержимого нет.
    expect(await call({ region: { x: 5000, y: 5000, w: 10, h: 10 } })).not.toContain('Плитка');
    const json = JSON.parse(
      await call({ format: 'json', region: { x: 250, y: -10, w: 400, h: 300 } }),
    ) as {
      documents: { doc: string }[];
    };
    expect(json.documents.map((d) => d.doc)).toEqual(['pg_notes']);
  });
});
