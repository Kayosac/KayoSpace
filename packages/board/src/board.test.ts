import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodeStroke, type Actor } from '@kayospace/model';
import {
  addElement,
  boardToJSON,
  boardToMarkdown,
  createBoardDoc,
  deleteElement,
  freeSpot,
  getBoardName,
  listElements,
  makeSticky,
  makeStroke,
  newId,
  observeElements,
  updateElement,
} from './index';

const me: Actor = { kind: 'human', name: 'kayos' };
const claude: Actor = { kind: 'agent', name: 'claude-code' };

/** Синхронизировать два документа в обе стороны, как это делает протокол. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

const wave = Array.from({ length: 20 }, (_, i) => ({
  x: 100 + i * 5,
  y: 200 + Math.sin(i / 3) * 10,
  p: 0.5,
  tx: 0,
  ty: 0,
  t: 1000 + i * 4,
}));

describe('ids', () => {
  it('сортируются по времени', () => {
    const a = newId(1_000_000);
    const b = newId(2_000_000);
    expect(a.length).toBe(26);
    expect(a < b).toBe(true);
  });
});

describe('доска', () => {
  it('хранит имя', () => {
    expect(getBoardName(createBoardDoc('Идеи'))).toBe('Идеи');
  });

  it('добавляет, обновляет и удаляет элементы', () => {
    const doc = createBoardDoc();
    const s = makeSticky('Купить молоко', { x: 10, y: 20, actor: me });
    addElement(doc, s);
    expect(listElements(doc)).toHaveLength(1);
    expect(updateElement(doc, s.id, { x: 50 }, me)).toBe(true);
    expect(listElements(doc)[0]!.x).toBe(50);
    expect(deleteElement(doc, s.id)).toBe(true);
    expect(listElements(doc)).toHaveLength(0);
    expect(deleteElement(doc, s.id)).toBe(false);
  });

  it('штрих хранит точки относительно рамки и переживает синхронизацию', () => {
    const a = createBoardDoc();
    const b = createBoardDoc();
    const stroke = makeStroke(wave, { hasPressure: true, actor: me });
    addElement(a, stroke);
    sync(a, b);
    const got = listElements(b)[0]!;
    expect(got.type).toBe('stroke');
    if (got.type !== 'stroke') return;
    expect(got.x).toBe(100);
    const pts = decodeStroke(got.props.points);
    expect(pts).toHaveLength(20);
    expect(pts[0]!.x).toBe(0);
    expect(pts[0]!.t).toBe(0);
  });

  it('сливает офлайн-правки двух устройств', () => {
    const tablet = createBoardDoc('Общая');
    const mac = createBoardDoc();
    sync(tablet, mac);
    // Оба офлайн: каждый добавляет своё, один удаляет общий элемент.
    const shared = makeSticky('общий', { x: 0, y: 0, actor: me });
    addElement(tablet, shared);
    sync(tablet, mac);
    addElement(tablet, makeSticky('с планшета', { x: 0, y: 300, actor: me }));
    addElement(mac, makeSticky('с мака', { x: 300, y: 0, actor: me }));
    deleteElement(mac, shared.id);
    sync(tablet, mac);
    const texts = (d: Y.Doc) =>
      listElements(d)
        .map((e) => (e.type === 'sticky' ? e.props.content : ''))
        .sort();
    expect(texts(tablet)).toEqual(['с мака', 'с планшета']);
    expect(texts(mac)).toEqual(texts(tablet));
  });

  it('сообщает об изменениях с origin транзакции', () => {
    const doc = createBoardDoc();
    const seen: string[] = [];
    const stop = observeElements(doc, (c) => seen.push(`${c.added.length}/${String(c.origin)}`));
    addElement(doc, makeSticky('a', { x: 0, y: 0, actor: me }), 'local');
    stop();
    addElement(doc, makeSticky('b', { x: 0, y: 0, actor: me }), 'local');
    expect(seen).toEqual(['1/local']);
  });
});

describe('экспорт для агентов', () => {
  it('Markdown в порядке чтения, со сводкой штрихов и пометкой агента', () => {
    const doc = createBoardDoc('План');
    addElement(doc, makeSticky('второй', { x: 400, y: 10, actor: me }));
    addElement(doc, makeSticky('первый', { x: 10, y: 30, actor: me }));
    addElement(doc, makeSticky('ниже', { x: 10, y: 500, actor: claude }));
    addElement(doc, makeStroke(wave, { hasPressure: true, actor: me }));
    const md = boardToMarkdown(doc, 'b1');
    expect(md).toContain('# Доска: План');
    expect(md.indexOf('первый')).toBeLessThan(md.indexOf('второй'));
    expect(md.indexOf('второй')).toBeLessThan(md.indexOf('ниже'));
    expect(md).toContain('добавил агент claude-code');
    expect(md).toContain('Штрихов: 1, точек: 20');
  });

  it('пустая доска', () => {
    expect(boardToMarkdown(createBoardDoc())).toContain('Доска пустая');
  });

  it('JSON без точек штрихов', () => {
    const doc = createBoardDoc();
    addElement(doc, makeStroke(wave, { hasPressure: true, actor: me }));
    const json = boardToJSON(doc) as { elements: { props: Record<string, unknown> }[] };
    expect(json.elements[0]!.props.points).toBeUndefined();
    expect(json.elements[0]!.props.pointCount).toBe(20);
  });

  it('свободное место справа от занятой области', () => {
    const doc = createBoardDoc();
    expect(freeSpot(doc)).toEqual({ x: 100, y: 100 });
    addElement(doc, makeSticky('a', { x: 0, y: 50, actor: me }));
    expect(freeSpot(doc)).toEqual({ x: 240, y: 50 });
  });
});
