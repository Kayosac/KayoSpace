import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Всплывающее окно над кнопкой панели инструментов. Живёт в body: у панели прокрутка
 * и трансформация, внутри неё окно обрезалось бы.
 * Закрывается касанием мимо (касание холста при этом не рисует), Escape и повторным нажатием кнопки.
 */
export function Popover({
  anchor,
  label,
  onClose,
  children,
  testId,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    const place = (): void => {
      const a = anchor.current?.getBoundingClientRect();
      const w = ref.current?.offsetWidth ?? 0;
      if (!a) return;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, a.left + a.width / 2 - w / 2));
      setPos({ left, bottom: window.innerHeight - a.top + 10 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchor.current?.contains(t)) return;
      // Касание холста только закрывает окно — точку на доске оно не ставит.
      if ((t as Element).closest?.('[data-testid="stage"]')) {
        e.stopPropagation();
        e.preventDefault();
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="dialog"
      aria-label={label}
      data-testid={testId}
      style={pos ? { left: pos.left, bottom: pos.bottom } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
