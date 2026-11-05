import { describe, expect, it } from 'vitest';
import { filterTasks } from './tasks';

const t = (text: string, status: 'todo' | 'doing' | 'done', due?: string) => ({
  id: text,
  text,
  task: { status, ...(due ? { due } : {}) },
});

describe('фильтр задач', () => {
  it('активные, просроченные, готовые', () => {
    const list = [t('a', 'todo', '2026-11-01'), t('b', 'doing'), t('c', 'done', '2026-11-01')];
    const ids = (f: Parameters<typeof filterTasks>[1]) =>
      filterTasks(list, f, '2026-11-05').map((x) => x.id);
    expect(ids('active')).toEqual(['a', 'b']);
    expect(ids('overdue')).toEqual(['a']);
    expect(ids('done')).toEqual(['c']);
    expect(ids('all')).toEqual(['a', 'b', 'c']);
  });
});
