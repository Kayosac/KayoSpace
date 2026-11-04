/**
 * Протокол синхронизации доски. Одно WebSocket-соединение = одна доска.
 *
 * Сообщение: [тип: 1 байт][данные].
 *   0 STEP1  — мой вектор состояния: «вот что у меня уже есть».
 *   1 STEP2  — ответ на STEP1: всё, чего у собеседника нет (diff).
 *   2 UPDATE — новое изменение, разосланное в реальном времени.
 *
 * При подключении обе стороны шлют STEP1 и отвечают STEP2 — так правки, сделанные офлайн,
 * доезжают в обе стороны без отдельной очереди: всё нужное уже лежит в Y.Doc.
 */

import * as Y from 'yjs';

export const MSG_STEP1 = 0;
export const MSG_STEP2 = 1;
export const MSG_UPDATE = 2;

export type MessageType = typeof MSG_STEP1 | typeof MSG_STEP2 | typeof MSG_UPDATE;

export function encodeMessage(type: MessageType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export function decodeMessage(data: Uint8Array): { type: MessageType; payload: Uint8Array } {
  if (data.byteLength < 1) throw new Error('Пустое сообщение синхронизации');
  const type = data[0]!;
  if (type !== MSG_STEP1 && type !== MSG_STEP2 && type !== MSG_UPDATE) {
    throw new Error(`Неизвестный тип сообщения синхронизации: ${type}`);
  }
  return { type, payload: data.subarray(1) };
}

export function step1Message(doc: Y.Doc): Uint8Array {
  return encodeMessage(MSG_STEP1, Y.encodeStateVector(doc));
}

export function updateMessage(update: Uint8Array): Uint8Array {
  return encodeMessage(MSG_UPDATE, update);
}

/**
 * Обработать входящее сообщение. Возвращает ответ, который нужно отправить, или null.
 * origin — метка транзакции: по ней отправитель не пересылает изменение обратно.
 */
export function handleMessage(
  doc: Y.Doc,
  data: Uint8Array,
  origin: unknown,
): { reply: Uint8Array | null; type: MessageType } {
  const { type, payload } = decodeMessage(data);
  if (type === MSG_STEP1) {
    return { type, reply: encodeMessage(MSG_STEP2, Y.encodeStateAsUpdate(doc, payload)) };
  }
  Y.applyUpdate(doc, payload, origin);
  return { type, reply: null };
}

/** Допустимое имя доски в адресе: латиница, цифры, «-» и «_», до 64 символов. */
export const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidBoardId(id: string): boolean {
  return BOARD_ID_RE.test(id);
}
