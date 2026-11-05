import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { markdownToPage, pageToMarkdown } from './markdown';
import { isPageId, pageMarkdown, pageText, readPage, writePage } from './yjs';

const MD = `# План ремонта

Сначала **кухня**, потом *ванная*. Смета — [здесь](https://example.com).

## Задачи

- [ ] Позвонить мастеру
- [x] Купить плитку

- Список
- Покупок

1. Первое
2. Второе

> Важно: не трогать проводку

[[board:kitchen-x1y2#fr123|Схема кухни]]

---

\`\`\`
код
\`\`\``;

describe('страница ↔ markdown', () => {
  it('туда и обратно — то же самое', () => {
    expect(pageToMarkdown(markdownToPage(MD))).toBe(MD);
  });

  it('фрагмент доски и чек-лист — нужными узлами', () => {
    const doc = markdownToPage(MD);
    const types = doc.content!.map((b) => b.type);
    expect(types).toContain('boardEmbed');
    expect(types).toContain('taskList');
    const embed = doc.content!.find((b) => b.type === 'boardEmbed')!;
    expect(embed.attrs).toEqual({ board: 'kitchen-x1y2', frame: 'fr123', title: 'Схема кухни' });
  });
});

describe('страница в Yjs', () => {
  it('запись, дописывание, чтение и текст для поиска', () => {
    const doc = new Y.Doc();
    expect(readPage(doc).content).toHaveLength(1);
    writePage(doc, '# Заметки\n\nПервая мысль');
    writePage(doc, '- [ ] Новая задача', 'append');
    expect(pageMarkdown(doc)).toBe('# Заметки\n\nПервая мысль\n\n- [ ] Новая задача');
    expect(pageText(doc)).toContain('Первая мысль');
    // Замена меняет только отличающееся — тот же фрагмент.
    writePage(doc, '# Заметки\n\nДругая мысль');
    expect(pageMarkdown(doc)).toBe('# Заметки\n\nДругая мысль');
    expect(isPageId('pg_plan-x1')).toBe(true);
    expect(isPageId('plan-x1')).toBe(false);
  });
});
