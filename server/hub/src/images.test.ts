import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElement, getElement, listElements, makeFrame } from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { addRow, initTable, readTable } from '@kayospace/page';
import { decodeImageData, fetchImage, imageInfo, isPrivateAddress, renderSvgImage } from './images';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'я' };
const png = (w: number, h: number) =>
  new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#e5484d"/></svg>`,
  )
    .render()
    .asPng();

/** Минимальный JPEG-заголовок: SOI, при желании APP1 с EXIF-поворотом, SOF0. */
function jpeg(w: number, h: number, orientation?: number): Buffer {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write('MM', 0, 'ascii');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
    const head = Buffer.from([0xff, 0xe1, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    parts.push(head, body);
  }
  const sof = Buffer.from([
    0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

describe('размер картинки по заголовку', () => {
  it('PNG, GIF, JPEG (с поворотом EXIF), WebP', () => {
    expect(imageInfo(png(30, 20))).toEqual({ mime: 'image/png', width: 30, height: 20 });
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00\x00\x00', 'latin1');
    expect(imageInfo(gif)).toEqual({ mime: 'image/gif', width: 320, height: 240 });
    expect(imageInfo(jpeg(800, 600))).toEqual({ mime: 'image/jpeg', width: 800, height: 600 });
    expect(imageInfo(jpeg(800, 600, 6))).toEqual({ mime: 'image/jpeg', width: 600, height: 800 });
    expect(imageInfo(jpeg(800, 600, 1))).toEqual({ mime: 'image/jpeg', width: 800, height: 600 });

    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'ascii');
    vp8x.write('WEBP', 8, 'ascii');
    vp8x.write('VP8X', 12, 'ascii');
    vp8x.writeUIntLE(1919, 24, 3);
    vp8x.writeUIntLE(1079, 27, 3);
    expect(imageInfo(vp8x)).toEqual({ mime: 'image/webp', width: 1920, height: 1080 });

    const vp8l = Buffer.alloc(30);
    vp8l.write('RIFF', 0, 'ascii');
    vp8l.write('WEBP', 8, 'ascii');
    vp8l.write('VP8L', 12, 'ascii');
    // 14 бит ширины-1 и 14 бит высоты-1, начиная с 21-го байта.
    const bits = (100 - 1) | ((50 - 1) << 14);
    vp8l.writeUInt32LE(bits, 21);
    expect(imageInfo(vp8l)).toEqual({ mime: 'image/webp', width: 100, height: 50 });

    expect(imageInfo(Buffer.from('<svg></svg>'))).toBeNull();
  });

  it('base64 и data:-ссылка', () => {
    const p = png(4, 4);
    expect(decodeImageData(p.toString('base64'))).toEqual(p);
    expect(decodeImageData(`data:image/png;base64,${p.toString('base64')}`)).toEqual(p);
    expect(decodeImageData('это не base64!')).toBeNull();
  });
});

describe('картинка, нарисованная агентом (SVG)', () => {
  it('становится PNG; мелкая — крупнее, огромная — меньше', () => {
    const svg = (w: number, h: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#0a0"/></svg>`;
    const info = (b: Buffer | string) => (typeof b === 'string' ? b : imageInfo(b));
    expect(info(renderSvgImage(svg(800, 400)))).toEqual({
      mime: 'image/png',
      width: 800,
      height: 400,
    });
    expect(info(renderSvgImage(svg(64, 64)))).toMatchObject({ width: 512, height: 512 });
    expect(info(renderSvgImage(svg(8000, 4000)))).toMatchObject({ width: 1600, height: 800 });
    const vb =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 600"><circle cx="150" cy="300" r="100"/></svg>';
    expect(info(renderSvgImage(vb))).toMatchObject({ width: 300, height: 600 });
  });

  it('внешние ссылки, файлы и стили запрещены', () => {
    const wrap = (inner: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">${inner}</svg>`;
    expect(
      renderSvgImage(wrap('<image href="file:///etc/passwd" width="10" height="10"/>')),
    ).toContain('внешние');
    expect(
      renderSvgImage(wrap('<image xlink:href="https://x.com/a.png" width="1" height="1"/>')),
    ).toContain('внешние');
    expect(renderSvgImage(wrap('<style>@import url(https://x.com/a.css);</style>'))).toContain(
      'стили',
    );
    expect(renderSvgImage(wrap('<rect fill="url(https://x/y)" width="1" height="1"/>'))).toContain(
      'стили',
    );
    expect(
      typeof renderSvgImage(
        wrap('<defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="5" height="5"/>'),
      ),
    ).not.toBe('string');
    expect(renderSvgImage('<html></html>')).toContain('не SVG');
  });
});

describe('загрузка по ссылке', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/pic.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png(10, 10));
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: '/pic.png' });
        res.end();
      } else if (req.url === '/huge') {
        res.writeHead(200, { 'content-length': String(100 * 1024 * 1024) });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('внутренние адреса запрещены', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.5',
      '172.20.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
    await expect(fetchImage(`${base}/pic.png`)).rejects.toThrow('внутреннюю сеть');
    await expect(fetchImage(`http://localhost:1/pic.png`)).rejects.toThrow('внутреннюю сеть');
    await expect(fetchImage('file:///etc/passwd')).rejects.toThrow('http');
  });

  it('скачивает, идёт по перенаправлению, не берёт огромное', async () => {
    const o = { allowPrivate: true };
    expect(imageInfo(await fetchImage(`${base}/pic.png`, o))?.width).toBe(10);
    expect(imageInfo(await fetchImage(`${base}/moved`, o))?.width).toBe(10);
    await expect(fetchImage(`${base}/huge`, o)).rejects.toThrow('больше 15 МБ');
    await expect(fetchImage(`${base}/nope`, o)).rejects.toThrow('404');
  });
});

describe('картинки через MCP', () => {
  let dir: string;
  let hub: Hub;
  let client: Client;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-images-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
    client = new Client({ name: 'images-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
  });
  afterEach(async () => {
    await client.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  type Result = {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as Result;

  it('агент кладёт картинку файлом во фрейм и смотрит её; файл — на хабе', async () => {
    const doc = await hub.store.get('pics');
    const frame = makeFrame('Фото', { x: 0, y: 0, w: 200, h: 200 }, { actor: me });
    addElement(doc, frame);
    const r = await call('add_images', {
      board: 'pics',
      frame: frame.id,
      images: [
        { data: png(1200, 600).toString('base64'), alt: 'Красный прямоугольник' },
        { data: `data:image/jpeg;base64,${jpeg(300, 400).toString('base64')}`, width: 150 },
      ],
      layout: 'row',
    });
    expect(r.isError).toBeFalsy();
    const added = JSON.parse(r.content[0]!.text!).added as { id: string; w: number; h: number }[];
    expect(added.map((a) => [a.w, a.h])).toEqual([
      [480, 240],
      [150, 200],
    ]);
    const img = getElement(doc, added[0]!.id)!;
    expect(img.type === 'image' && img.props).toMatchObject({
      naturalW: 1200,
      naturalH: 600,
      alt: 'Красный прямоугольник',
    });
    // Фрейм растянулся под картинки.
    expect(getElement(doc, frame.id)!.w).toBeGreaterThan(480 + 150);
    const res = await fetch(
      `http://127.0.0.1:${hub.port}/api/assets/${img.type === 'image' ? img.props.assetId : ''}`,
    );
    expect(res.headers.get('content-type')).toBe('image/png');

    const big = await call('get_image', { board: 'pics', id: added[0]!.id, maxSize: 600 });
    expect(big.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(imageInfo(Buffer.from(big.content[0]!.data!, 'base64'))).toMatchObject({
      width: 600,
      height: 300,
    });
    expect(big.content[1]!.text).toContain('1200×600, показана 600×300');
    const small = await call('get_image', { board: 'pics', id: added[1]!.id });
    expect(small.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('плохая картинка или внутренняя ссылка — ничего не добавляется', async () => {
    await hub.store.get('pics');
    const bad = await call('add_images', {
      board: 'pics',
      images: [
        { data: png(10, 10).toString('base64') },
        { data: Buffer.from('привет').toString('base64') },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('Картинка 2');
    const local = await call('add_images', {
      board: 'pics',
      images: [{ url: `http://127.0.0.1:${hub.port}/health` }],
    });
    expect(local.isError).toBe(true);
    expect(local.content[0]!.text).toContain('внутреннюю сеть');
    expect(listElements(await hub.store.get('pics'))).toEqual([]);
  });
});

describe('картинка-файл из чата ChatGPT (openai/fileParams)', () => {
  let dir: string;
  let hub: Hub;
  let client: Client;
  let files: Server;
  let base: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-files-'));
    hub = await startHub({
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      saveDelayMs: 10,
      allowPrivateImageUrls: true,
    });
    client = new Client({ name: 'openai-mcp', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
    // Так ChatGPT отдаёт файл: временная ссылка на свой сервер.
    files = createServer((req, res) => {
      if (req.url === '/files/abc?sig=secret') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png(800, 400));
      } else {
        res.writeHead(403);
        res.end();
      }
    });
    await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await client.close();
    await hub.close();
    await new Promise<void>((r) => files.close(() => r()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('инструмент помечен для ChatGPT; файл скачивается и ложится на доску, ссылка не утекает', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'add_image_file')!;
    expect(tool._meta?.['openai/fileParams']).toEqual(['file']);
    const schema = tool.inputSchema as unknown as {
      properties: { file: { required: string[]; additionalProperties: boolean } };
    };
    expect(schema.properties.file.required.sort()).toEqual(['download_url', 'file_id']);
    expect(schema.properties.file.additionalProperties).toBe(false);

    await hub.store.get('pics');
    const url = `${base}/files/abc?sig=secret`;
    const r = (await client.callTool({
      name: 'add_image_file',
      arguments: {
        board: 'pics',
        file: {
          download_url: url,
          file_id: 'file-abc',
          mime_type: 'image/png',
          file_name: 'кот.png',
        },
      },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).not.toContain('secret');
    const [img] = listElements(await hub.store.get('pics'));
    expect(img?.type === 'image' && img.props).toMatchObject({
      naturalW: 800,
      naturalH: 400,
      alt: 'кот.png',
    });
    expect([img!.w, img!.h]).toEqual([480, 240]);

    const bad = (await client.callTool({
      name: 'add_image_file',
      arguments: { board: 'pics', file: { download_url: `${base}/expired`, file_id: 'x' } },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('403');
    expect(bad.content[0]!.text).not.toContain(base);
  });

  it('файл из чата — в ячейку таблицы: в существующую строку и новой строкой (решение 0024)', async () => {
    const t = hub.store.get('tb_cat');
    const doc = await t;
    initTable(doc, [
      { name: 'Кличка', type: 'text' },
      { name: 'Фото', type: 'text' },
    ]);
    const row = addRow(doc, { [readTable(doc).columns[0]!.id]: 'Барсик' });
    const file = { download_url: `${base}/files/abc?sig=secret`, file_id: 'file-abc' };
    const call = (args: Record<string, unknown>) =>
      client.callTool({ name: 'add_image_file', arguments: args }) as Promise<{
        isError?: boolean;
        content: { text?: string }[];
      }>;
    const r = await call({ board: 'tb_cat', row, column: 'Фото', file, alt: 'Барсик спит' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain('в ячейке «Фото»');
    expect(r.content[0]!.text).not.toContain('secret');
    // Вторая — к первой; без row — новая строка.
    await call({ board: 'tb_cat', row, column: 'Фото', file });
    await call({ board: 'tb_cat', column: 'Кличка', file });
    const { columns, rows } = readTable(doc);
    const [name, photo] = columns;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.images![photo!.id]!.map((i) => [i.w, i.h, i.alt])).toEqual([
      [800, 400, 'Барсик спит'],
      [800, 400, undefined],
    ]);
    expect(rows[1]!.images![name!.id]).toHaveLength(1);
    // Без колонки, с чужой колонкой или строкой — понятная ошибка, таблица не меняется.
    expect((await call({ board: 'tb_cat', row, file })).content[0]!.text).toContain('нужна column');
    expect((await call({ board: 'tb_cat', column: 'Нет', file })).content[0]!.text).toContain(
      'Колонки «Нет» нет',
    );
    expect(
      (await call({ board: 'tb_cat', row: 'нет', column: 'Фото', file })).content[0]!.text,
    ).toContain('Строки нет нет');
    expect(readTable(doc).rows).toHaveLength(2);
    expect((await call({ board: 'pg_x', column: 'Фото', file })).isError).toBe(true);
  });
});
