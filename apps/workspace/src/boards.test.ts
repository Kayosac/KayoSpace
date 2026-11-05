import { describe, expect, it } from 'vitest';
import { boardsToForget, matchesQuery, mergeBoards, pruneDeleted } from './boards';

describe('список досок', () => {
  it('недавние первыми, доски с хаба добавляются, название с хаба важнее', () => {
    const list = mergeBoards(
      [
        { id: 'a', name: 'Старое' },
        { id: 'b', name: null },
      ],
      [
        { id: 'a', name: 'Новое', elements: 3 },
        { id: 'c', name: null, elements: 0 },
      ],
    );
    expect(list.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(list[0]).toEqual({ id: 'a', name: 'Новое', elements: 3, onHub: true });
    expect(list[1]!.onHub).toBe(false);
  });

  it('поиск по названию и id без учёта регистра', () => {
    const b = { id: 'plan-1', name: 'План недели', onHub: true };
    expect(matchesQuery(b, 'недел')).toBe(true);
    expect(matchesQuery(b, 'PLAN')).toBe(true);
    expect(matchesQuery(b, 'идеи')).toBe(false);
    expect(matchesQuery(b, '  ')).toBe(true);
  });
});

describe('удалённые доски на устройстве', () => {
  it('убираются из недавних; стёртые и старые — стираются локально', () => {
    const deleted = new Map([
      ['a', { at: 1000, name: null }],
      ['b', { at: 0, name: null, purged: true }],
      ['c', { at: 0, name: null }],
    ]);
    expect(
      pruneDeleted(
        [
          { id: 'a', name: 'А' },
          { id: 'x', name: 'Икс' },
        ],
        deleted,
      ),
    ).toEqual([{ id: 'x', name: 'Икс' }]);
    expect(boardsToForget(deleted, 3500, 3000)).toEqual(['b', 'c']);
  });
});
