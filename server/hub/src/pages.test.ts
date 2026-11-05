import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElements, listElements, makeFrame, makeSticky } from '@kayospace/board';
import { pageMarkdown } from '@kayospace/page';
import type { Actor } from '@kayospace/model';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'я' };

describe('документы (решение 0020)', () => {
  let dir: string;
  let hub: Hub;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-pages-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
    client = new Client({ name: 'pages-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
  });
  afterEach(async () => {
    await client.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('агент создаёт, дописывает и читает документ; он в списке и в поиске', async () => {
    expect((await call('write_page', { page: 'pg_plan', markdown: '# Шаг' })).isError).toBe(true);
    const made = await call('write_page', {
      page: 'pg_plan',
      name: 'План ремонта',
      markdown: '# Кухня\n\n- [ ] Заказать плитку',
    });
    expect(made.content[0]!.text).toContain('Документ создан');
    await call('write_page', { page: 'pg_plan', markdown: '[[board:kitchen#fr1|Схема]]' });
    const read = (await call('read_page', { page: 'pg_plan' })).content[0]!.text;
    expect(read).toContain('# План ремонта');
    expect(read).toContain('- [ ] Заказать плитку');
    expect(read).toContain('[[board:kitchen#fr1|Схема]]');
    const doc = await hub.store.get('pg_plan');
    expect(pageMarkdown(doc)).toBe(
      '# Кухня\n\n- [ ] Заказать плитку\n\n[[board:kitchen#fr1|Схема]]',
    );

    const list = JSON.parse((await call('list_boards', {})).content[0]!.text) as {
      id: string;
      kind: string;
      name: string;
    }[];
    expect(list.find((b) => b.id === 'pg_plan')).toMatchObject({
      kind: 'page',
      name: 'План ремонта',
    });

    const found = JSON.parse((await call('search', { query: 'плитку' })).content[0]!.text) as {
      results: { board: string; type: string }[];
    };
    expect(found.results).toEqual([expect.objectContaining({ board: 'pg_plan', type: 'page' })]);
    const fetched = JSON.parse((await call('fetch', { id: 'pg_plan' })).content[0]!.text) as {
      text: string;
    };
    expect(fetched.text).toContain('Заказать плитку');

    // Стикеры в документ не кладут.
    const bad = await call('add_sticky', { board: 'pg_plan', text: 'x' });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('read_page');
  });

  it('картинка фрейма для фрагмента в документе', async () => {
    const doc = await hub.store.get('kitchen');
    const frame = makeFrame('Схема', { x: 0, y: 0, w: 400, h: 300 }, { actor: me });
    addElements(doc, [frame, makeSticky('Мойка', { x: 50, y: 50, actor: me })]);
    const base = `http://127.0.0.1:${hub.port}/api/render/kitchen.png`;
    const png = await fetch(`${base}?frame=${frame.id}&max=400`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(500);
    expect((await fetch(`${base}?frame=nope`)).status).toBe(404);
    const frames = (await (
      await fetch(`http://127.0.0.1:${hub.port}/api/frames/kitchen`)
    ).json()) as { frames: unknown[] };
    expect(frames.frames).toEqual([{ id: frame.id, name: 'Схема' }]);
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/render/empty.png`)).status).toBe(404);
  });

  it('таблица: агент создаёт, дописывает и меняет строки; карточка на доске', async () => {
    const made = await call('write_table', {
      table: 'tb_buy',
      name: 'Закупки',
      columns: [
        { name: 'Что', type: 'text' },
        { name: 'Цена', type: 'number' },
        { name: 'Куплено', type: 'checkbox' },
      ],
      rows: [{ values: { Что: 'Плитка', Цена: '1 200' } }, { values: { Что: 'Клей', Цвет: 'x' } }],
    });
    expect(made.content[0]!.text).toContain('Таблица создана');
    expect(made.content[0]!.text).toContain('колонок нет: Цвет');
    const json = JSON.parse(
      (await call('read_table', { table: 'tb_buy', format: 'json' })).content[0]!.text,
    ) as {
      rows: { id: string; values: Record<string, unknown> }[];
    };
    expect(json.rows[0]!.values).toEqual({ Что: 'Плитка', Цена: 1200, Куплено: null });
    await call('write_table', {
      table: 'tb_buy',
      rows: [{ id: json.rows[1]!.id, values: { Куплено: true } }],
    });
    const md = (await call('read_table', { table: 'tb_buy' })).content[0]!.text;
    expect(md).toContain('| Клей |  | ✓ |');
    expect(md).toContain('Цена — Число');
    const list = JSON.parse((await call('list_boards', {})).content[0]!.text) as {
      id: string;
      kind: string;
    }[];
    expect(list.find((b) => b.id === 'tb_buy')?.kind).toBe('table');
    const found = JSON.parse((await call('search', { query: 'клей' })).content[0]!.text) as {
      results: { board: string; type: string }[];
    };
    expect(found.results[0]).toMatchObject({ board: 'tb_buy', type: 'table' });

    // Карточка на доске; доска читается с подсказкой, как открыть.
    const placed = await call('place_doc', { board: 'home', doc: 'tb_buy' });
    expect(placed.isError).toBeFalsy();
    const card = listElements(await hub.store.get('home')).find((e) => e.type === 'doc');
    expect(card).toMatchObject({
      props: { doc: 'tb_buy', title: 'Закупки', excerpt: '2 строки · Что, Цена, Куплено' },
    });
    expect((await call('read_board', { board: 'home' })).content[0]!.text).toContain('read_table');
    const docs = (await (
      await fetch(`http://127.0.0.1:${hub.port}/api/docs?ids=tb_buy,pg_none`)
    ).json()) as { docs: unknown[] };
    expect(docs.docs).toEqual([
      { id: 'tb_buy', kind: 'table', title: 'Закупки', excerpt: '2 строки · Что, Цена, Куплено' },
    ]);
    // Картинка доски с карточкой рисуется.
    const png = await fetch(`http://127.0.0.1:${hub.port}/api/render/home.png`);
    expect(png.status).toBe(200);
    expect((await call('add_sticky', { board: 'tb_buy', text: 'x' })).isError).toBe(true);
  });
});
