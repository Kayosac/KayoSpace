import { useCallback, useEffect, useRef, useState } from 'react';
import { presentationSlides, type CanvasEngine } from '@kayospace/canvas';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from './icons';

/**
 * Презентация по фреймам (решение 0017): каждый фрейм — слайд во весь экран, в порядке чтения
 * (как страницы PDF). Листать — касанием справа/слева, свайпом, стрелками, пробелом; выйти —
 * крестиком или Esc. Доску в это время не тронуть: слой презентации забирает ввод себе.
 */
export function Presentation({ engine, onClose }: { engine: CanvasEngine; onClose: () => void }) {
  const [slides] = useState(() => presentationSlides(engine.getFrames()));
  const [index, setIndex] = useState(0);
  const saved = useRef(engine.getCamera());
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);

  const go = useCallback(
    (i: number) => setIndex(Math.max(0, Math.min(slides.length - 1, i))),
    [slides.length],
  );

  // Показать слайд; при смене размера окна — подогнать заново.
  useEffect(() => {
    const s = slides[index];
    if (!s) return;
    const show = (): void => engine.presentBounds(s.bounds);
    show();
    const onResize = (): void => void requestAnimationFrame(show);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [engine, slides, index]);

  // На время показа — без выделения и редактирования; после — вид, какой был.
  useEffect(() => {
    engine.finishEditing(null);
    engine.clearSelection();
    const camera = saved.current;
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      engine.setCamera(camera);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [engine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) {
        e.preventDefault();
        go(index + 1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(slides.length - 1);
      else if (e.key === 'Escape') onClose();
      // Остальные клавиши доске не достаются: во время показа её не правят.
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, index, onClose, slides.length]);

  const slide = slides[index];
  if (!slide) return null;
  return (
    <div className="present" data-testid="presentation">
      <div
        className="present-touch"
        data-testid="present-surface"
        onPointerDown={(e) => {
          swipe.current = { x: e.clientX, y: e.clientY, t: performance.now() };
        }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            go(index + (dx < 0 ? 1 : -1)); // свайп влево — следующий
          } else if (Math.hypot(dx, dy) < 12) {
            // Касание: левая треть — назад, остальное — вперёд.
            const r = e.currentTarget.getBoundingClientRect();
            go(index + (e.clientX - r.left < r.width / 3 ? -1 : 1));
          }
        }}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > 30) go(index + (e.deltaY > 0 ? 1 : -1));
        }}
      />
      <div className="present-bar" role="toolbar" aria-label="Презентация">
        <button
          className="icon-btn"
          aria-label="Назад"
          disabled={index === 0}
          onClick={() => go(index - 1)}
        >
          <ChevronLeftIcon />
        </button>
        <span className="present-title" data-testid="present-title">
          <b>
            {index + 1} / {slides.length}
          </b>{' '}
          {slide.name}
        </span>
        <button
          className="icon-btn"
          aria-label="Вперёд"
          disabled={index === slides.length - 1}
          onClick={() => go(index + 1)}
        >
          <ChevronRightIcon />
        </button>
        <button className="icon-btn" aria-label="Выйти из презентации" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
