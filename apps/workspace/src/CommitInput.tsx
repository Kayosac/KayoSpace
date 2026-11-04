import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & {
  value: string;
  onCommit: (value: string) => void;
};

/**
 * Поле, которое сохраняет само: при уходе фокуса, по «Готово»/Enter и при закрытии панели.
 * На сенсорном устройстве клавиши Enter может не быть, а системное «назад» прячет клавиатуру
 * без потери фокуса — поэтому сохранение не должно зависеть ни от одной клавиши.
 * Escape возвращает прежнее значение.
 */
export function CommitInput({ value, onCommit, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const latest = useRef({ draft, value, onCommit });
  latest.current = { draft, value, onCommit };

  // Значение поменялось снаружи (другое устройство, переименование) — пока поле не в работе.
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  // Панель закрылась с несохранённым текстом — сохраняем.
  useEffect(
    () => () => {
      const { draft: d, value: v, onCommit: commit } = latest.current;
      if (d !== v) commit(d);
    },
    [],
  );

  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      enterKeyHint="done"
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          latest.current.draft = value;
          // Значение вернули — blur ничего не сохранит.
          const input = e.currentTarget;
          requestAnimationFrame(() => input.blur());
        }
      }}
    />
  );
}
