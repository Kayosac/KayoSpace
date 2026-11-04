import { describe, expect, it } from 'vitest';
import type { Actor } from '@kayospace/model';
import { makeSticky, makeStroke } from './factory';
import { elementFromWire, elementToWire } from './wire';

const me: Actor = { kind: 'human', name: 't' };

describe('элементы в JSON', () => {
  it('штрих: точки туда и обратно через base64', () => {
    const s = makeStroke(
      Array.from({ length: 40 }, (_, i) => ({ x: i, y: i * 2, p: 0.5, tx: 0, ty: 0, t: i })),
      { hasPressure: true, actor: me },
    );
    const back = elementFromWire(JSON.parse(JSON.stringify(elementToWire(s))));
    expect(back.type === 'stroke' && Array.from(back.props.points)).toEqual(Array.from(s.props.points));
  });

  it('остальные элементы — как есть', () => {
    const st = makeSticky('x', { x: 1, y: 2, actor: me });
    expect(elementFromWire(JSON.parse(JSON.stringify(elementToWire(st))))).toEqual(st);
  });
});
