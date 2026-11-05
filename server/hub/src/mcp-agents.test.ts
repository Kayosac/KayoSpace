import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElement, listElements, makeFrame, makeSticky, makeStroke } from '@kayospace/board';
import type { Actor, CanvasElement } from '@kayospace/model';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'test' };
let dir: string;
let hub: Hub;
let client: Client;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kayospace-mcp-agents-'));
  hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 20 });
  client = new Client({ name: 'agents-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
  );
});

afterAll(async () => {
  await client.close();
  await hub.close();
  await rm(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
  };
  return r;
};
const textOf = (r: Awaited<ReturnType<typeof call>>) =>
  r.content.map((c) => c.text ?? '').join('\n');
const els = async (board: string): Promise<CanvasElement[]> =>
  listElements(await hub.store.get(board));

describe('MCP для агентов: раскладка, картинка, поиск', () => {
  it('инструкции для модели приходят при подключении', () => {
    expect(client.getInstructions()).toContain('add_elements');
  });

  it('add_elements: пачка стикеров сеткой в новом фрейме — одним изменением', async () => {
    const doc = await hub.store.get('ideas');
    addElement(doc, makeSticky('Своё', { x: 0, y: 0, actor: me }));
    let updates = 0;
    doc.on('update', () => updates++);
    const r = await call('add_elements', {
      board: 'ideas',
      items: [{ text: 'Один' }, { text: 'Два' }, { text: 'Три' }, { type: 'text', text: 'Итог' }],
      newFrame: 'Идеи агента',
    });
    expect(r.isError).toBeFalsy();
    expect(updates).toBe(1);
    const out = JSON.parse(textOf(r)) as {
      added: { id: string; x: number; y: number }[];
      frame: string;
    };
    expect(out.added).toHaveLength(4);
    const all = await els('ideas');
    const frame = all.find((e) => e.id === out.frame)!;
    expect(frame.type).toBe('frame');
    // Всё новое — внутри фрейма, и фрейм не налезает на то, что было.
    for (const a of out.added) {
      const el = all.find((e) => e.id === a.id)!;
      expect(el.x).toBeGreaterThanOrEqual(frame.x);
      expect(el.x + el.w).toBeLessThanOrEqual(frame.x + frame.w);
      expect(el.y + el.h).toBeLessThanOrEqual(frame.y + frame.h);
      expect(el.createdBy).toEqual({ kind: 'agent', name: 'mcp' });
    }
    expect(frame.x).toBeGreaterThan(200);
    // Сетка 2×2: два разных x и два разных y.
    expect(new Set(out.added.map((a) => a.x)).size).toBe(2);
    expect(new Set(out.added.map((a) => a.y)).size).toBe(2);
  });

  it('add_elements во фрейм: под его содержимым, фрейм растягивается', async () => {
    const doc = await hub.store.get('week');
    const f = makeFrame('Неделя', { x: 0, y: 0, w: 300, h: 300 }, { actor: me });
    addElement(doc, f);
    addElement(doc, makeSticky('Было', { x: 40, y: 40, actor: me }));
    const r = await call('add_elements', {
      board: 'week',
      frame: f.id,
      layout: 'row',
      items: [{ text: 'Пн' }, { text: 'Вт' }, { text: 'Ср' }],
    });
    const out = JSON.parse(textOf(r)) as { added: { y: number }[] };
    expect(out.added.every((a) => a.y >= 264)).toBe(true);
    const frame = (await els('week')).find((e) => e.id === f.id)!;
    expect(frame.w).toBeGreaterThan(600);
    expect(frame.h).toBe(264 + 200 + 32);
    expect(
      (await call('add_elements', { board: 'week', frame: 'нет', items: [{ text: 'x' }] })).isError,
    ).toBe(true);
  });

  it('arrange_elements раскладывает столбцом; move_elements двигает фрейм с содержимым', async () => {
    const doc = await hub.store.get('mess');
    const a = makeSticky('А', { x: 500, y: 90, actor: me });
    const b = makeSticky('Б', { x: -300, y: 700, actor: me });
    addElement(doc, a);
    addElement(doc, b);
    await call('arrange_elements', {
      board: 'mess',
      ids: [a.id, b.id],
      layout: 'column',
      at: { x: 0, y: 0 },
      gap: 10,
    });
    let all = await els('mess');
    expect(all.find((e) => e.id === a.id)).toMatchObject({ x: 0, y: 0 });
    expect(all.find((e) => e.id === b.id)).toMatchObject({ x: 0, y: 210 });

    const f = makeFrame('Рамка', { x: -50, y: -50, w: 400, h: 600 }, { actor: me });
    addElement(doc, f);
    await call('move_elements', { board: 'mess', ids: [f.id], dx: 1000, dy: 0 });
    all = await els('mess');
    expect(all.find((e) => e.id === f.id)!.x).toBe(950);
    expect(all.find((e) => e.id === a.id)!.x).toBe(1000);
    expect(all.find((e) => e.id === b.id)!.x).toBe(1000);
  });

  it('view_board: PNG доски с рукописным и соответствие координат', async () => {
    const doc = await hub.store.get('ink');
    const pts = Array.from({ length: 30 }, (_, i) => ({
      x: i * 6,
      y: Math.sin(i / 4) * 30,
      p: 0.5,
      tx: 0,
      ty: 0,
      t: i * 8,
    }));
    addElement(doc, makeStroke(pts, { hasPressure: false, actor: me, style: { size: 4 } }));
    addElement(doc, makeSticky('Подпись', { x: 300, y: 0, actor: me }));
    const r = await call('view_board', { board: 'ink', maxSize: 512 });
    const img = r.content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    const png = Buffer.from(img.data!, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(512); // ширина — длинная сторона
    expect(textOf(r)).toMatch(/масштаб/);
    expect((await call('view_board', { board: 'нет-такой' })).isError).toBe(true);
  });

  it('search и fetch — в формате, понятном ChatGPT, со ссылкой на доску', async () => {
    const doc = await hub.store.get('notes');
    const s = makeSticky('Отпуск в июле', { x: 0, y: 0, actor: me });
    addElement(doc, s);
    const found = JSON.parse(textOf(await call('search', { query: 'отпуск' }))) as {
      results: { id: string; title: string; url: string }[];
    };
    expect(found.results[0]).toMatchObject({
      id: `notes#${s.id}`,
      url: `kayospace://board/notes?element=${s.id}`,
    });
    const doc2 = JSON.parse(textOf(await call('fetch', { id: found.results[0]!.id }))) as {
      text: string;
      url: string;
    };
    expect(doc2.text).toContain('Отпуск в июле');
    expect((await call('fetch', { id: 'нет#x' })).isError).toBe(true);
  });
});

describe('кто из агентов пишет', () => {
  it('приложение по OAuth, иначе клиент по User-Agent', async () => {
    const { agentNameFor } = await import('./mcp');
    const h = (ua: string) => ({ headers: { 'user-agent': ua } });
    expect(agentNameFor(h('node'), 'ChatGPT')).toBe('ChatGPT');
    expect(agentNameFor(h('claude-code/2.1.0'), null)).toBe('claude-code');
    expect(agentNameFor(h('openai-mcp/1.0'), null)).toBe('chatgpt');
    expect(agentNameFor(h('curl/8'), null)).toBe('mcp');
    expect(agentNameFor(h('x'), '<script>Claude</script>')).toBe('scriptClaudescript');
  });
});

describe('подсказки для клиентов', () => {
  it('чтение помечено readOnlyHint (ChatGPT не спрашивает подтверждения), удаление — destructiveHint', async () => {
    const { tools } = await client.listTools();
    const ro = tools
      .filter((t) => t.annotations?.readOnlyHint)
      .map((t) => t.name)
      .sort();
    expect(ro).toEqual([
      'fetch',
      'get_changes',
      'get_image',
      'list_boards',
      'list_deleted_boards',
      'list_projects',
      'list_trash',
      'list_versions',
      'read_board',
      'search',
      'view_board',
    ]);
    expect(tools.find((t) => t.name === 'delete_elements')!.annotations?.destructiveHint).toBe(
      true,
    );
  });
});
