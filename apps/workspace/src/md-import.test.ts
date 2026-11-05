import { describe, expect, it } from 'vitest';
import { isMarkdown, parseMarkdownFile } from './md-import';

describe('файлы .md (решение 0023)', () => {
  it('узнаёт .md по имени и типу', () => {
    expect(isMarkdown({ name: 'План.MD', type: '' })).toBe(true);
    expect(isMarkdown({ name: 'note', type: 'text/markdown' })).toBe(true);
    expect(isMarkdown({ name: 'a.txt', type: 'text/plain' })).toBe(false);
  });

  it('название — из frontmatter, заголовка или имени файла; заголовок не дублируется', () => {
    expect(parseMarkdownFile('x.md', '# Смета\n\nТекст')).toEqual({
      title: 'Смета',
      body: 'Текст',
    });
    expect(parseMarkdownFile('x.md', '---\ntitle: План\n---\n# Другое\n\nТекст')).toEqual({
      title: 'План',
      body: '# Другое\n\nТекст',
    });
    expect(parseMarkdownFile('Заметки.md', 'Просто текст')).toEqual({
      title: 'Заметки',
      body: 'Просто текст',
    });
  });
});
