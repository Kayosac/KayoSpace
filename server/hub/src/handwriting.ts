/**
 * Распознанное рукописное (решение 0018): чтобы поиск и агенты находили написанное пером.
 *
 * Штрихи доски собираются в группы — соседние штрихи (ближе GAP) — это слово, строка или абзац.
 * Когда доска затихла, хаб рисует новые группы картинками и отдаёт их модели OpenAI; ответ —
 * текст группы — хранится в `handwriting/<доска>.json` по отпечатку группы (id и время штрихов):
 * группа изменилась — распознаётся заново, исчезла — запись удаляется. Без ключа OpenAI не работает.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type * as Y from 'yjs';
import { isServiceDoc, listElements } from '@kayospace/board';
import type { CanvasElement } from '@kayospace/model';
import { boardSvg, renderPng } from './render';

/** Штрихи ближе этого (мировые единицы) — одна группа. */
const GAP = 60;
/** Группы меньше этого по обеим сторонам — точки и чёрточки, не распознаём. */
const MIN_SIDE = 24;
/** Сколько групп за один запрос к модели и сколько запросов за один проход по доске. */
const BATCH = 8;
const MAX_BATCHES = 4;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface StrokeGroup {
  key: string;
  ids: string[];
  bounds: Bounds;
}

export interface HandwritingEntry extends StrokeGroup {
  text: string;
  at: number;
}

const boundsOf = (el: CanvasElement): Bounds => ({
  minX: el.x,
  minY: el.y,
  maxX: el.x + el.w,
  maxY: el.y + el.h,
});

/** Группы соседних штрихов (без поворота: рамки штрихов и так в мировых координатах). */
export function strokeGroups(elements: readonly CanvasElement[], gap = GAP): StrokeGroup[] {
  const strokes = elements.filter((e) => e.type === 'stroke').sort((a, b) => a.x - b.x);
  const parent = strokes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  // Развёртка по x: сравниваем только штрихи, что рядом по горизонтали.
  for (let i = 0; i < strokes.length; i++) {
    const a = boundsOf(strokes[i]!);
    for (let j = i + 1; j < strokes.length; j++) {
      const b = boundsOf(strokes[j]!);
      if (b.minX > a.maxX + gap) break;
      if (b.minY <= a.maxY + gap && b.maxY >= a.minY - gap) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, CanvasElement[]>();
  strokes.forEach((s, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), s]);
  });
  const out: StrokeGroup[] = [];
  for (const els of groups.values()) {
    const bounds = els.map(boundsOf).reduce((u, b) => ({
      minX: Math.min(u.minX, b.minX),
      minY: Math.min(u.minY, b.minY),
      maxX: Math.max(u.maxX, b.maxX),
      maxY: Math.max(u.maxY, b.maxY),
    }));
    if (bounds.maxX - bounds.minX < MIN_SIDE && bounds.maxY - bounds.minY < MIN_SIDE) continue;
    const ids = els.map((e) => e.id).sort();
    const key = createHash('sha1')
      .update(
        els
          .map((e) => `${e.id}:${e.updatedAt}`)
          .sort()
          .join('|'),
      )
      .digest('base64url')
      .slice(0, 16);
    out.push({ key, ids, bounds });
  }
  // Порядок чтения: сверху вниз, слева направо.
  return out.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
}

/** Картинка группы для модели: только её штрихи, на белом, длинная сторона до 1024. */
export function groupPng(elements: readonly CanvasElement[], g: StrokeGroup): Buffer {
  const ids = new Set(g.ids);
  const pad = 16;
  const w = g.bounds.maxX - g.bounds.minX + pad * 2;
  const h = g.bounds.maxY - g.bounds.minY + pad * 2;
  const { svg } = boardSvg(
    elements.filter((e) => ids.has(e.id)),
    { x: g.bounds.minX - pad, y: g.bounds.minY - pad, w, h },
    { maxSize: Math.min(1024, Math.max(256, Math.max(w, h) * 2)) },
  );
  return renderPng(svg);
}

export class Handwriting {
  private readonly dir: string;
  private readonly cache = new Map<string, Promise<Map<string, HandwritingEntry>>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<number>>();

  constructor(
    dataDir: string,
    private readonly store: {
      get(id: string): Promise<Y.Doc>;
      isDeleted(id: string): Promise<boolean>;
    },
    private readonly reader: {
      readHandwriting(images: readonly Buffer[]): Promise<string[]>;
      left?(kind: 'handwriting'): Promise<number>;
      /** Выключатель из приложения: проверяется перед каждым проходом. */
      readonly handwritingEnabled?: boolean;
    } | null,
    private readonly opts: { quietMs?: number; now?: () => number } = {},
  ) {
    this.dir = join(dataDir, 'handwriting');
  }

  get enabled(): boolean {
    return this.reader !== null;
  }

  attach(board: string, doc: Y.Doc): void {
    if (!this.reader || isServiceDoc(board)) return;
    doc.on('update', () => {
      clearTimeout(this.timers.get(board));
      const t = setTimeout(() => {
        this.timers.delete(board);
        void this.index(board).catch((err) => console.error(`[hub] рукописное ${board}`, err));
      }, this.opts.quietMs ?? 60_000);
      t.unref?.();
      this.timers.set(board, t);
    });
  }

  private file(board: string): string {
    return join(this.dir, `${board}.json`);
  }

  private load(board: string): Promise<Map<string, HandwritingEntry>> {
    let p = this.cache.get(board);
    if (!p) {
      p = readFile(this.file(board), 'utf8')
        .then((s) => new Map((JSON.parse(s) as HandwritingEntry[]).map((e) => [e.key, e])))
        .catch(() => new Map());
      this.cache.set(board, p);
    }
    return p;
  }

  /** Распознанное на доске (только непустое), в порядке чтения. */
  async entries(board: string): Promise<HandwritingEntry[]> {
    return [...(await this.load(board)).values()]
      .filter((e) => e.text)
      .sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
  }

  /** Распознать новые группы штрихов доски. Возвращает, сколько групп распознано. */
  index(board: string): Promise<number> {
    const prev = this.running.get(board) ?? Promise.resolve(0);
    const next = prev.catch(() => 0).then(() => this.doIndex(board));
    this.running.set(board, next);
    return next;
  }

  private async doIndex(board: string): Promise<number> {
    if (!this.reader || this.reader.handwritingEnabled === false) return 0;
    if (await this.store.isDeleted(board)) return 0;
    const doc = await this.store.get(board);
    const els = listElements(doc);
    const groups = strokeGroups(els);
    const known = await this.load(board);
    const live = new Set(groups.map((g) => g.key));
    let changed = false;
    for (const key of [...known.keys()]) {
      if (!live.has(key)) {
        known.delete(key);
        changed = true;
      }
    }
    // Не больше, чем осталось в дневном потолке: остальное распознаем завтра.
    const left = this.reader.left ? await this.reader.left('handwriting') : Infinity;
    const fresh = groups
      .filter((g) => !known.has(g.key))
      .slice(0, Math.min(BATCH * MAX_BATCHES, left));
    let done = 0;
    for (let i = 0; i < fresh.length; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      const texts = await this.reader.readHandwriting(batch.map((g) => groupPng(els, g)));
      const at = this.opts.now ? this.opts.now() : Date.now();
      batch.forEach((g, j) => known.set(g.key, { ...g, text: texts[j] ?? '', at }));
      done += batch.length;
      changed = true;
    }
    if (changed) await this.save(board, known);
    return done;
  }

  private async save(board: string, m: Map<string, HandwritingEntry>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(board)}.tmp`;
    await writeFile(tmp, JSON.stringify([...m.values()]));
    await rename(tmp, this.file(board));
  }

  async purge(board: string): Promise<void> {
    clearTimeout(this.timers.get(board));
    this.timers.delete(board);
    await this.running.get(board)?.catch(() => {});
    this.cache.delete(board);
    await rm(this.file(board), { force: true });
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
