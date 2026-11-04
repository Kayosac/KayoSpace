/**
 * Резервные копии досок на хабе (решение 0010).
 *
 * Снимок — папка `backups/<время>/` с копиями всех `*.ydoc` (доски и служебные документы)
 * и `meta.json`. Снимок делается раз в несколько часов и только если что-то изменилось.
 * Хранятся: все за последние двое суток, по одному за день — две недели, по одному за неделю — два месяца.
 *
 * Восстановление никогда не перезаписывает доску: Yjs на устройствах слил бы старое состояние
 * с новым. Доска из снимка становится новой доской-копией рядом с исходной.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  WORKSPACE_ID,
  addElements,
  boardProject,
  getBoardName,
  isServiceDoc,
  listElements,
  setBoardProject,
  setBoardName,
} from '@kayospace/board';
import { isValidBoardId } from '@kayospace/sync';
import type { BoardStore } from './store';
import { json, readJson, type Access } from './devices-api';

export interface BackupBoard {
  id: string;
  name: string | null;
  elements: number;
}

export interface BackupInfo {
  /** Имя папки снимка, например 2026-11-05T03-00-00Z. */
  id: string;
  /** Время снимка, мс. */
  at: number;
  boards: BackupBoard[];
}

interface Meta extends BackupInfo {
  /** Отпечаток содержимого: одинаковый — снимок не нужен. */
  hash: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export function backupId(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');
}

/**
 * Какие снимки оставить: все моложе двух суток, самый свежий за каждый из последних 14 дней,
 * самый свежий за каждую из последних 8 недель. Самый свежий снимок остаётся всегда.
 */
export function keepBackups(times: readonly number[], now: number): Set<number> {
  const sorted = [...times].sort((a, b) => b - a);
  const keep = new Set<number>();
  if (sorted[0] !== undefined) keep.add(sorted[0]);
  const days = new Set<number>();
  const weeks = new Set<number>();
  for (const t of sorted) {
    const age = now - t;
    if (age < 2 * DAY) keep.add(t);
    const day = Math.floor(t / DAY);
    if (age < 14 * DAY && !days.has(day)) {
      days.add(day);
      keep.add(t);
    }
    const week = Math.floor(t / (7 * DAY));
    if (age < 56 * DAY && !weeks.has(week)) {
      weeks.add(week);
      keep.add(t);
    }
  }
  return keep;
}

export class Backups {
  readonly dir: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<BackupInfo | null> | null = null;

  constructor(
    private readonly store: BoardStore,
    private readonly opts: { intervalMs: number; now?: () => number },
  ) {
    this.dir = join(store.dir, 'backups');
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Проверять раз в час, не пора ли снимать копию (и сразу после запуска). */
  start(): void {
    if (this.opts.intervalMs <= 0 || this.timer) return;
    const tick = (): void => {
      void this.maybeSnapshot().catch((err) => console.error('[hub] резервная копия', err));
    };
    this.first = setTimeout(tick, 60_000);
    this.first.unref?.();
    this.timer = setInterval(tick, Math.min(HOUR, this.opts.intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  async list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    for (const m of await this.metas()) out.push({ id: m.id, at: m.at, boards: m.boards });
    return out;
  }

  async get(id: string): Promise<BackupInfo | null> {
    if (!ID_RE.test(id)) return null;
    const m = await this.meta(id);
    return m && { id: m.id, at: m.at, boards: m.boards };
  }

  /** Снимок, если прошло достаточно времени с прошлого. */
  async maybeSnapshot(): Promise<BackupInfo | null> {
    const last = (await this.metas())[0];
    if (last && this.now() - last.at < this.opts.intervalMs) return null;
    return this.snapshot();
  }

  /** Снять копию сейчас (null — ничего не изменилось с прошлой). */
  snapshot(): Promise<BackupInfo | null> {
    this.running ??= this.doSnapshot().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doSnapshot(): Promise<BackupInfo | null> {
    await this.store.flush();
    const files = (await readdir(this.store.dir))
      .filter((n) => n.endsWith('.ydoc') && isValidBoardId(n.slice(0, -'.ydoc'.length)))
      .sort();
    const hash = createHash('sha256');
    const contents = new Map<string, Buffer>();
    for (const name of files) {
      const bytes = await readFile(join(this.store.dir, name));
      contents.set(name, bytes);
      hash.update(name).update('\0').update(bytes);
    }
    const digest = hash.digest('hex');
    const metas = await this.metas();
    if (metas[0]?.hash === digest) return null;

    const at = this.now();
    const id = backupId(at);
    const boards: BackupBoard[] = [];
    for (const [name, bytes] of contents) {
      const boardId = name.slice(0, -'.ydoc'.length);
      if (isServiceDoc(boardId)) continue;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(bytes));
      boards.push({
        id: boardId,
        name: getBoardName(doc) ?? null,
        elements: listElements(doc).length,
      });
      doc.destroy();
    }
    const meta: Meta = { id, at, boards, hash: digest };
    // Сначала во временную папку, потом переименование: оборванный снимок не выглядит готовым.
    const tmp = join(this.dir, `.tmp-${id}`);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    for (const [name, bytes] of contents) await writeFile(join(tmp, name), bytes);
    await writeFile(join(tmp, 'meta.json'), JSON.stringify(meta));
    await rename(tmp, join(this.dir, id));
    await this.prune([meta, ...metas]);
    return { id, at, boards };
  }

  private async prune(metas: Meta[]): Promise<void> {
    const keep = keepBackups(
      metas.map((m) => m.at),
      this.now(),
    );
    for (const m of metas) {
      if (!keep.has(m.at)) await rm(join(this.dir, m.id), { recursive: true, force: true });
    }
  }

  /**
   * Восстановить доску из снимка новой доской: те же элементы, название «… (копия от …)»,
   * тот же проект, что у исходной доски сейчас. Возвращает id и название новой доски.
   */
  async restore(backup: string, board: string): Promise<{ id: string; name: string } | null> {
    if (!ID_RE.test(backup) || !isValidBoardId(board) || isServiceDoc(board)) return null;
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.dir, backup, `${board}.ydoc`));
    } catch {
      return null;
    }
    const meta = await this.meta(backup);
    const old = new Y.Doc();
    Y.applyUpdate(old, new Uint8Array(bytes));
    const date = new Date(meta?.at ?? Date.now());
    const stamp = date.toISOString().slice(0, 10).replaceAll('-', '');
    let id = `${board}-copy-${stamp}`.slice(0, 64);
    for (let i = 2; (await this.store.has(id)) && i < 100; i++) {
      id = `${board}-copy-${stamp}-${i}`.slice(0, 64);
    }
    const label = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const name = `${getBoardName(old) ?? board} (копия от ${label})`;
    const doc = await this.store.get(id);
    doc.transact(() => {
      setBoardName(doc, name);
      addElements(doc, listElements(old));
    });
    old.destroy();
    const ws = await this.store.get(WORKSPACE_ID);
    const project = boardProject(ws, board);
    if (project) setBoardProject(ws, id, project);
    await this.store.flush();
    return { id, name };
  }

  private async meta(id: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, id, 'meta.json'), 'utf8')) as Meta;
    } catch {
      return null;
    }
  }

  /** Все снимки, свежие — первыми. */
  private async metas(): Promise<Meta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: Meta[] = [];
    for (const n of names.filter((n) => ID_RE.test(n))) {
      const m = await this.meta(n);
      if (m) out.push(m);
    }
    return out.sort((a, b) => b.at - a.at);
  }
}

/**
 * REST резервных копий (любое подключённое устройство — восстановление только создаёт новую доску):
 *   GET  /api/backups                 — снимки, свежие первыми
 *   GET  /api/backups/<id>            — доски в снимке
 *   POST /api/backups                 — снять копию сейчас (только администратор)
 *   POST /api/backups/<id>/restore    — { board } → новая доска-копия { id, name }
 * false — не наш адрес.
 */
export async function handleBackups(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  backups: Backups,
  access: Access,
): Promise<boolean> {
  const p = url.pathname;
  if (p === '/api/backups') {
    if (req.method === 'GET') {
      json(res, 200, { backups: await backups.list() });
      return true;
    }
    if (req.method === 'POST') {
      if (!access.admin) {
        json(res, 403, { error: 'Снять копию вручную может только администратор' });
        return true;
      }
      const made = await backups.snapshot();
      json(res, 200, { created: made !== null, backup: made });
      return true;
    }
    return false;
  }
  const one = /^\/api\/backups\/([^/]+)$/.exec(p);
  if (one && req.method === 'GET') {
    const b = await backups.get(one[1]!);
    if (b) json(res, 200, b);
    else json(res, 404, { error: 'Такой копии нет' });
    return true;
  }
  const restore = /^\/api\/backups\/([^/]+)\/restore$/.exec(p);
  if (restore && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { error: 'Нужен JSON' });
      return true;
    }
    const board = typeof body.board === 'string' ? body.board : '';
    const made = await backups.restore(restore[1]!, board);
    if (made) {
      console.log(`[hub] доска ${board} восстановлена из копии ${restore[1]} как ${made.id}`);
      json(res, 200, made);
    } else json(res, 404, { error: 'В этой копии нет такой доски' });
    return true;
  }
  return false;
}
