import { describe, expect, it } from 'vitest';
import { isPdf, pageScale, pdfTitle } from './pdf-import';

describe('импорт PDF', () => {
  it('узнаёт PDF по типу и по имени', () => {
    expect(isPdf(new File([], 'a.pdf'))).toBe(true);
    expect(isPdf(new File([], 'scan', { type: 'application/pdf' }))).toBe(true);
    expect(isPdf(new File([], 'a.png', { type: 'image/png' }))).toBe(false);
  });

  it('название — имя файла без расширения', () => {
    expect(pdfTitle('Договор аренды.PDF')).toBe('Договор аренды');
    expect(pdfTitle('.pdf')).toBe('PDF');
  });

  it('страница — 1600 пикселей в ширину, длинная лента — не выше 4096', () => {
    expect(Math.round(595 * pageScale(595, 842))).toBe(1600);
    const s = pageScale(595, 5000);
    expect(Math.round(5000 * s)).toBe(4096);
  });
});
