import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { elementsMap, makeSticky } from '@kayospace/board';
import type { Actor, StickyElement } from '@kayospace/model';
import { AgentTracker, type AgentActivity } from './agent-activity';

const me: Actor = { kind: 'human', name: 'kayos' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const LOCAL = 'local';
const REMOTE = 'remote';

function setup(now = () => 1_000_000) {
  const doc = new Y.Doc();
  const map = elementsMap(doc);
  const seen: (AgentActivity | null)[] = [];
  const tracker = new AgentTracker(map, (a) => seen.push(a), { localOrigin: LOCAL, now });
  map.observe((e) => tracker.handle(e));
  return { doc, map, seen, tracker };
}

const sticky = (text: string, actor: Actor, at = 1_000_000): StickyElement => ({
  ...makeSticky(text, { x: 0, y: 0, actor, now: at }),
  updatedBy: actor,
  updatedAt: at,
});

describe('правки агентов', () => {
  it('добавил, изменил и удалил — одной пачкой; отмена возвращает как было', () => {
    const { doc, map, seen, tracker } = setup();
    const mine = sticky('Моё', me, 1);
    const old = sticky('Старое', me, 1);
    doc.transact(() => {
      map.set(mine.id, mine);
      map.set(old.id, old);
    }, LOCAL);
    expect(seen).toEqual([]);

    const added = sticky('От агента', claude);
    doc.transact(() => {
      map.set(added.id, added);
      map.set(mine.id, {
        ...mine,
        props: { ...mine.props, content: 'Переписал' },
        updatedBy: claude,
        updatedAt: 1_000_000,
      });
      map.delete(old.id);
    }, REMOTE);
    expect(tracker.current()).toMatchObject({ name: 'Claude', added: 1, updated: 1, deleted: 1 });
    expect(tracker.current()!.ids.sort()).toEqual([added.id, mine.id].sort());

    const r = tracker.revert(doc, LOCAL);
    expect(r).toEqual({ reverted: 3, skipped: 0 });
    expect(map.has(added.id)).toBe(false);
    expect((map.get(mine.id) as { props: { content: string } }).props.content).toBe('Моё');
    expect(map.has(old.id)).toBe(true);
    expect(seen.at(-1)).toBeNull();
  });

  it('то, что человек успел поправить после агента, отмена не трогает', () => {
    const { doc, map, tracker } = setup();
    const a = sticky('Агент 1', claude);
    const b = sticky('Агент 2', claude);
    doc.transact(() => {
      map.set(a.id, a);
      map.set(b.id, b);
    }, REMOTE);
    map.set(b.id, { ...b, x: 500, updatedBy: me, updatedAt: 2_000_000 });
    expect(tracker.revert(doc, LOCAL)).toEqual({ reverted: 1, skipped: 1 });
    expect(map.has(a.id)).toBe(false);
    expect(map.get(b.id)!.x).toBe(500);
  });

  it('свои правки, чужие человеческие и старые агентские (загрузка доски) — не пачка', () => {
    const { doc, map, tracker } = setup();
    doc.transact(() => map.set('x', sticky('Своё агентское', claude)), LOCAL);
    doc.transact(() => map.set('y', sticky('С планшета', me)), REMOTE);
    doc.transact(() => map.set('z', sticky('Давнее', claude, 1)), REMOTE);
    expect(tracker.current()).toBeNull();
  });

  it('подряд идущие вызовы агента — одна пачка, после паузы — новая', () => {
    let t = 1_000_000;
    const { doc, map, tracker } = setup(() => t);
    doc.transact(() => map.set('a', sticky('1', claude, t)), REMOTE);
    t += 3000;
    doc.transact(() => map.set('b', sticky('2', claude, t)), REMOTE);
    expect(tracker.current()!.added).toBe(2);
    t += 60_000;
    doc.transact(() => map.set('c', sticky('3', claude, t)), REMOTE);
    expect(tracker.current()!.added).toBe(1);
  });
});
