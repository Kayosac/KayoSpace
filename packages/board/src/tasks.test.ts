import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Actor } from '@kayospace/model';
import { addElement, getElement } from './board';
import { boardToMarkdown } from './export';
import { makeSticky } from './factory';
import { dueText, isOverdue, listTasks, nextStatus, setTask, validDue } from './tasks';

const me: Actor = { kind: 'human', name: 'я' };

describe('задачи', () => {
  it('стикер становится задачей и обратно; «Готово» запоминает время', () => {
    const doc = new Y.Doc();
    const s = makeSticky('Позвонить', { x: 0, y: 0, actor: me });
    addElement(doc, s);
    expect(setTask(doc, s.id, { due: '2026-11-12', high: true }, me, undefined, 1000)).toBe(true);
    let el = getElement(doc, s.id);
    expect(el?.type === 'sticky' && el.props.task).toEqual({
      status: 'todo',
      due: '2026-11-12',
      high: true,
    });
    setTask(doc, s.id, { status: 'done' }, me, undefined, 2000);
    setTask(doc, s.id, { status: 'done', high: false }, me, undefined, 3000);
    el = getElement(doc, s.id);
    expect(el?.type === 'sticky' && el.props.task).toEqual({
      status: 'done',
      due: '2026-11-12',
      doneAt: 2000,
    });
    setTask(doc, s.id, null, me);
    el = getElement(doc, s.id);
    expect(el?.type === 'sticky' && 'task' in el.props).toBe(false);
  });

  it('порядок: просроченные, важные, по сроку, готовые в конце', () => {
    const doc = new Y.Doc();
    const add = (text: string, t: Parameters<typeof setTask>[2]) => {
      const s = makeSticky(text, { x: 0, y: 0, actor: me });
      addElement(doc, s);
      setTask(doc, s.id, t, me);
    };
    add('готово', { status: 'done' });
    add('потом', { due: '2026-12-01' });
    add('важно', { high: true });
    add('просрочено', { due: '2026-11-01' });
    add('скоро', { due: '2026-11-10' });
    expect(listTasks(doc, '2026-11-05').map((t) => t.text)).toEqual([
      'просрочено',
      'важно',
      'скоро',
      'потом',
      'готово',
    ]);
    expect(boardToMarkdown(doc)).toContain('Задача [x] Готово «готово»');
    expect(boardToMarkdown(doc)).toContain('Задача [ ] Сделать (срок 2026-11-01) «просрочено»');
  });

  it('сроки и статусы', () => {
    expect(validDue('2026-11-12')).toBe('2026-11-12');
    expect(validDue('12.11.2026')).toBeUndefined();
    expect(isOverdue({ status: 'todo', due: '2026-11-01' }, '2026-11-05')).toBe(true);
    expect(isOverdue({ status: 'done', due: '2026-11-01' }, '2026-11-05')).toBe(false);
    expect(nextStatus('done')).toBe('todo');
    expect(dueText('2026-11-05', '2026-11-05')).toBe('сегодня');
    expect(dueText('2026-11-06', '2026-11-05')).toBe('завтра');
    expect(dueText('2026-11-12', '2026-11-05')).toMatch(/^до 12 нояб/);
  });
});
