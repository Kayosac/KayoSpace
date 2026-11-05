/**
 * Шаблоны досок (решение 0017): новая доска сразу с разметкой — фреймы-колонки и пара подсказок.
 * Только данные, без DOM: приложение кладёт элементы в новую доску одним изменением.
 */

import type { Actor, CanvasElement } from '@kayospace/model';
import { makeFrame, makeSticky, makeText } from './factory';

export type TemplateId = 'kanban' | 'week' | 'retro' | 'brainstorm' | 'meeting';

export const BOARD_TEMPLATES: readonly { id: TemplateId; name: string; hint: string }[] = [
  { id: 'kanban', name: 'Канбан', hint: 'Сделать · В работе · Готово' },
  { id: 'week', name: 'Неделя', hint: 'Понедельник — воскресенье' },
  { id: 'retro', name: 'Ретро', hint: 'Хорошо · Улучшить · Дальше' },
  { id: 'brainstorm', name: 'Мозговой штурм', hint: 'Тема, идеи, отбор' },
  { id: 'meeting', name: 'Встреча', hint: 'Повестка, заметки, решения, задачи' },
];

const GREEN = '#b8e3c9';
const PINK = '#ffc4d1';
const BLUE = '#bcd7ff';
const YELLOW = '#ffe58a';

/** Колонки-фреймы в ряд; в каждой — по желанию стикер-подсказка. */
function columns(
  names: readonly string[],
  actor: Actor,
  opts: {
    w: number;
    h: number;
    gap?: number;
    y?: number;
    stickers?: (string | null)[];
    colors?: string[];
  },
): CanvasElement[] {
  const gap = opts.gap ?? 60;
  const y = opts.y ?? 0;
  const out: CanvasElement[] = [];
  names.forEach((name, i) => {
    const x = i * (opts.w + gap);
    out.push(makeFrame(name, { x, y, w: opts.w, h: opts.h }, { actor, titleSize: 24 }));
    const text = opts.stickers?.[i];
    if (text)
      out.push(
        makeSticky(text, { x: x + 40, y: y + 40, color: opts.colors?.[i] ?? YELLOW, actor }),
      );
  });
  return out;
}

/** Элементы шаблона (координаты — от (0, 0)). */
export function templateElements(id: TemplateId, actor: Actor): CanvasElement[] {
  switch (id) {
    case 'kanban':
      return columns(['Сделать', 'В работе', 'Готово'], actor, {
        w: 440,
        h: 960,
        stickers: ['Новая задача — перетащите в «В работе»', null, null],
      });
    case 'week':
      return columns(
        ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'],
        actor,
        { w: 360, h: 720, gap: 40 },
      );
    case 'retro':
      return columns(['Что было хорошо', 'Что улучшить', 'Что делаем дальше'], actor, {
        w: 520,
        h: 840,
        stickers: [
          'Пример: быстро договорились',
          'Пример: долго ждали ответа',
          'Пример: созвон по пятницам',
        ],
        colors: [GREEN, PINK, BLUE],
      });
    case 'brainstorm':
      return [
        { ...makeText('Тема: …', { x: 0, y: -140, w: 900, actor }), h: 80, style: { size: 48 } },
        ...columns(['Все идеи', 'Отобрали'], actor, {
          w: 900,
          h: 900,
          gap: 80,
          stickers: ['Одна мысль — один стикер', null],
        }),
      ];
    case 'meeting':
      return [
        { ...makeText('Встреча: …', { x: 0, y: -140, w: 900, actor }), h: 80, style: { size: 48 } },
        ...columns(['Повестка', 'Заметки', 'Решения', 'Задачи'], actor, {
          w: 460,
          h: 720,
          stickers: [null, null, null, 'Задача — кто — срок'],
        }),
      ];
  }
}
