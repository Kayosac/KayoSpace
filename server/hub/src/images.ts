/**
 * Картинки для агентов (решение 0016): размер по заголовку файла и безопасная загрузка по ссылке.
 *
 * Хаб скачивает картинку по ссылке, которую дал агент, — значит, ссылка не должна вести внутрь
 * сервера или его сети (SSRF): только http/https, адрес проверяется при каждом соединении
 * (и после перенаправлений), частные, локальные и служебные сети запрещены.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Resvg } from '@resvg/resvg-js';
import { sniffType } from './assets';

/** Самая большая картинка, которую агент может положить на доску. */
export const MAX_AGENT_IMAGE_BYTES = 15 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
}

/** Тип и размер картинки по первым байтам; null — не картинка или размер не прочитать. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  const mime = sniffType(b.subarray(0, 12));
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const size = ((): { width: number; height: number } | null => {
    switch (mime) {
      case 'image/png':
        if (buf.length < 24) return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      case 'image/gif':
        if (buf.length < 10) return null;
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      case 'image/webp':
        return webpSize(buf);
      case 'image/jpeg':
        return jpegSize(buf);
      default:
        return null;
    }
  })();
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return { mime, ...size };
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ')
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L')
    return {
      width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
      height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)),
    };
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return null;
}

/** Размер JPEG из маркера SOF; с поворотом по EXIF (5–8 — ширина и высота меняются местами). */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  let rotated = false;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1 && b.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
      const o = exifOrientation(b.subarray(i + 10, i + 2 + len));
      rotated = o !== null && o >= 5 && o <= 8;
    }
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return rotated ? { width: height, height: width } : { width, height };
    }
    i += 2 + len;
  }
  return null;
}

function exifOrientation(t: Buffer): number | null {
  if (t.length < 8) return null;
  const le = t.toString('ascii', 0, 2) === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

// Сети, в которые хаб по ссылке агента не ходит.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** Адрес внутри сервера, локальной или служебной сети. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) return blocked.check(ip, 'ipv6');
  return true;
}

export class ImageFetchError extends Error {}

/**
 * Скачать картинку по ссылке. allowPrivate — только для тестов (локальный сервер).
 * Отказ — ImageFetchError с понятным текстом.
 */
export async function fetchImage(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; allowPrivate?: boolean; redirects?: number } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? MAX_AGENT_IMAGE_BYTES;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ImageFetchError('Это не ссылка.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    throw new ImageFetchError('Ссылка должна начинаться с http:// или https://.');
  if (target.username || target.password)
    throw new ImageFetchError('Ссылки с логином и паролем не принимаю.');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host))
    throw new ImageFetchError('Ссылка ведёт во внутреннюю сеть — так нельзя.');

  const lookup = (
    hostname: string,
    options: { all?: boolean },
    cb: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const ok = opts.allowPrivate
        ? addresses
        : addresses.filter((a) => !isPrivateAddress(a.address));
      if (ok.length === 0) {
        const e = new ImageFetchError('Ссылка ведёт во внутреннюю сеть — так нельзя.');
        return cb(e as NodeJS.ErrnoException, '');
      }
      if (options.all) cb(null, ok);
      else cb(null, ok[0]!.address, ok[0]!.family);
    });
  };

  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const get = target.protocol === 'https:' ? https.get : http.get;
    const req = get(
      target,
      {
        lookup: lookup as never,
        headers: { 'user-agent': 'Kayospace-hub (image for board)', accept: 'image/*' },
        timeout: opts.timeoutMs ?? 15_000,
      },
      resolve,
    );
    req.on('timeout', () =>
      req.destroy(new ImageFetchError('Картинка не скачалась за 15 секунд.')),
    );
    req.on('error', reject);
  }).catch((err: unknown) => {
    if (err instanceof ImageFetchError) throw err;
    throw new ImageFetchError(
      `Не удалось скачать: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume();
    const left = opts.redirects ?? 3;
    if (left <= 0) throw new ImageFetchError('Слишком много перенаправлений.');
    return fetchImage(new URL(res.headers.location, target).href, { ...opts, redirects: left - 1 });
  }
  if (status !== 200) {
    res.resume();
    throw new ImageFetchError(`Сайт ответил ${status}.`);
  }
  const declared = Number(res.headers['content-length'] ?? 0);
  if (declared > maxBytes) {
    res.destroy();
    throw new ImageFetchError(`Картинка больше ${Math.round(maxBytes / 1048576)} МБ.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    res.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        res.destroy();
        reject(new ImageFetchError(`Картинка больше ${Math.round(maxBytes / 1048576)} МБ.`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve());
    res.on('error', (err) => reject(new ImageFetchError(`Обрыв загрузки: ${err.message}`)));
  });
  return Buffer.concat(chunks);
}

/** base64 или data:-ссылка → байты; null — не base64. */
export function decodeImageData(data: string): Buffer | null {
  const raw = data.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw) || raw.length === 0) return null;
  return Buffer.from(raw, 'base64');
}

/** Самая длинная сторона картинки, нарисованной агентом в SVG. */
export const MAX_SVG_SIDE = 1600;

/**
 * Картинка, которую агент нарисовал сам (SVG) → PNG. Внешних ссылок в SVG не бывает:
 * href — только на свои элементы (#…) или data:, иначе resvg мог бы читать файлы сервера.
 * Строка — понятная ошибка.
 */
export function renderSvgImage(svg: string): Buffer | string {
  if (svg.length > 2 * 1024 * 1024) return 'SVG больше 2 МБ.';
  if (!/<svg[\s>]/i.test(svg)) return 'это не SVG.';
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const ref = m[1]!.trim();
    if (!ref.startsWith('#') && !/^data:image\/(png|jpeg|gif);base64,/i.test(ref))
      return 'в SVG нельзя ссылаться на внешние файлы — только на свои элементы и data:.';
  }
  if (/@import|url\(\s*["']?(?!#|data:)/i.test(svg))
    return 'в SVG нельзя подключать внешние стили и шрифты.';
  try {
    const probe = new Resvg(svg, { font: { loadSystemFonts: false } });
    const side = Math.max(probe.width, probe.height);
    if (!side) return 'у SVG нет размера — задайте width и height или viewBox.';
    const fit =
      side > MAX_SVG_SIDE || side < 256
        ? Math.round(Math.min(MAX_SVG_SIDE, Math.max(side, 512)))
        : 0;
    const r = new Resvg(svg, {
      font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
      ...(fit
        ? {
            fitTo:
              probe.width >= probe.height
                ? { mode: 'width', value: fit }
                : { mode: 'height', value: fit },
          }
        : {}),
    } as ConstructorParameters<typeof Resvg>[1]);
    return r.render().asPng();
  } catch (err) {
    return `SVG не читается: ${err instanceof Error ? err.message : String(err)}`;
  }
}
