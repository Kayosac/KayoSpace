import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElement, deleteElements, listElements, makeSticky } from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { keepVersions } from './history';
import { imageInfo } from './images';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'я' };
const bot: Actor = { kind: 'agent', name: 'claude-code' };
const H = 3_600_000;
const texts = (els: { type: string; props: unknown }[]) =>
  els.map((e) => (e.type === 'sticky' ? (e.props as { content: string }).content : '')).sort();

describe('какие версии хранить', () => {
  it('все за сутки, по одной в час неделю, по одной в день месяц', () => {
    const now = 100 * 24 * H;
    const times = [
      now - 10 * 60_000,
      now - 20 * 60_000, // сутки — обе
      now - 30 * H - 10 * 60_000,
      now - 30 * H - 20 * 60_000, // тот же час — одна
      now - 10 * 24 * H - H,
      now - 10 * 24 * H - 2 * H, // тот же день — одна
      now - 40 * 24 * H, // старше месяца — нет
    ];
    const keep = keepVersions(times, now);
    expect([...keep].sort((a, b) => b - a)).toEqual([times[0], times[1], times[2], times[4]]);
  });
});

describe('история версий на хабе', () => {
  let dir: string;
  let hub: Hub;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-history-'));
    hub = await startHub({
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      saveDelayMs: 10,
      historyQuietMs: 20,
      historyGapMs: 0,
    });
  });
  afterEach(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('версии после затишья; вернуть — новой правкой; копия рядом; картинка и MCP', async () => {
    const doc = await hub.store.get('plan');
    addElement(doc, makeSticky('Первая мысль', { x: 0, y: 0, actor: me }));
    await wait(120);
    const v1 = (await hub.history.versions('plan'))[0]!;
    expect(v1).toMatchObject({ elements: 1, authors: ['человек'] });

    // Агент всё снёс и написал своё.
    await wait(5);
    deleteElements(
      doc,
      listElements(doc).map((e) => e.id),
      'mcp',
    );
    addElement(doc, makeSticky('От агента', { x: 0, y: 0, actor: bot }));
    await wait(120);
    const list = await hub.history.versions('plan');
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ elements: 1, authors: ['claude-code'] });

    // REST: список, картинка, вернуть.
    const base = `http://127.0.0.1:${hub.port}/api/history/plan`;
    const rest = (await (await fetch(base)).json()) as { versions: { at: number }[] };
    expect(rest.versions.map((v) => v.at)).toEqual(list.map((v) => v.at));
    const png = Buffer.from(await (await fetch(`${base}/${v1.at}.png`)).arrayBuffer());
    expect(imageInfo(png)?.mime).toBe('image/png');
    const r = await fetch(`${base}/${v1.at}/restore`, { method: 'POST' });
    expect(await r.json()).toEqual({ changed: 2 });
    expect(texts(listElements(doc))).toEqual(['Первая мысль']);
    // Снёсенное возвратом — в корзине, а состояние до возврата — версией.
    await wait(30);
    expect((await hub.trash.list('plan')).map((t) => t.element.type)).toContain('sticky');

    // Копия версии — новая доска рядом.
    const c = (await (await fetch(`${base}/${list[0]!.at}/copy`, { method: 'POST' })).json()) as {
      id: string;
      name: string;
    };
    expect(c.name).toContain('версия от');
    expect(texts(listElements(await hub.store.get(c.id)))).toEqual(['От агента']);

    // MCP: список и возврат.
    const client = new Client({ name: 'history-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
    const listed = (await client.callTool({
      name: 'list_versions',
      arguments: { board: 'plan' },
    })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(listed.content[0]!.text).length).toBeGreaterThanOrEqual(2);
    const back = (await client.callTool({
      name: 'restore_version',
      arguments: { board: 'plan', at: list[0]!.at },
    })) as { content: { text: string }[] };
    expect(back.content[0]!.text).toContain('возвращена');
    expect(texts(listElements(doc))).toEqual(['От агента']);
    await client.close();
    expect((await fetch(`${base}/123/restore`, { method: 'POST' })).status).toBe(404);
  });

  it('без изменений новая версия не снимается', async () => {
    const doc = await hub.store.get('quiet');
    addElement(doc, makeSticky('a', { x: 0, y: 0, actor: me }));
    await wait(120);
    expect(await hub.history.snapshot('quiet')).toBeNull();
    expect(await hub.history.versions('quiet')).toHaveLength(1);
  });
});
