/** Короткие сообщения внизу экрана из любого места приложения (тост показывает App). */

type Listener = (text: string, ms: number) => void;
const listeners = new Set<Listener>();

export function notify(text: string, ms = 3000): void {
  for (const l of listeners) l(text, ms);
}

export function onNotify(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
