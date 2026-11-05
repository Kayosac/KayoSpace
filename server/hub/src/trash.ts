/**
 * Корзина (решение 0016): удалённое с доски — человеком на устройстве или агентом — 7 дней можно вернуть.
 *
 * Хаб следит за удалениями в каждой загруженной доске и запоминает удалённый элемент целиком
 * (`trash/<доска>.json`). Элемент вернулся (отмена на устройстве, восстановление) — из корзины убирается.
 * Вернуть из корзины — значит снова положить элемент в доску: устройства получат его по синхронизации.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  elementFromWire,
  elementToWire,
  elementsMap,
  isServiceDoc,
  type WireElement,
} from '@kayospace/board';
import type { CanvasElement } from '@kayospace/model';

export const TRASH_KEEP_MS = 7 * 24 * 3_600_000;
const MAX_ITEMS = 5000;

export interface TrashItem {
  element: CanvasElement;
  deletedAt: number;
  /** Кто удалил: агент (через MCP) или человек (с устройства). */
  by: 'agent' | 'device';
}

/** Пачка удалённого за одно действие — так её и показываем, и возвращаем. */
export interface TrashGroup {
  at: number;
  by: 'agent' | 'device';
  ids: string[];
  /** Что было в пачке: «Стикер «Купить молоко»», «3 штриха»… */
  preview: string;
}

interface Stored {
  element: WireElement;
  deletedAt: number;
  by: 'agent' | 'device';
}

const NAMES: Record<string, string> = {
  stroke: 'штрих',
  sticky: 'стикер',
  text: 'надпись',
  image: 'картинка',
  frame: 'фрейм',
  arrow: 'стрелка',
  shape: 'фигура',
};

export function describeGroup(items: readonly TrashItem[]): string {
  const textual = items
    .map((i) => i.element)
    .find((el) => el.type === 'sticky' || el.type === 'text' || el.type === 'frame');
  const label = textual
    ? `${NAMES[textual.type]} «${(textual.type === 'frame' ? textual.props.name : textual.props.content).replace(/\s+/g, ' ').slice(0, 40)}»`
    : (NAMES[items[0]!.element.type] ?? 'элемент');
  return items.length > 1 ? `${label} и ещё ${items.length - 1}` : label;
}

/** Удалённое одним действием (с разницей меньше 2 секунд и одним автором) — одна пачка. */
export function groupTrash(items: readonly TrashItem[]): TrashGroup[] {
  const sorted = [...items].sort((a, b) => b.deletedAt - a.deletedAt);
  const groups: { items: TrashItem[] }[] = [];
  for (const it of sorted) {
    // Своя пачка — у того же автора и не дальше 2 секунд (пачки разных авторов могут перемежаться).
    const g = groups.find((x) => {
      const last = x.items.at(-1)!;
      return last.by === it.by && last.deletedAt - it.deletedAt < 2000;
    });
    if (g) g.items.push(it);
    else groups.push({ items: [it] });
  }
  return groups.map((g) => ({
    at: g.items[0]!.deletedAt,
    by: g.items[0]!.by,
    ids: g.items.map((i) => i.element.id),
    preview: describeGroup(g.items),
  }));
}

export class Trash {
  private readonly boards = new Map<string, Map<string, TrashItem>>();
  private readonly loading = new Map<string, Promise<Map<string, TrashItem>>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly opts: {
      /** Origin правок агентов (MCP): по нему видно, кто удалил. */
      agentOrigin: unknown;
      /** Свой origin восстановления — такие добавления корзина не считает «отменой». */
      origin?: unknown;
      keepMs?: number;
      now?: () => number;
      saveDelayMs?: number;
    },
  ) {
    this.dir = join(dataDir, 'trash');
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Следить за удалениями в доске. */
  attach(board: string, doc: Y.Doc): void {
    if (isServiceDoc(board)) return;
    const map = elementsMap(doc);
    map.observe((event) => {
      const by = event.transaction.origin === this.opts.agentOrigin ? 'agent' : 'device';
      const removed: TrashItem[] = [];
      const back: string[] = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'delete' && change.oldValue) {
          removed.push({ element: change.oldValue as CanvasElement, deletedAt: this.now(), by });
        } else if (change.action === 'add') {
          back.push(key);
        }
      });
      if (removed.length || back.length) void this.apply(board, removed, back);
    });
  }

  private async apply(board: string, removed: TrashItem[], back: string[]): Promise<void> {
    const items = await this.items(board);
    for (const it of removed) items.set(it.element.id, it);
    for (const id of back) items.delete(id);
    this.scheduleSave(board);
  }

  /** Содержимое корзины доски — свежее первым, без просроченного. */
  async list(board: string): Promise<TrashItem[]> {
    const items = await this.items(board);
    return [...items.values()].sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async groups(board: string): Promise<TrashGroup[]> {
    return groupTrash(await this.list(board));
  }

  /** Вернуть элементы в доску. Возвращает, сколько вернулось. */
  async restore(board: string, doc: Y.Doc, ids: readonly string[]): Promise<number> {
    const items = await this.items(board);
    const back = ids.map((id) => items.get(id)).filter((i): i is TrashItem => !!i);
    if (back.length === 0) return 0;
    const map = elementsMap(doc);
    doc.transact(() => {
      for (const it of back) if (!map.has(it.element.id)) map.set(it.element.id, it.element);
    }, this.opts.origin ?? 'trash');
    for (const it of back) items.delete(it.element.id);
    this.scheduleSave(board);
    return back.length;
  }

  private file(board: string): string {
    return join(this.dir, `${board}.json`);
  }

  private items(board: string): Promise<Map<string, TrashItem>> {
    const ready = this.boards.get(board);
    if (ready) return Promise.resolve(this.prune(ready));
    let p = this.loading.get(board);
    if (!p) {
      p = this.read(board).then((m) => {
        this.boards.set(board, m);
        this.loading.delete(board);
        return m;
      });
      this.loading.set(board, p);
    }
    return p.then((m) => this.prune(m));
  }

  private async read(board: string): Promise<Map<string, TrashItem>> {
    const out = new Map<string, TrashItem>();
    try {
      const raw = JSON.parse(await readFile(this.file(board), 'utf8')) as Stored[];
      for (const s of raw) {
        out.set(s.element.id, {
          element: elementFromWire(s.element),
          deletedAt: s.deletedAt,
          by: s.by,
        });
      }
    } catch {
      /* корзины ещё нет */
    }
    return out;
  }

  private prune(items: Map<string, TrashItem>): Map<string, TrashItem> {
    const cutoff = this.now() - (this.opts.keepMs ?? TRASH_KEEP_MS);
    for (const [id, it] of items) if (it.deletedAt < cutoff) items.delete(id);
    if (items.size > MAX_ITEMS) {
      const old = [...items.values()].sort((a, b) => a.deletedAt - b.deletedAt);
      for (const it of old.slice(0, items.size - MAX_ITEMS)) items.delete(it.element.id);
    }
    return items;
  }

  private scheduleSave(board: string): void {
    if (this.timers.has(board)) return;
    this.timers.set(
      board,
      setTimeout(() => {
        this.timers.delete(board);
        void this.queueSave(board).catch((err) => console.error(`[hub] корзина ${board}`, err));
      }, this.opts.saveDelayMs ?? 500),
    );
  }

  private readonly saving = new Map<string, Promise<void>>();

  /** Записи одной корзины — по очереди; flush дожидается и тех, что уже идут. */
  private queueSave(board: string): Promise<void> {
    const next = (this.saving.get(board) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.save(board))
      .finally(() => {
        if (this.saving.get(board) === next) this.saving.delete(board);
      });
    this.saving.set(board, next);
    return next;
  }

  private async save(board: string): Promise<void> {
    const items = this.boards.get(board);
    if (!items) return;
    await mkdir(this.dir, { recursive: true });
    const data: Stored[] = [...this.prune(items).values()].map((it) => ({
      element: elementToWire(it.element),
      deletedAt: it.deletedAt,
      by: it.by,
    }));
    const tmp = `${this.file(board)}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.file(board));
  }

  /** Доску стёрли насовсем — корзина её тоже не нужна. */
  async purge(board: string): Promise<void> {
    clearTimeout(this.timers.get(board));
    this.timers.delete(board);
    this.boards.delete(board);
    await this.saving.get(board)?.catch(() => {});
    await rm(this.file(board), { force: true });
  }

  async flush(): Promise<void> {
    const boards = [...this.timers.keys()];
    for (const b of boards) {
      clearTimeout(this.timers.get(b));
      this.timers.delete(b);
    }
    await Promise.all([...boards.map((b) => this.queueSave(b)), ...this.saving.values()]);
  }
}

/**
 * REST корзины:
 *   GET  /api/trash/<доска>          — пачки удалённого за 7 дней, свежие первыми
 *   POST /api/trash/<доска>/restore  — { ids } → { restored }
 * false — не наш адрес.
 */
export async function handleTrash(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: URL,
  trash: Trash,
  store: { has(id: string): Promise<boolean>; get(id: string): Promise<Y.Doc> },
): Promise<boolean> {
  const m = /^\/api\/trash\/([A-Za-z0-9-][A-Za-z0-9_-]{0,63})(\/restore)?$/.exec(url.pathname);
  if (!m) return false;
  const board = m[1]!;
  const { json, readJson } = await import('./devices-api');
  if (!m[2] && req.method === 'GET') {
    json(res, 200, { groups: await trash.groups(board), keepDays: TRASH_KEEP_MS / 86_400_000 });
    return true;
  }
  if (m[2] && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, 512 * 1024);
    } catch {
      json(res, 400, { error: 'Нужен JSON' });
      return true;
    }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string')
      : [];
    if (!(await store.has(board))) {
      json(res, 404, { error: 'Такой доски нет' });
      return true;
    }
    json(res, 200, { restored: await trash.restore(board, await store.get(board), ids) });
    return true;
  }
  return false;
}
