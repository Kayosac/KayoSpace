/**
 * Доска для замера скорости (шаг 1.7): ~20 000 объектов, похожих на настоящие —
 * рукописные строки (штрихи по 20–60 точек), стикеры с текстом, надписи, фигуры, стрелки.
 * Генератор детерминированный: одинаковое зерно — одинаковая доска.
 */

import type * as Y from 'yjs';
import {
  addElements,
  makeArrow,
  makeShape,
  makeSticky,
  makeStroke,
  makeText,
} from '@kayospace/board';
import type { Actor, CanvasElement, StrokePoint } from '@kayospace/model';

export interface BenchBoardOptions {
  /** Всего элементов (по умолчанию 20 000). */
  count?: number;
  seed?: number;
}

/** Генератор случайных чисел mulberry32 — детерминированный и быстрый. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const actor: Actor = { kind: 'human', name: 'bench' };

/**
 * Элементы доски для замера. Раскладка — «страницы» 1600×1200, как тетрадь: строки рукописного
 * текста, между ними — стикеры, надписи и схемы. Около 88% — штрихи.
 */
export function benchElements(opts: BenchBoardOptions = {}): CanvasElement[] {
  const count = opts.count ?? 20_000;
  const rand = rng(opts.seed ?? 1);
  const out: CanvasElement[] = [];
  const now = 1_700_000_000_000;
  const pageW = 1600;
  const pageH = 1200;
  const cols = 8;
  let page = 0;
  let line = 0;
  let cursor = 0;
  const notes = Math.round(count * 0.06);
  const texts = Math.round(count * 0.03);
  const shapes = Math.round(count * 0.02);
  const arrows = Math.round(count * 0.01);
  const strokes = count - notes - texts - shapes - arrows;
  const origin = (): { x: number; y: number } => ({
    x: (page % cols) * (pageW + 200),
    y: Math.floor(page / cols) * (pageH + 200),
  });

  // Рукописные строки: слова из 2–5 штрихов, штрих — 20–60 точек, высота буквы ~30.
  for (let i = 0; i < strokes; i++) {
    const o = origin();
    if (cursor > pageW - 120) {
      cursor = 0;
      line++;
      if (line * 60 > pageH - 80) {
        line = 0;
        page++;
      }
    }
    const x0 = o.x + 40 + cursor;
    const y0 = o.y + 60 + line * 60;
    const n = 20 + Math.floor(rand() * 40);
    const pts: StrokePoint[] = [];
    let x = x0;
    let y = y0;
    for (let k = 0; k < n; k++) {
      x += 0.6 + rand() * 1.6;
      y = y0 + Math.sin(k / 3 + rand()) * 14 + (rand() - 0.5) * 3;
      pts.push({ x, y, p: 0.4 + rand() * 0.4, tx: 0, ty: 0, t: k * 8 });
    }
    cursor += x - x0 + (rand() < 0.3 ? 30 : 6);
    out.push(
      makeStroke(pts, {
        hasPressure: true,
        style: { size: 2.5 + rand() * 2 },
        actor,
        now: now + i,
      }),
    );
  }
  const total = page + 1;
  const spot = (): { x: number; y: number } => {
    const p = Math.floor(rand() * total);
    return {
      x: (p % cols) * (pageW + 200) + rand() * (pageW - 220),
      y: Math.floor(p / cols) * (pageH + 200) + rand() * (pageH - 220),
    };
  };
  const words =
    'план идея задача срок проверить купить позвонить дизайн холст перо хаб доска'.split(' ');
  const phrase = (): string =>
    Array.from(
      { length: 2 + Math.floor(rand() * 6) },
      () => words[Math.floor(rand() * words.length)],
    ).join(' ');
  for (let i = 0; i < notes; i++) {
    out.push(makeSticky(phrase(), { ...spot(), actor, now: now + strokes + i }));
  }
  for (let i = 0; i < texts; i++) {
    out.push(makeText(phrase(), { ...spot(), w: 260, actor, now: now + strokes + notes + i }));
  }
  for (let i = 0; i < shapes; i++) {
    const p = spot();
    out.push(
      makeShape(
        rand() < 0.5 ? 'rect' : 'ellipse',
        { x: p.x, y: p.y, w: 80 + rand() * 200, h: 60 + rand() * 140 },
        { size: 2, actor, now: now + strokes + notes + texts + i },
      ),
    );
  }
  for (let i = 0; i < arrows; i++) {
    const a = spot();
    out.push(
      makeArrow(
        a,
        { x: a.x + (rand() - 0.5) * 400, y: a.y + (rand() - 0.5) * 400 },
        {
          size: 2,
          actor,
          now: now + strokes + notes + texts + shapes + i,
        },
      ),
    );
  }
  return out;
}

/** Заполнить документ доской для замера (одной транзакцией). */
export function fillBenchBoard(doc: Y.Doc, opts: BenchBoardOptions = {}): number {
  const els = benchElements(opts);
  addElements(doc, els);
  return els.length;
}
