import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { hexToHsv, hsvToHex, wheelPick, wheelPoint, type Hsv } from './colors';
import { CommitInput } from './CommitInput';

export interface Swatch {
  /** null — цвет чернил темы. */
  value: string | null;
  name: string;
}

const WHEEL = 196;

/** С чего начинает круг: у «чернил» и почти чёрных цветов круг был бы чёрным — показываем яркий. */
function startHsv(value: string | null, pastel: boolean): Hsv {
  const c = value ? hexToHsv(value) : null;
  if (!c) return { h: 0, s: 0, v: 1 };
  return pastel || c.v < 0.25 ? { ...c, v: 1 } : c;
}

/**
 * Палитра: заготовки, недавние свои цвета, круг (тон и насыщенность) и яркость.
 * pastel — для стикеров: на светлом фоне текст тёмный, поэтому только светлые цвета
 * (яркость 100%, насыщенность до 60%).
 */
export function ColorPicker({
  value,
  presets,
  recent,
  pastel = false,
  transparentNull = false,
  nullColor = 'var(--canvas-ink)',
  onPick,
}: {
  value: string | null;
  presets: Swatch[];
  recent: string[];
  pastel?: boolean;
  /** null — «Прозрачный» (заливка фигур, решение 0022), а не цвет чернил. */
  transparentNull?: boolean;
  /** Чем показать null, если он не «Прозрачный»: по умолчанию — чернила темы. */
  nullColor?: string;
  /** custom — свой цвет из круга или поля (попадает в недавние); close — выбор окончен. */
  onPick: (color: string | null, opts: { custom: boolean; close: boolean }) => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => startHsv(value, pastel));
  const [dragging, setDragging] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);
  const maxS = pastel ? 0.6 : 1;

  // Выбор снаружи (заготовка, другое устройство) — круг показывает его, если его сейчас не тянут.
  useEffect(() => {
    if (dragging) return;
    setHsv(startHsv(value, pastel));
  }, [value, pastel, dragging]);

  // Круг перерисовываем только при смене яркости.
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const n = Math.round(WHEEL * dpr);
    c.width = n;
    c.height = n;
    const img = ctx.createImageData(n, n);
    const r = n / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5 - r) / r;
        const dy = (y + 0.5 - r) / r;
        const d = Math.hypot(dx, dy);
        if (d > 1.01) continue;
        const { h, s } = wheelPick(dx, dy);
        const hex = hsvToHex({ h, s: s * maxS, v: hsv.v });
        const i = (y * n + x) * 4;
        const num = Number.parseInt(hex.slice(1), 16);
        img.data[i] = (num >> 16) & 255;
        img.data[i + 1] = (num >> 8) & 255;
        img.data[i + 2] = num & 255;
        // Мягкий край круга.
        img.data[i + 3] = d > 1 ? Math.round((1.01 - d) * 100 * 255) : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [hsv.v, maxS]);

  const fromPointer = (e: RPointerEvent<HTMLCanvasElement>): Hsv => {
    const b = e.currentTarget.getBoundingClientRect();
    const { h, s } = wheelPick(
      ((e.clientX - b.left) / b.width) * 2 - 1,
      ((e.clientY - b.top) / b.height) * 2 - 1,
    );
    return { h, s: s * maxS, v: hsv.v };
  };

  const current = hsvToHex(hsv);
  const dot = wheelPoint(hsv.h, Math.min(1, hsv.s / maxS));

  return (
    <div className="color-picker" data-testid="color-picker">
      <div className="swatches" role="radiogroup" aria-label="Заготовки">
        {presets.map(({ value: v, name }) => (
          <button
            key={name}
            className="swatch"
            role="radio"
            aria-checked={value === v}
            aria-label={name}
            title={name}
            onClick={() => onPick(v, { custom: false, close: true })}
          >
            <span
              className={v === null && transparentNull ? 'transparent' : undefined}
              style={v === null && transparentNull ? undefined : { background: v ?? nullColor }}
            />
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="swatches recent" role="radiogroup" aria-label="Недавние">
          {recent.map((c) => (
            <button
              key={c}
              className="swatch small"
              role="radio"
              aria-checked={value?.toLowerCase() === c}
              aria-label={`Недавний ${c}`}
              title={c}
              onClick={() => onPick(c, { custom: false, close: true })}
            >
              <span style={{ background: c }} />
            </button>
          ))}
        </div>
      )}
      <div className="wheel" style={{ width: WHEEL, height: WHEEL }}>
        <canvas
          ref={canvas}
          aria-label="Круг цветов"
          data-testid="color-wheel"
          style={{ width: WHEEL, height: WHEEL }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            setHsv(fromPointer(e));
          }}
          onPointerMove={(e) => {
            if (dragging) setHsv(fromPointer(e));
          }}
          onPointerUp={(e) => {
            if (!dragging) return;
            setDragging(false);
            const picked = fromPointer(e);
            setHsv(picked);
            onPick(hsvToHex(picked), { custom: true, close: false });
          }}
          onPointerCancel={() => setDragging(false)}
        />
        <i
          className="wheel-dot"
          style={{
            left: (dot.x + 1) * (WHEEL / 2),
            top: (dot.y + 1) * (WHEEL / 2),
            background: current,
          }}
        />
      </div>
      {!pastel && (
        <label className="slider-row">
          <span>Яркость</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(hsv.v * 100)}
            aria-label="Яркость"
            data-testid="color-value"
            style={{
              background: `linear-gradient(to right, #000, ${hsvToHex({ ...hsv, v: 1 })})`,
            }}
            onChange={(e) => {
              const next = { ...hsv, v: Number(e.target.value) / 100 };
              setHsv(next);
              // Применяем, когда ползунок остановился: перекраска выделенного — одним шагом отмены.
              clearTimeout(settle.current);
              settle.current = setTimeout(
                () => onPick(hsvToHex(next), { custom: true, close: false }),
                250,
              );
            }}
          />
        </label>
      )}
      <div className="hex-row">
        <span className="hex-preview" style={{ background: current }} />
        <CommitInput
          className="hex-input"
          value={current}
          aria-label="Код цвета"
          data-testid="color-hex"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={7}
          onCommit={(v) => {
            const c = hexToHsv(v.startsWith('#') ? v : `#${v}`);
            if (!c) return;
            setHsv(c);
            onPick(hsvToHex(c), { custom: true, close: false });
          }}
        />
      </div>
    </div>
  );
}
