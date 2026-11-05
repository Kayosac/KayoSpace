/**
 * История версий доски (решение 0018): хаб сам запоминает, какой доска была, и любую версию можно
 * посмотреть картинкой, вернуть или открыть копией рядом.
 *
 * Версия — полное состояние доски (`history/<доска>/<время>.ydoc`) и строка в `index.json`: когда,
 * сколько элементов, кто менял с прошлой версии. Версию снимаем, когда доска 2 минуты не менялась,
 * но не чаще раза в 10 минут; первая — сразу, как доска открылась на хабе (исходное состояние).
 * Хранятся: все за сутки, по одной в час — неделю, по одной в день — месяц.
 *
 * «Вернуть версию» не подменяет документ (Yjs на устройствах слил бы старое с новым), а новой правкой
 * приводит элементы к виду версии: лишнее удаляет, недостающее и изменённое кладёт. Перед этим текущее
 * состояние становится версией — возврат тоже можно вернуть. Удалённое возвратом попадает в корзину.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  WORKSPACE_ID,
  addElements,
  boardProject,
  elementsMap,
  getBoardName,
  isServiceDoc,
  listElements,
  setBoardName,
  setBoardProject,
} from '@kayospace/board';
import type { CanvasElement } from '@kayospace/model';
import { isValidBoardId } from '@kayospace/sync';
import { boardSvg, contentArea, renderPng, type ImageData } from './render';
import type { BoardStore } from './store';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface Version {
  /** Время версии, мс — оно же её id. */
  at: number;
  elements: number;
  /** Кто менял доску с прошлой версии: «claude-code», «человек»… */
  authors: string[];
}

/** Какие версии оставить: все за сутки, последнюю в каждом часе — неделю, в каждом дне — месяц. */
export function keepVersions(times: readonly number[], now: number): Set<number> {
  const sorted = [...times].sort((a, b) => b - a);
  const keep = new Set<number>();
  if (sorted[0] !== undefined) keep.add(sorted[0]);
  const hours = new Set<number>();
  const days = new Set<number>();
  for (const t of sorted) {
    const age = now - t;
    if (age < DAY) keep.add(t);
    const hour = Math.floor(t / HOUR);
    if (age < 7 * DAY && !hours.has(hour)) {
      hours.add(hour);
      keep.add(t);
    }
    const day = Math.floor(t / DAY);
    if (age < 30 * DAY && !days.has(day)) {
      days.add(day);
      keep.add(t);
    }
  }
  return keep;
}

/** Одинаковы ли элементы (для «вернуть»: менять только то, что отличается). */
function sameElement(a: CanvasElement, b: CanvasElement): boolean {
  return a.updatedAt === b.updatedAt && a.type === b.type && a.z === b.z;
}

export class History {
  readonly dir: string;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly last = new Map<string, number>();
  private readonly indexes = new Map<string, Promise<Version[]>>();
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: BoardStore,
    private readonly opts: {
      /** Тишина после правок, после которой снимаем версию. */
      quietMs?: number;
      /** Не чаще. */
      minGapMs?: number;
      now?: () => number;
      /** Origin «вернуть версию» — корзина считает это удалением человеком. */
      origin?: unknown;
    } = {},
  ) {
    this.dir = join(store.dir, 'history');
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Следить за доской: первая версия — сразу, дальше — после затишья. */
  attach(board: string, doc: Y.Doc): void {
    if (isServiceDoc(board)) return;
    void this.versions(board).then((list) => {
      if (list.length === 0 && listElements(doc).length > 0) void this.snapshot(board);
      else if (list[0]) this.last.set(board, list[0].at);
    });
    doc.on('update', () => this.schedule(board));
  }

  private schedule(board: string): void {
    clearTimeout(this.timers.get(board));
    const quiet = this.opts.quietMs ?? 2 * MIN;
    const gap = this.opts.minGapMs ?? 10 * MIN;
    const since = this.now() - (this.last.get(board) ?? 0);
    const t = setTimeout(
      () => {
        this.timers.delete(board);
        void this.snapshot(board).catch((err) => console.error(`[hub] история ${board}`, err));
      },
      Math.max(quiet, gap - since),
    );
    t.unref?.();
    this.timers.set(board, t);
  }

  private file(board: string, at: number): string {
    return join(this.dir, board, `${at}.ydoc`);
  }

  /** Версии доски, свежие первыми. */
  versions(board: string): Promise<Version[]> {
    if (!isValidBoardId(board)) return Promise.resolve([]);
    let p = this.indexes.get(board);
    if (!p) {
      p = readFile(join(this.dir, board, 'index.json'), 'utf8')
        .then((s) => (JSON.parse(s) as Version[]).sort((a, b) => b.at - a.at))
        .catch(() => []);
      this.indexes.set(board, p);
    }
    return p;
  }

  /** Записи одной доски — по очереди. */
  private serial<T>(board: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(board) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.busy.set(board, next);
    return next;
  }

  /** Снять версию сейчас (если доска изменилась с прошлой). null — снимать нечего. */
  snapshot(board: string): Promise<Version | null> {
    return this.serial(board, async () => {
      if (!(await this.store.has(board)) || (await this.store.isDeleted(board))) return null;
      const doc = await this.store.get(board);
      const list = await this.versions(board);
      const prev = list[0];
      const els = listElements(doc);
      const changed = prev ? els.filter((e) => e.updatedAt > prev.at) : els;
      const bytes = Y.encodeStateAsUpdate(doc);
      if (prev) {
        // Ничего не поменялось (или поменялось только удалением — сравним с прошлой версией).
        const old = await this.load(board, prev.at);
        const same = old && changed.length === 0 && listElements(old).length === els.length;
        old?.destroy();
        if (same) return null;
      }
      const at = Math.max(this.now(), (prev?.at ?? 0) + 1);
      const authors = [
        ...new Set(
          changed.map((e) => (e.updatedBy.kind === 'agent' ? e.updatedBy.name : 'человек')),
        ),
      ];
      const v: Version = { at, elements: els.length, authors };
      await mkdir(join(this.dir, board), { recursive: true });
      const tmp = `${this.file(board, at)}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, this.file(board, at));
      const keep = keepVersions([at, ...list.map((x) => x.at)], this.now());
      const next = [v, ...list].filter((x) => keep.has(x.at));
      for (const x of list) if (!keep.has(x.at)) await rm(this.file(board, x.at), { force: true });
      await this.writeIndex(board, next);
      this.last.set(board, at);
      return v;
    });
  }

  private async writeIndex(board: string, list: Version[]): Promise<void> {
    this.indexes.set(board, Promise.resolve(list));
    const f = join(this.dir, board, 'index.json');
    await writeFile(`${f}.tmp`, JSON.stringify(list));
    await rename(`${f}.tmp`, f);
  }

  /** Документ версии; null — такой нет. */
  async load(board: string, at: number): Promise<Y.Doc | null> {
    if (!isValidBoardId(board) || !Number.isSafeInteger(at)) return null;
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(await readFile(this.file(board, at))));
      return doc;
    } catch {
      return null;
    }
  }

  /** Картинка версии (PNG) — для списка в приложении. */
  async preview(
    board: string,
    at: number,
    images: (els: CanvasElement[]) => Promise<Map<string, ImageData>>,
    maxSize = 480,
  ): Promise<Buffer | null> {
    const doc = await this.load(board, at);
    if (!doc) return null;
    const els = listElements(doc);
    doc.destroy();
    const area = contentArea(els) ?? { x: 0, y: 0, w: 400, h: 300 };
    const pad = 40;
    const { svg } = boardSvg(
      els,
      { x: area.x - pad, y: area.y - pad, w: area.w + pad * 2, h: area.h + pad * 2 },
      { maxSize, images: await images(els) },
    );
    return renderPng(svg);
  }

  /**
   * Вернуть доску к версии новой правкой. Сначала текущее состояние становится версией.
   * Возвращает, сколько элементов поменялось; null — версии нет.
   */
  async restore(board: string, at: number): Promise<{ changed: number } | null> {
    const old = await this.load(board, at);
    if (!old) return null;
    await this.snapshot(board);
    const doc = await this.store.get(board);
    const target = new Map(listElements(old).map((e) => [e.id, e]));
    old.destroy();
    const map = elementsMap(doc);
    let changed = 0;
    doc.transact(() => {
      for (const [id, el] of [...map.entries()]) {
        if (!target.has(id)) {
          map.delete(id);
          changed++;
        } else if (!sameElement(el, target.get(id)!)) {
          map.set(id, target.get(id)!);
          changed++;
        }
      }
      for (const [id, el] of target) {
        if (!map.has(id)) {
          map.set(id, el);
          changed++;
        }
      }
    }, this.opts.origin ?? 'history');
    // Возврат — заметная точка: сразу версией, чтобы её было видно в списке.
    if (changed) await this.snapshot(board);
    return { changed };
  }

  /** Открыть версию копией: новая доска «… (версия от …)» в том же проекте. */
  async copy(board: string, at: number): Promise<{ id: string; name: string } | null> {
    const old = await this.load(board, at);
    if (!old) return null;
    const date = new Date(at);
    const stamp = date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let id = `${board}-v${stamp}`.slice(0, 64);
    for (let i = 2; (await this.store.has(id)) && i < 100; i++)
      id = `${board}-v${stamp}-${i}`.slice(0, 64);
    const label = date.toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
    const name = `${getBoardName(old) ?? board} (версия от ${label})`;
    const doc = await this.store.get(id);
    doc.transact(() => {
      setBoardName(doc, name);
      addElements(doc, listElements(old));
    });
    old.destroy();
    const ws = await this.store.get(WORKSPACE_ID);
    const project = boardProject(ws, board);
    if (project) setBoardProject(ws, id, project);
    return { id, name };
  }

  /** Доску стёрли насовсем — и её историю. */
  async purge(board: string): Promise<void> {
    clearTimeout(this.timers.get(board));
    this.timers.delete(board);
    await this.busy.get(board)?.catch(() => {});
    this.indexes.delete(board);
    this.last.delete(board);
    await rm(join(this.dir, board), { recursive: true, force: true });
  }

  /** Снять версии досок, которые ждут затишья (при остановке хаба). */
  async flush(): Promise<void> {
    const boards = [...this.timers.keys()];
    for (const b of boards) clearTimeout(this.timers.get(b));
    this.timers.clear();
    await Promise.all(boards.map((b) => this.snapshot(b).catch(() => null)));
    await Promise.all([...this.busy.values()].map((p) => p.catch(() => {})));
  }

  /** Список досок с историей (для отладки и тестов). */
  async boards(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(isValidBoardId);
    } catch {
      return [];
    }
  }
}

/**
 * REST истории:
 *   GET  /api/history/<доска>                 — { versions }
 *   GET  /api/history/<доска>/<время>.png     — картинка версии
 *   POST /api/history/<доска>/<время>/restore — вернуть доску к версии → { changed }
 *   POST /api/history/<доска>/<время>/copy    — открыть копией → { id, name }
 */
export async function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  history: History,
  images: (els: CanvasElement[]) => Promise<Map<string, ImageData>>,
): Promise<boolean> {
  const m =
    /^\/api\/history\/([A-Za-z0-9-][A-Za-z0-9_-]{0,63})(?:\/(\d{1,16})(\.png|\/restore|\/copy))?$/.exec(
      url.pathname,
    );
  if (!m) return false;
  const { json } = await import('./devices-api');
  const board = m[1]!;
  if (!m[2]) {
    if (req.method !== 'GET') return (json(res, 405, { error: 'Только GET' }), true);
    json(res, 200, { versions: await history.versions(board) });
    return true;
  }
  const at = Number(m[2]);
  if (m[3] === '.png' && req.method === 'GET') {
    const png = await history.preview(board, at, images);
    if (!png) return (json(res, 404, { error: 'Такой версии нет' }), true);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(png);
    return true;
  }
  if (m[3] === '/restore' && req.method === 'POST') {
    const r = await history.restore(board, at);
    json(res, r ? 200 : 404, r ?? { error: 'Такой версии нет' });
    return true;
  }
  if (m[3] === '/copy' && req.method === 'POST') {
    const r = await history.copy(board, at);
    json(res, r ? 200 : 404, r ?? { error: 'Такой версии нет' });
    return true;
  }
  json(res, 405, { error: 'Не тот метод' });
  return true;
}
