import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from './store';
import { AiQueue } from './ai';
describe('очередь ИИ: исполнитель пропал или перезапустился', () => {
  it('оборванный запрос не получает задачу, перезапущенный исполнитель получает свою снова', async () => {
    const store = new BoardStore(mkdtempSync(join(tmpdir(), 'ai-')), 10);
    await store.init();
    const ai = new AiQueue(store);
    const ctrl = new AbortController();
    const dead = ai.next('w', 5000, ctrl.signal);
    ctrl.abort();
    expect(await dead).toBe(null);
    const t = await ai.create({ board: 'b', action: 'summarize' });
    expect(t.status).toBe('queued');
    const got = await ai.next('w', 100);
    expect(got?.id).toBe(t.id);
    // перезапуск: тот же исполнитель просит снова — задача возвращается ему же
    const again = await ai.next('w', 100);
    expect(again?.id).toBe(t.id);
    expect(again?.status).toBe('running');
    // другой исполнитель ждёт, первый пропал с задачей → requeue отдаёт второму
    const waiting = ai.next('w2', 2000);
    ai.requeue(t);
    expect((await waiting)?.id).toBe(t.id);
    ai.close();
    await store.close();
  });
});
