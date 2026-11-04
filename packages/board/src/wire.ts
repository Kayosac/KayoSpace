/**
 * Элементы в JSON для передачи по HTTP (черновики ИИ): бинарные точки штриха — в base64.
 */

import type { CanvasElement } from '@kayospace/model';

export type WireElement = Omit<CanvasElement, 'props'> & { props: Record<string, unknown> };

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function elementToWire(el: CanvasElement): WireElement {
  if (el.type !== 'stroke') return el as WireElement;
  return { ...el, props: { ...el.props, points: { $b64: toBase64(el.props.points) } } } as WireElement;
}

export function elementFromWire(w: WireElement): CanvasElement {
  const pts = (w.props as { points?: unknown }).points;
  if (w.type === 'stroke' && pts && typeof pts === 'object' && '$b64' in pts) {
    return { ...w, props: { ...w.props, points: fromBase64((pts as { $b64: string }).$b64) } } as CanvasElement;
  }
  return w as unknown as CanvasElement;
}
