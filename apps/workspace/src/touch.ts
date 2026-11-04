/**
 * Основное устройство ввода — мышь или тачпад (не палец и не перо).
 * На сенсорном экране не ставим фокус в поля сами (вылезает клавиатура)
 * и не показываем подсказки про сочетания клавиш.
 */
export function finePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
}

/**
 * Канва низкой задержки: перо отзывчивее, но на Windows при сдвиге холста бывают разрывы
 * картинки. Само — только на Android, где без неё перо заметно отстаёт.
 */
export function lowLatencyInk(setting: boolean | null): boolean {
  return setting ?? (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent));
}

/**
 * Касание холста убирает фокус из полей панелей: холст отменяет действие браузера
 * по умолчанию, и без этого поле осталось бы в фокусе — с открытой клавиатурой
 * и несохранённым текстом.
 */
export function releaseFieldFocus(): void {
  const el = document.activeElement;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    el.blur();
  }
}
