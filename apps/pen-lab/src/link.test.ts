import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHub, type Hub } from '@kayospace/hub';
import { BoardLink, hubSyncUrl, type RemoteStroke } from './link';

describe('адрес хаба', () => {
  it('понимает разные варианты ввода', () => {
    expect(hubSyncUrl('192.168.1.10:4000', 'pen-lab')).toBe('ws://192.168.1.10:4000/sync/pen-lab');
    expect(hubSyncUrl('192.168.1.10', 'b')).toBe('ws://192.168.1.10:4000/sync/b');
    expect(hubSyncUrl('http://mac.local:5000', 'b')).toBe('ws://mac.local:5000/sync/b');
    expect(hubSyncUrl('https://hub.example.com', 'b')).toBe('wss://hub.example.com/sync/b');
    expect(hubSyncUrl('1-2-3-4.sslip.io', 'b')).toBe('wss://1-2-3-4.sslip.io/sync/b');
    expect(hubSyncUrl('localhost:4000', 'b')).toBe('ws://localhost:4000/sync/b');
  });

  it('добавляет токен', () => {
    expect(hubSyncUrl('hub.example.com', 'b', 'a b&c')).toBe(
      'wss://hub.example.com/sync/b?token=a%20b%26c',
    );
  });

  it('отвергает плохой ввод', () => {
    expect(hubSyncUrl('', 'b')).toBeNull();
    expect(hubSyncUrl('192.168.1.10:4000', '../x')).toBeNull();
    expect(hubSyncUrl('ftp://host', 'b')).toBeNull();
  });
});

describe('Pen Lab ↔ хаб', () => {
  let dir: string;
  let hub: Hub;
  const links: BoardLink[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-penlab-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 20 });
  });

  afterEach(async () => {
    for (const l of links.splice(0)) l.destroy();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  function open(name: string) {
    const got: RemoteStroke[] = [];
    const deleted: string[] = [];
    const link = new BoardLink(
      `ws://127.0.0.1:${hub.port}/sync/penlab-test`,
      { kind: 'human', name },
      {
        onStroke: (s) => got.push(s),
        onDelete: (id) => deleted.push(id),
        onStatus: () => {},
      },
    );
    links.push(link);
    return { link, got, deleted };
  }

  async function until(check: () => boolean, what: string): Promise<void> {
    const t0 = Date.now();
    while (!check()) {
      if (Date.now() - t0 > 5000) throw new Error(`Не дождались: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('штрих с планшета приходит на мак в тех же координатах, удаление — тоже', async () => {
    const tablet = open('tablet');
    const mac = open('mac');
    await tablet.link.client.waitFor('synced');
    await mac.link.client.waitFor('synced');

    const points = [
      { x: 300, y: 200, p: 0.3, tx: 0, ty: 0, t: 1000 },
      { x: 310, y: 205, p: 0.6, tx: 0, ty: 0, t: 1008 },
      { x: 325, y: 215, p: 0.8, tx: 0, ty: 0, t: 1016 },
    ];
    const id = tablet.link.publish(points, 6, true);
    await until(() => mac.got.length === 1, 'штрих на маке');
    expect(tablet.got).toHaveLength(0); // свой штрих обратно не приходит
    const s = mac.got[0]!;
    expect(s.id).toBe(id);
    expect(s.size).toBe(6);
    expect(s.hasPressure).toBe(true);
    expect(s.points[0]!.x).toBeCloseTo(300, 3);
    expect(s.points[2]!.y).toBeCloseTo(215, 3);

    tablet.link.remove([id]);
    await until(() => mac.deleted.includes(id), 'удаление на маке');
  });
});
