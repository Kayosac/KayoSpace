import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addElements, makeDocCard, makeFrame, makeSticky, setBoardName } from '@kayospace/board';
import { addRow, initTable, readTable, writePage } from '@kayospace/page';
import type { Actor } from '@kayospace/model';
import { startHub, type Hub } from './hub';
import { pagePages, tablePages } from './doc-render';

const me: Actor = { kind: 'human', name: 'я' };

describe('документы картинкой и PDF (решение 0022)', () => {
  let dir: string;
  let hub: Hub;
  const base = () => `http://127.0.0.1:${hub.port}`;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-docexp-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
  });
  afterEach(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('длинный документ — несколько страниц; таблица — шапка на каждой', async () => {
    const page = await hub.store.get('pg_long');
    setBoardName(page, 'Длинный');
    writePage(
      page,
      Array.from({ length: 80 }, (_, i) => `## Пункт ${i}\n\nТекст **абзаца** номер ${i}.`).join(
        '\n\n',
      ),
    );
    const pages = await pagePages(page, async () => null);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]).toContain('Длинный');
    const table = await hub.store.get('tb_big');
    initTable(table);
    const name = readTable(table).columns[0]!.id;
    for (let i = 0; i < 120; i++) addRow(table, { [name]: `Строка ${i}` });
    const tp = tablePages(table);
    expect(tp.length).toBeGreaterThan(2);
    for (const p of tp) expect(p).toContain('Название');
  });

  it('миниатюра в /api/docs, PDF документа, таблицы и доски', async () => {
    const page = await hub.store.get('pg_plan');
    setBoardName(page, 'План');
    writePage(page, '# Кухня\n\n- [x] Плитка\n- [ ] Клей\n\n[[board:kitchen]]');
    const board = await hub.store.get('kitchen');
    addElements(board, [
      makeFrame('Схема', { x: 0, y: 0, w: 400, h: 300 }, { actor: me }),
      makeSticky('Мойка', { x: 40, y: 40, actor: me }),
      makeDocCard('pg_plan', { x: 600, y: 0 }, { title: 'План', actor: me }),
    ]);
    const r = (await (await fetch(`${base()}/api/docs?ids=pg_plan`)).json()) as {
      docs: { thumb: string | null }[];
    };
    const thumb = r.docs[0]!.thumb;
    expect(thumb).toMatch(/^[0-9a-f]{64}$/);
    const img = await fetch(`${base()}/api/assets/${thumb}`);
    expect(img.headers.get('content-type')).toBe('image/png');
    // Не менялся — та же миниатюра.
    const again = (await (await fetch(`${base()}/api/docs?ids=pg_plan`)).json()) as typeof r;
    expect(again.docs[0]!.thumb).toBe(thumb);
    for (const id of ['pg_plan', 'kitchen']) {
      const pdf = await fetch(`${base()}/api/export/${id}.pdf`);
      expect(pdf.status).toBe(200);
      const bytes = Buffer.from(await pdf.arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(bytes.toString('latin1')).toMatch(/\/Count 1 /);
    }
    expect((await fetch(`${base()}/api/export/nope.pdf`)).status).toBe(404);
  });
});
