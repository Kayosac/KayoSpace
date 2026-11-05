import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { fontSizeOf } from '@kayospace/board';
import {
  LINE_HEIGHT,
  NOTE_FONT,
  STICKY_INK,
  worldToScreen,
  type CanvasEngine,
  type EngineState,
  taskBand,
} from '@kayospace/canvas';

/**
 * Поле ввода поверх стикера или текста. Шрифт, отступы, перенос и поворот — как на холсте,
 * поэтому после правки текст остаётся на том же месте. В стикере шрифт подбирается под размер
 * стикера прямо во время набора.
 */
export function NoteEditor({ engine, state }: { engine: CanvasEngine; state: EngineState }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.onCamera(bump), [engine]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const el = state.editing ? engine.getEditingElement() : null;
  const content = el && (el.type === 'sticky' || el.type === 'text') ? el.props.content : '';
  const [text, setText] = useState(content);

  // Новая правка: текст, фокус, курсор в конец; холст читает набранное отсюда.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!state.editing || !ta) return;
    ta.value = content;
    setText(content);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    if (el?.type === 'text') grow(ta);
    engine.setEditTextSource(() => ta.value);
    return () => engine.setEditTextSource(null);
    // content читаем только в момент начала правки — он не в зависимостях.
  }, [engine, state.editing]);

  if (!el || (el.type !== 'sticky' && el.type !== 'text')) return null;
  const cam = engine.getCamera();
  const z = cam.zoom;
  const sticky = el.type === 'sticky';
  const rot = el.rotation ?? 0;
  // Левый верхний угол повёрнутого элемента.
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const corner = {
    x: cx + (-el.w / 2) * Math.cos(rot) - (-el.h / 2) * Math.sin(rot),
    y: cy + (-el.w / 2) * Math.sin(rot) + (-el.h / 2) * Math.cos(rot),
  };
  const p = worldToScreen(cam, corner.x, corner.y);
  const angle = rot + (cam.rotation ?? 0);
  let font: number;
  let padX: number;
  let padTop: number;
  if (sticky) {
    // У задачи внизу полоса со статусом — текст выше неё, как на холсте.
    const band = taskBand(el);
    const fit = engine.renderer.fitSticky(text, el.w, el.h - band);
    font = fit.size;
    padX = fit.pad;
    // Текст стикера — по центру по вертикали, как на холсте.
    const lines = Math.max(1, fit.lines.length);
    padTop = Math.max(fit.pad, (el.h - band - lines * fit.size * LINE_HEIGHT) / 2);
  } else {
    font = fontSizeOf(el);
    padX = 0;
    padTop = 0;
  }
  const finish = (): void => {
    if (ref.current) engine.finishEditing(ref.current.value);
  };

  return (
    <textarea
      ref={ref}
      className={sticky ? 'note-editor sticky' : 'note-editor'}
      data-testid="note-editor"
      aria-label={sticky ? 'Текст стикера' : 'Текст'}
      spellCheck
      style={{
        left: p.x,
        top: p.y,
        width: el.w * z,
        ...(sticky ? { height: el.h * z } : { minHeight: el.h * z }),
        padding: `${padTop * z}px ${padX * z}px 0`,
        fontSize: font * z,
        lineHeight: LINE_HEIGHT,
        fontFamily: NOTE_FONT,
        fontWeight: sticky ? 500 : 400,
        borderRadius: sticky ? Math.min(6, el.w * 0.03) * z : 0,
        transform: angle ? `rotate(${angle}rad)` : undefined,
        transformOrigin: '0 0',
        // Цвета — данные элемента (стикер светлый, текст — цветом элемента или чернил темы).
        background: sticky ? (el.style.color ?? '#ffe58a') : 'transparent',
        color: sticky ? STICKY_INK : (el.style.color ?? 'var(--canvas-ink)'),
      }}
      onInput={(e) => {
        setText(e.currentTarget.value);
        if (!sticky) grow(e.currentTarget);
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          finish();
        }
      }}
    />
  );
}

function grow(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}
