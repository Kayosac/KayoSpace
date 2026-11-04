import { describe, expect, it } from 'vitest';
import { hasContent, sharedFiles, sharedText } from './share';

describe('присланное через «Поделиться»', () => {
  it('тема и текст без повторов', () => {
    expect(sharedText({ text: 'https://x.dev/a', subject: 'Статья', files: [] })).toBe(
      'Статья\nhttps://x.dev/a',
    );
    expect(sharedText({ text: 'Статья https://x.dev/a', subject: 'Статья', files: [] })).toBe(
      'Статья https://x.dev/a',
    );
    expect(sharedText({ subject: '  Только тема ', files: [] })).toBe('Только тема');
    expect(sharedText({ text: '   ', files: [] })).toBeNull();
  });

  it('картинки — файлами; SVG и не картинки пропускаем', async () => {
    const png = btoa(String.fromCharCode(137, 80, 78, 71));
    const files = sharedFiles({
      files: [
        { name: 'фото.png', mime: 'image/png', data: png },
        { name: 'x.svg', mime: 'image/svg+xml', data: png },
        { name: 'doc.pdf', mime: 'application/pdf', data: png },
      ],
    });
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([['фото.png', 'image/png', 4]]);
    expect([...new Uint8Array(await files[0]!.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  });

  it('пустое — не повод открывать «Входящие»', () => {
    expect(hasContent({ files: [] })).toBe(false);
    expect(hasContent(null)).toBe(false);
    expect(hasContent({ text: 'a', files: [] })).toBe(true);
  });
});
