import { sizeToSlider, sliderToSize } from './colors';

export interface SizePreset {
  value: number;
  name: string;
}

/** Толщина: ползунок с логарифмической шкалой, кружок в настоящую величину и три заготовки. */
export function SizePicker({
  value,
  min,
  max,
  presets,
  label,
  color,
  hollow = false,
  onChange,
  onPreset,
}: {
  value: number;
  min: number;
  max: number;
  presets: SizePreset[];
  label: string;
  /** Цвет кружка (для пера — текущий цвет). */
  color: string;
  /** Ластик — кольцо вместо круга. */
  hollow?: boolean;
  onChange: (size: number) => void;
  onPreset: (size: number) => void;
}) {
  const shown = Math.min(56, Math.max(2, value));
  return (
    <div className="size-picker" data-testid="size-picker">
      <div className="size-preview">
        <span
          style={{
            width: shown,
            height: shown,
            ...(hollow
              ? { border: '1.5px solid var(--text)', background: 'none' }
              : { background: color }),
          }}
        />
      </div>
      <label className="slider-row">
        <span>
          {label} <b data-testid="size-value">{formatSize(value)}</b>
        </span>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(sizeToSlider(value, min, max) * 1000)}
          aria-label={label}
          data-testid="size-slider"
          onChange={(e) => onChange(sliderToSize(Number(e.target.value) / 1000, min, max))}
        />
      </label>
      <div className="size-presets" role="radiogroup" aria-label="Заготовки">
        {presets.map((p) => (
          <button
            key={p.name}
            className="secondary"
            role="radio"
            aria-checked={value === p.value}
            aria-label={p.name}
            onClick={() => onPreset(p.value)}
          >
            {formatSize(p.value)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function formatSize(v: number): string {
  return `${String(v).replace('.', ',')} px`;
}
