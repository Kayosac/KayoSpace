import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { addElement, getElement, makeSticky } from '@kayospace/board';
import type { Actor } from '@kayospace/model';
import { startHub, type Hub } from './hub';

const me: Actor = { kind: 'human', name: 'я' };

describe('задачи на хабе', () => {
  let dir: string;
  let hub: Hub;
  let client: Client;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kayospace-tasks-'));
    hub = await startHub({ dataDir: dir, port: 0, host: '127.0.0.1', saveDelayMs: 10 });
    client = new Client({ name: 'tasks-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port}/mcp`)),
    );
  });
  afterEach(async () => {
    await client.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError };
  };

  it('агент ставит задачи; приложение видит их со всех досок и меняет статус', async () => {
    const doc = await hub.store.get('home');
    const s = makeSticky('Купить лампу', { x: 0, y: 0, actor: me });
    addElement(doc, s);
    expect((await call('update_task', { board: 'home', id: s.id, due: '2020-01-01' })).text).toBe(
      'Готово.',
    );
    await call('add_elements', {
      board: 'work',
      items: [{ text: 'Отчёт', task: { status: 'doing', high: true } }, { text: 'Просто мысль' }],
    });

    const base = `http://127.0.0.1:${hub.port}/api/tasks`;
    const list = (await (await fetch(base)).json()) as {
      boards: { board: string; tasks: { id: string; text: string; task: { status: string } }[] }[];
    };
    expect(list.boards.map((b) => [b.board, b.tasks.map((t) => [t.text, t.task.status])])).toEqual([
      ['home', [['Купить лампу', 'todo']]],
      ['work', [['Отчёт', 'doing']]],
    ]);
    const overdue = JSON.parse((await call('list_tasks', { overdue: true })).text) as {
      tasks: { text: string }[];
    }[];
    expect(overdue.flatMap((b) => b.tasks.map((t) => t.text))).toEqual(['Купить лампу']);
    expect((await call('read_board', { board: 'work' })).text).toContain(
      'Задача [~] В работе (важно) «Отчёт»',
    );

    const r = await fetch(`${base}/home/${s.id}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'done' }),
    });
    expect(r.status).toBe(200);
    const el = getElement(doc, s.id);
    expect(el?.type === 'sticky' && el.props.task?.status).toBe('done');
    expect((await fetch(`${base}/home/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
    await call('update_task', { board: 'home', id: s.id, task: false });
    const plain = getElement(doc, s.id);
    expect(plain?.type === 'sticky' && plain.props.task).toBeUndefined();
  });
});
