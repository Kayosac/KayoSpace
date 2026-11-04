import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { STICKY_FONT_SIZE, fontSizeOf } from '@kayospace/board';
import {
  LINE_HEIGHT,
  NOTE_FONT,
  STICKY_INK,
  worldToScreen,
  type CanvasEngine,
  type EngineState,
} from '@kayospace/canvas';

/**
 * Поле ввода поверх стикера или текста. Шрифт, отступы и перенос — как на холсте,
 * поэтому после правки текст остаётся на том же месте.
 */
export function NoteEditor({ engine, state }: { engine: CanvasEngine; state: EngineState }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.onCamera(bump), [engine]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const el = state.editing ? engine.getEditingElement() : null;
  const content = el && (el.type === 'sticky' || el.type === 'text') ? el.props.content : '';

  // Новая правка: текст, фокус, курсор в конец; холст читает набранное отсюда.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!state.editing || !ta) return;
    ta.value = content;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    grow(ta);
    engine.setEditTextSource(() => ta.value);
    return () => engine.setEditTextSource(null);
    // content читаем только в момент начала правки — он не в зависимостях.
  }, [engine, state.editing]);

  if (!el || (el.type !== 'sticky' && el.type !== 'text')) return null;
  const cam = engine.getCamera();
  const p = worldToScreen(cam, el.x, el.y);
  const sticky = el.type === 'sticky';
  const font = fontSizeOf(el) * cam.zoom;
  const pad = sticky ? font * (16 / STICKY_FONT_SIZE) : 0;
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
        width: el.w * cam.zoom,
        minHeight: el.h * cam.zoom,
        padding: pad,
        fontSize: font,
        lineHeight: LINE_HEIGHT,
        fontFamily: NOTE_FONT,
        fontWeight: sticky ? 500 : 400,
        borderRadius: sticky ? 6 * cam.zoom : 0,
        // Цвета — данные элемента (стикер светлый, текст — цветом элемента или чернил темы).
        background: sticky ? (el.style.color ?? '#ffe58a') : 'transparent',
        color: sticky ? STICKY_INK : (el.style.color ?? 'var(--canvas-ink)'),
      }}
      onInput={(e) => grow(e.currentTarget)}
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
