import { afterEach, describe, expect, it, vi } from 'vitest';
import { elementToWire, makeSticky } from '@kayospace/board';
import { AiController, type AiState } from './ai';

const actor = { kind: 'agent' as const, name: 'kayospace-ai' };

function hubStub(steps: unknown[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let poll = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.endsWith('/api/ai/tasks') && method === 'POST') return json(201, { id: 't1' });
      if (url.endsWith('/api/ai/status')) return json(200, { workers: [] });
      if (url.endsWith('/api/ai/tasks/t1') && method === 'DELETE') return json(200, { ok: true });
      if (url.endsWith('/api/ai/tasks/t1'))
        return json(200, steps[Math.min(poll++, steps.length - 1)]);
      return json(404, {});
    }),
  );
  return calls;
}

const until = async (ai: AiController, kind: AiState['kind']): Promise<AiState> => {
  for (let i = 0; i < 200; i++) {
    if (ai.getState().kind === kind) return ai.getState();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`не дождался ${kind}, сейчас ${ai.getState().kind}`);
};

afterEach(() => vi.unstubAllGlobals());

describe('AiController', () => {
  it('без хаба — понятная ошибка', async () => {
    const ai = new AiController(1);
    await ai.start({ board: 'b', action: 'summarize', selection: [], area: null });
    expect(ai.getState()).toEqual({
      kind: 'error',
      message: 'ИИ работает через хаб: включите синхронизацию в настройках.',
    });
  });

  it('задача: ждёт исполнителя, выполняется, приходит черновик; отмена удаляет задачу', async () => {
    const sticky = makeSticky('Резюме', { x: 10, y: 20, actor });
    const calls = hubStub([
      { status: 'queued', message: null, error: null },
      { status: 'running', message: null, error: null },
      {
        status: 'done',
        message: 'Сделал резюме.',
        error: null,
        draft: { elements: [elementToWire(sticky)], deleted: ['old'] },
      },
    ]);
    const ai = new AiController(1);
    ai.setHub({ url: '127.0.0.1:4000', token: 'tok' });
    await ai.start({
      board: 'b',
      action: 'summarize',
      selection: ['a'],
      area: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      image: new Blob([new Uint8Array([1, 2, 3])]),
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('http://127.0.0.1:4000/api/ai/tasks');
    expect(post.body).toMatchObject({
      board: 'b',
      action: 'summarize',
      selection: ['a'],
      image: 'AQID',
    });
    const ready = await until(ai, 'ready');
    expect(ready.kind === 'ready' && ready.message).toBe('Сделал резюме.');
    expect(ready.kind === 'ready' && ready.changes).toBe(2);
    expect(ready.kind === 'ready' && ready.draft.elements[0]).toEqual(sticky);
    ai.cancel();
    expect(ai.getState().kind).toBe('idle');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/ai/tasks/t1'))).toBe(
      true,
    );
  });

  it('ошибка исполнителя доходит до интерфейса', async () => {
    hubStub([{ status: 'error', message: null, error: 'Claude Code не вошёл в аккаунт' }]);
    const ai = new AiController(1);
    ai.setHub({ url: '127.0.0.1:4000', token: '' });
    await ai.start({ board: 'b', action: 'prompt', prompt: 'привет', selection: [], area: null });
    const st = await until(ai, 'error');
    expect(st.kind === 'error' && st.message).toBe('Claude Code не вошёл в аккаунт');
  });
});
