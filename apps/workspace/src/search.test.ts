import { describe, expect, it } from 'vitest';
import { snippet } from './search';

describe('кусок текста для результата поиска', () => {
  it('короткий — целиком, без переносов строк', () => {
    expect(snippet('Купить\n  молоко', 'молоко')).toBe('Купить молоко');
  });

  it('длинный — вокруг совпадения, с многоточиями', () => {
    const text = `${'а'.repeat(100)} ключ ${'б'.repeat(100)}`;
    const s = snippet(text, 'КЛЮЧ', 40);
    expect(s).toContain('ключ');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(42);
  });
});
