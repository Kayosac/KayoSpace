/**
 * PDF из страниц-картинок на хабе (решение 0022): экспорт документа, таблицы и неоткрытой доски.
 * Страница — растр без потерь (FlateDecode, RGB), размер страницы — по картинке при 96 dpi
 * с учётом плотности. Как и PDF в приложении — без библиотеки: нужны только страницы с картинкой.
 */

import { deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

export interface RasterPage {
  /** RGB без прозрачности, 8 бит на канал, сжатое deflate. */
  data: Buffer;
  width: number;
  height: number;
  /** Во сколько раз плотнее 96 dpi. */
  density: number;
}

/** SVG → страница: рисуем с плотностью density, прозрачность — на белом. */
export function rasterize(svg: string, density = 2): RasterPage {
  const r = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
    background: '#ffffff',
    fitTo: { mode: 'zoom', value: density },
    shapeRendering: 2,
  }).render();
  const rgba = r.pixels;
  const rgb = Buffer.alloc(r.width * r.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3]! / 255;
    rgb[j] = Math.round(rgba[i]! * a + 255 * (1 - a));
    rgb[j + 1] = Math.round(rgba[i + 1]! * a + 255 * (1 - a));
    rgb[j + 2] = Math.round(rgba[i + 2]! * a + 255 * (1 - a));
  }
  return { data: deflateSync(rgb, { level: 6 }), width: r.width, height: r.height, density };
}

const str = (s: string): string =>
  `<${Buffer.from(`\ufeff${s}`, 'utf16le').swap16().toString('hex')}>`;

export function buildRasterPdf(pages: readonly RasterPage[], title = 'Kayospace'): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (d: string | Buffer): void => {
    const b = typeof d === 'string' ? Buffer.from(d, 'latin1') : d;
    chunks.push(b);
    length += b.length;
  };
  const object = (num: number, body: () => void): void => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  const pageObj = (i: number): number => 4 + i * 3;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () =>
    push(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`,
    ),
  );
  object(3, () => push(`<< /Title ${str(title)} /Producer (Kayospace) >>`));
  pages.forEach((p, i) => {
    const k = Math.min(0.75 / p.density, 14_400 / Math.max(p.width, p.height));
    const w = Math.round(p.width * k * 100) / 100;
    const h = Math.round(p.height * k * 100) / 100;
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
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${p.data.length} >>\nstream\n`,
      );
      push(p.data);
      push('\nendstream');
    });
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`;
    object(page + 2, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });
  const xref = length;
  const count = pageObj(pages.length);
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) push(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
