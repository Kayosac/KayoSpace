import { describe, expect, it } from 'vitest';
import { matchesQuery, mergeBoards } from './boards';

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
