import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MSG_STEP2,
  decodeMessage,
  encodeMessage,
  handleMessage,
  isValidBoardId,
  step1Message,
} from './protocol';

describe('протокол', () => {
  it('кодирует и декодирует сообщения', () => {
    const msg = encodeMessage(MSG_STEP2, new Uint8Array([7, 8, 9]));
    const { type, payload } = decodeMessage(msg);
    expect(type).toBe(MSG_STEP2);
    expect([...payload]).toEqual([7, 8, 9]);
  });

  it('отвергает неизвестный тип', () => {
    expect(() => decodeMessage(new Uint8Array([42]))).toThrow(/Неизвестный тип/);
  });

  it('двусторонний обмен STEP1/STEP2 сводит документы', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getMap('m').set('a', 1);
    b.getMap('m').set('b', 2);
    // обе стороны шлют STEP1, получают в ответ STEP2 и применяют его
    const replyToA = handleMessage(b, step1Message(a), 'a').reply!;
    const replyToB = handleMessage(a, step1Message(b), 'b').reply!;
    handleMessage(a, replyToA, 'b');
    handleMessage(b, replyToB, 'a');
    expect(a.getMap('m').toJSON()).toEqual({ a: 1, b: 2 });
    expect(b.getMap('m').toJSON()).toEqual({ a: 1, b: 2 });
  });

  it('проверяет имя доски', () => {
    expect(isValidBoardId('pen-lab_1')).toBe(true);
    expect(isValidBoardId('../etc')).toBe(false);
    expect(isValidBoardId('')).toBe(false);
  });
});
