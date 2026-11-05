import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElements, listElements, makeStroke } from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { strokeGroups } from './handwriting';
import { openAiFromEnv } from './openai';
import { startHub, type Hub } from './hub';

const png = new Resvg(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024"><rect width="1536" height="1024" fill="#f60"/></svg>',
)
  .render()
  .asPng();

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((r) => {
    const c: Buffer[] = [];
    req.on('data', (d: Buffer) => c.push(d));
    req.on('end', () => r(Buffer.concat(c)));
  });

describe('OpenAI: картинки и голос', () => {
  let dir: string;
  let hub: Hub;
  let fake: Server;
  let calls: { path: string; auth: string; body: string }[];
  beforeEach(async () => {
    calls = [];
    // Поддельный OpenAI: проверяем, что хаб шлёт и как разбирает ответы.
    fake = createServer(async (req, res) => {
      const b = await body(req);
      calls.push({
        path: req.url ?? '',
        auth: String(req.headers.authorization),
        body: b.toString('latin1'),
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/generations') {
        const p = JSON.parse(b.toString()) as { prompt: string };
        if (p.prompt.includes('forbidden')) {
          res.writeHead(400);
          return res.end(
            JSON.stringify({
              error: { message: 'Rejected by safety system', code: 'moderation_blocked' },
            }),
          );
        }
        return res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
      }
      if (req.url === '/v1/responses') {
        const p = JSON.parse(b.toString()) as { input: { content: { type: string }[] }[] };
        const n = p.input[0]!.content.filter((c) => c.type === 'input_image').length;
        const items = Array.from({ length: n }, (_, i) => ({
          n: i + 1,
          text: i === 0 ? 'Купить молоко' : '',
        }));
        return res.end(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify({ items }) }],
              },
            ],
          }),
        );
      }
      if (req.url === '/v1/audio/transcriptions') {
        return res.end(JSON.stringify({ text: ' Нарисуй кота на доске ' }));
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const cfg = openAiFromEnv({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
    });
    dir = await mkdtemp(join(tmpdir(), 'kayospace-openai-'));
    hub = await startHub({
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      saveDelayMs: 10,
      openai: cfg,
      handwritingQuietMs: 30,
    });
  });
  afterEach(async () => {
    await hub.close();
    await new Promise<void>((r) => fake.close(() => r()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('без ключа OpenAI выключен', () => {
    expect(openAiFromEnv({})).toBeNull();
    expect(openAiFromEnv({ OPENAI_API_KEY: '  ' })).toBeNull();
  });

  it('generate_image: картинка от OpenAI ложится на доску; отказ — понятной ошибкой', async () => {
    const client = new Client({ name: 'openai-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
    const r = (await client.callTool({
      name: 'generate_image',
      arguments: {
        board: 'art',
        prompt: 'A cozy cat on a windowsill, watercolor',
        alt: 'Кот',
        shape: 'landscape',
      },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(r.isError).toBeFalsy();
    const req = JSON.parse(calls[0]!.body) as { size: string; model: string };
    expect(calls[0]!.auth).toBe('Bearer sk-test');
    expect(req.size).toBe('1536x1024');
    const [img] = listElements(await hub.store.get('art'));
    expect(img).toMatchObject({
      type: 'image',
      w: 480,
      h: 320,
      props: { alt: 'Кот', naturalW: 1536 },
    });

    const bad = (await client.callTool({
      name: 'generate_image',
      arguments: { board: 'art', prompt: 'forbidden thing' },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('правила безопасности');
    await client.close();
  });

  it('голос: запись → текст; возможности хаба видны приложению', async () => {
    const base = `http://127.0.0.1:${hub.port}`;
    expect(await (await fetch(`${base}/api/features`)).json()).toEqual({
      imageGen: true,
      voice: true,
      handwriting: true,
    });
    const res = await fetch(`${base}/api/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm;codecs=opus' },
      body: new Uint8Array(4000).fill(7),
    });
    expect(await res.json()).toEqual({ text: 'Нарисуй кота на доске' });
    const sent = calls.find((c) => c.path === '/v1/audio/transcriptions')!;
    expect(sent.body).toContain('name="model"');
    expect(sent.body).toContain('filename="voice.webm"');
    expect(
      (await fetch(`${base}/api/voice`, { method: 'POST', body: new Uint8Array(10) })).status,
    ).toBe(400);
  });

  it('рукописное: группы штрихов распознаются, находятся поиском и видны агенту в read_board', async () => {
    const me: Actor = { kind: 'human', name: 'я' };
    const line = (x: number, y: number) =>
      makeStroke(
        [0, 1, 2, 3].map((i) => ({
          x: x + i * 10,
          y: y + (i % 2) * 8,
          p: 0.5,
          tx: 0,
          ty: 0,
          t: i * 10,
        })),
        { hasPressure: false, actor: me },
      );
    const doc = await hub.store.get('notes');
    // Две буквы рядом — одна группа; рисунок далеко — вторая.
    addElements(doc, [line(0, 0), line(40, 0), line(2000, 2000)]);
    await new Promise((r) => setTimeout(r, 300));
    await hub.handwriting.index('notes');
    expect((await hub.handwriting.entries('notes')).map((e) => e.text)).toEqual(['Купить молоко']);
    const vision = calls.filter((c) => c.path === '/v1/responses');
    expect(vision).toHaveLength(1);
    expect(vision[0]!.body.match(/input_image/g)).toHaveLength(2);

    // Повтор — без новых запросов: группы не изменились.
    await hub.handwriting.index('notes');
    expect(calls.filter((c) => c.path === '/v1/responses')).toHaveLength(1);

    const search = (await (
      await fetch(`http://127.0.0.1:${hub.port}/api/search?q=молоко`)
    ).json()) as { hits: { type: string; id: string }[] };
    expect(search.hits).toMatchObject([{ type: 'handwriting' }]);
    const client = new Client({ name: 'hw-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
    const read = (await client.callTool({ name: 'read_board', arguments: { board: 'notes' } })) as {
      content: { text: string }[];
    };
    expect(read.content[0]!.text).toContain('## Рукописное (распознано)');
    expect(read.content[0]!.text).toContain('Купить молоко');
    await client.close();
  });
});

describe('группы штрихов', () => {
  it('соседние штрихи — одна группа, далёкие — разные, точки не в счёт', () => {
    const me: Actor = { kind: 'human', name: 'я' };
    const at = (x: number, y: number, len = 30) =>
      makeStroke(
        [0, 1].map((i) => ({ x: x + i * len, y, p: 0.5, tx: 0, ty: 0, t: i })),
        { hasPressure: false, actor: me },
      );
    const groups = strokeGroups([at(0, 0), at(50, 10), at(500, 0), at(3000, 0, 2)]);
    expect(groups.map((g) => g.ids.length)).toEqual([2, 1]);
    const again = strokeGroups([at(0, 0), at(50, 10)]);
    expect(again[0]!.key).toHaveLength(16);
  });
});
