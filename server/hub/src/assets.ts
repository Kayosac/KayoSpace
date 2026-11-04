/**
 * Файлы досок (картинки): хранятся на диске хаба по SHA-256 содержимого — одинаковый файл
 * хранится один раз, а id сразу проверяет целостность. Доска хранит только id.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ASSET_ID_RE = /^[0-9a-f]{64}$/;
/** Больше — отказ: доска не файлообменник. */
export const MAX_ASSET_BYTES = 30 * 1024 * 1024;

export class AssetStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  file(id: string): string {
    return join(this.dir, id);
  }

  async has(id: string): Promise<boolean> {
    try {
      await stat(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<Buffer | null> {
    if (!ASSET_ID_RE.test(id)) return null;
    try {
      return await readFile(this.file(id));
    } catch {
      return null;
    }
  }

  /** Сохранить; false — содержимое не совпало с id. */
  async put(id: string, data: Buffer): Promise<boolean> {
    if (!ASSET_ID_RE.test(id)) return false;
    if (sha256(data) !== id) return false;
    if (await this.has(id)) return true;
    const tmp = `${this.file(id)}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, this.file(id));
    return true;
  }
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Тип картинки по первым байтам (для Content-Type при выдаче). */
export function sniffType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return 'application/octet-stream';
}

/** Прочитать тело запроса не больше limit байт; null — слишком большое. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      else if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** GET /api/assets/<id> и PUT /api/assets/<id>. Доступ уже проверен. */
export async function handleAsset(
  req: IncomingMessage,
  res: ServerResponse,
  store: AssetStore,
  id: string,
): Promise<void> {
  if (!ASSET_ID_RE.test(id)) return send(res, 400, 'Неверный id файла');
  if (req.method === 'GET') {
    const data = await store.get(id);
    if (!data) return send(res, 404, 'Файла нет на хабе');
    res.writeHead(200, {
      'Content-Type': sniffType(data),
      'Content-Length': data.length,
      // Содержимое по id не меняется никогда.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.end(data);
    return;
  }
  if (req.method === 'PUT') {
    const body = await readBody(req, MAX_ASSET_BYTES);
    if (!body) return send(res, 413, 'Файл больше 30 МБ');
    if (!(await store.put(id, body)))
      return send(res, 400, 'Содержимое не совпадает с id (SHA-256)');
    return send(res, 201, 'Сохранено');
  }
  send(res, 405, 'Метод не поддерживается');
}

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(status < 300 ? { ok: true } : { error: message }));
}
