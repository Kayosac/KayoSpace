import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { markdownTitle, markdownToPage, pageToMarkdown, stripFrontmatter } from './markdown';
import {
  isPageId,
  pageFileMarkdown,
  pageMarkdown,
  pageText,
  readPage,
  writePage,
  writeSection,
} from './yjs';

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

describe('markdown без потерь (решение 0023)', () => {
  const FULL = `# Отчёт

## Раздел

#### Мелкий заголовок

###### Совсем мелкий

Текст со **жирным [ссылкой](https://example.com)**, *курсивом*, \`кодом\`, ~~зачёркнутым~~ и snake_case.  
Вторая строка абзаца.

- Пункт
  - Вложенный
    - Ещё глубже
  - Второй вложенный
- Пункт два

  Абзац внутри пункта.

3. Третий
4. Четвёртый
   1. Вложенный нумерованный

- [x] Сделано
  - [ ] Подзадача

> Цитата
>
> - со списком

| Что | Цена |
| --- | --- |
| Плитка | 1200 |
| Клей \\| смесь | 350 |

![Схема кухни](https://example.com/k.png "Кухня")

\`\`\`ts
const x = 1;
\`\`\`

---

Конец с символами \\* и \\[скобками\\].`;

  it('туда и обратно — тот же текст', () => {
    expect(pageToMarkdown(markdownToPage(FULL))).toBe(FULL);
  });

  it('нужные узлы: таблица, картинка, вложенные списки, h6, язык кода', () => {
    const doc = markdownToPage(FULL);
    const types = (doc.content ?? []).map((b) => b.type);
    expect(types).toEqual([
      'heading',
      'heading',
      'heading',
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'table',
      'image',
      'codeBlock',
      'horizontalRule',
      'paragraph',
    ]);
    const ordered = doc.content!.find((b) => b.type === 'orderedList')!;
    expect(ordered.attrs).toEqual({ start: 3 });
    const bullet = doc.content!.find((b) => b.type === 'bulletList')!;
    expect(bullet.content![0]!.content![1]!.type).toBe('bulletList');
    const table = doc.content!.find((b) => b.type === 'table')!;
    expect(table.content).toHaveLength(3);
    expect(table.content![0]!.content![0]!.type).toBe('tableHeader');
    expect(JSON.stringify(table)).toContain('Клей | смесь');
    expect(doc.content!.find((b) => b.type === 'codeBlock')!.attrs).toEqual({ language: 'ts' });
  });

  it('frontmatter и название файла', () => {
    expect(markdownTitle('---\ntitle: План\n---\n# Другое')).toBe('План');
    expect(markdownTitle('Текст\n\n# **Главное**\n')).toBe('Главное');
    expect(stripFrontmatter('---\na: 1\n---\nТело').body).toBe('Тело');
  });

  it('схема принимает разобранное (в Yjs и обратно)', () => {
    const doc = new Y.Doc();
    writePage(doc, FULL);
    expect(pageMarkdown(doc)).toBe(FULL);
  });
});

describe('правка раздела (решение 0023)', () => {
  it('заменяет тело раздела до следующего заголовка того же уровня; нет — дописывает', () => {
    const doc = new Y.Doc();
    writePage(doc, '# План\n\n## Смета\n\nСтарое\n\n### Детали\n\nМелочи\n\n## Сроки\n\nНоябрь');
    expect(writeSection(doc, 'смета', '- Плитка — 1200\n- Клей — 350')).toBe(true);
    expect(pageMarkdown(doc)).toBe(
      '# План\n\n## Смета\n\n- Плитка — 1200\n- Клей — 350\n\n## Сроки\n\nНоябрь',
    );
    expect(writeSection(doc, 'Итоги', 'Всё готово')).toBe(false);
    expect(pageMarkdown(doc)).toContain('## Сроки\n\nНоябрь\n\n## Итоги\n\nВсё готово');
    writeSection(doc, '## Сроки', '## Сроки (обновлено)\n\nДекабрь');
    expect(pageMarkdown(doc)).toContain('## Сроки (обновлено)\n\nДекабрь');
    expect(pageFileMarkdown(doc, 'План')).toMatch(/^# План\n\n## Смета/);
    expect(pageFileMarkdown(doc, 'Другое')).toMatch(/^# Другое\n\n# План/);
  });
});
