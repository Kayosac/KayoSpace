/**
 * Минимальный PDF из картинок JPEG — по странице на картинку (экспорт доски и фреймов).
 * Своя реализация на пару десятков строк вместо библиотеки: нужны только страницы с картинкой.
 * Размер страницы — по картинке (1 пиксель = 0,75 пункта, как 96 dpi), так PDF не размывает растр.
 */

export interface PdfPage {
  /** Байты JPEG. */
  jpeg: Uint8Array;
  /** Размер картинки в пикселях. */
  width: number;
  height: number;
  /** Масштаб страницы: во сколько раз картинка плотнее 96 dpi (2 — «ретина»). По умолчанию 1. */
  density?: number;
}

const enc = new TextEncoder();

export function buildPdf(pages: readonly PdfPage[], title = 'Kayospace'): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: string | Uint8Array): void => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: () => void): void => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  // Объекты: 1 — каталог, 2 — дерево страниц, 3 — сведения; на каждую страницу — страница, картинка, содержимое.
  const first = 4;
  const pageObj = (i: number): number => first + i * 3;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () =>
    push(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`,
    ),
  );
  object(3, () => push(`<< /Title ${pdfString(title)} /Producer (Kayospace) >>`));
  pages.forEach((p, i) => {
    // Больше 14 400 пунктов по стороне PDF не допускает — огромную доску уменьшаем.
    const k = Math.min(0.75 / (p.density ?? 1), 14_400 / Math.max(p.width, p.height));
    const w = round(p.width * k);
    const h = round(p.height * k);
    const page = pageObj(i);
    object(page, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
          `/Resources << /XObject << /Im${i} ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`,
      ),
    );
    object(page + 1, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      );
      push(p.jpeg);
      push('\nendstream');
    });
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`;
    object(page + 2, () =>
      push(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`),
    );
  });

  const total = first + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let n = 1; n < total; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** Строка PDF: латиница — как есть, иначе UTF-16BE с меткой порядка байт. */
function pdfString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[()\\]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}
