import { describe, expect, it } from 'vitest';
import { buildPdf } from './pdf';

const latin1 = (b: Uint8Array): string => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('PDF из картинок', () => {
  it('страница на картинку, размер по картинке, таблица ссылок указывает на объекты', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const pdf = buildPdf(
      [
        { jpeg, width: 800, height: 600 },
        { jpeg, width: 400, height: 400, density: 2 },
      ],
      'Доска «План»',
    );
    const text = latin1(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/MediaBox [0 0 600 450]');
    expect(text).toContain('/MediaBox [0 0 150 150]');
    expect(text).toContain('/Filter /DCTDecode /Length 9');
    // Заголовок не латиницей — в UTF-16BE.
    expect(text).toContain('/Title <FEFF0414');

    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const entries = text
      .slice(xref)
      .split('\n')
      .filter((l) => / 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    expect(entries.length).toBe(3 + 2 * 3);
    entries.forEach((off, i) => expect(text.slice(off).startsWith(`${i + 1} 0 obj\n`)).toBe(true));
  });
});
