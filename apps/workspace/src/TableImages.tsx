import { useEffect, useRef, useState } from 'react';
import { imageDisplayHeight, type CellImage } from '@kayospace/page';
import { CommitInput } from './CommitInput';
import { assetUrl, assets, imageFiles } from './assets';

/** Картинка из хранилища по id файла (с устройства или с хаба). */
function useAssetUrl(assetId: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void assetUrl(assetId).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [assetId]);
  return url;
}

/**
 * Картинки ячейки (решения 0024, 0026): каждая — плитка «картинка + подпись под ней»; своего размера
 * или в высоту строки. Плитки, которые не влезли в ширину, переносятся целиком; строка растёт сама.
 * Касание — открыть крупно.
 */
export function CellImages({
  images,
  rowHeight,
  onOpen,
}: {
  images: readonly CellImage[];
  rowHeight: number | undefined;
  onOpen: (index: number) => void;
}) {
  return (
    <span className="kt-imgs">
      {images.map((img, i) => (
        <CellThumb
          key={`${img.asset}-${i}`}
          img={img}
          h={imageDisplayHeight(img, rowHeight)}
          label={img.caption || img.alt || `Картинка ${i + 1}`}
          onOpen={() => onOpen(i)}
        />
      ))}
    </span>
  );
}

function CellThumb({
  img,
  h,
  label,
  onOpen,
}: {
  img: CellImage;
  h: number;
  label: string;
  onOpen: () => void;
}) {
  const url = useAssetUrl(img.asset);
  const w = Math.max(8, Math.round((h * img.w) / img.h));
  const pic = url ? (
    <img src={url} alt={label} draggable={false} />
  ) : (
    <span className="kt-img-wait" />
  );
  if (!img.caption)
    return (
      <button
        className="kt-img"
        style={{ width: w, height: h }}
        aria-label={label}
        title={label}
        onClick={onOpen}
        data-testid="cell-image"
      >
        {pic}
      </button>
    );
  return (
    <button
      className="kt-tile"
      style={{ width: Math.max(w, 56) }}
      aria-label={label}
      title={label}
      onClick={onOpen}
      data-testid="cell-image"
    >
      <span className="kt-img" style={{ width: w, height: h }}>
        {pic}
      </span>
      <span className="kt-caption" data-testid="cell-image-caption-text">
        {img.caption}
      </span>
    </button>
  );
}

/** Картинка крупно: убрать из ячейки, переставить, закрыть — касаниями. */
/** Размеры картинки на выбор касанием; агенты могут задать любой (16–512). */
const SIZES: readonly { size: number | null; name: string }[] = [
  { size: null, name: 'По строке' },
  { size: 32, name: '32' },
  { size: 48, name: '48' },
  { size: 64, name: '64' },
  { size: 96, name: '96' },
  { size: 128, name: '128' },
  { size: 200, name: '200' },
];

export function CellImageViewer({
  images,
  index,
  onIndex,
  onRemove,
  onChange,
  onClose,
}: {
  images: readonly CellImage[];
  index: number;
  onIndex: (i: number) => void;
  onRemove: (i: number) => void;
  /** Подпись и размер картинки (решение 0026). */
  onChange: (i: number, patch: { caption?: string; size?: number | null }) => void;
  onClose: () => void;
}) {
  const img = images[index];
  const url = useAssetUrl(img?.asset ?? '');
  if (!img) return null;
  return (
    <div
      className="kt-viewer"
      role="dialog"
      aria-label="Картинка в ячейке"
      data-testid="cell-image-viewer"
    >
      <div className="kt-viewer-bar">
        <button className="page-tool wide" onClick={onClose} data-testid="cell-image-close">
          ← Назад
        </button>
        {images.length > 1 && (
          <>
            <button
              className="page-tool"
              aria-label="Предыдущая"
              disabled={index === 0}
              onClick={() => onIndex(index - 1)}
            >
              ‹
            </button>
            <span className="muted">
              {index + 1} из {images.length}
            </span>
            <button
              className="page-tool"
              aria-label="Следующая"
              disabled={index === images.length - 1}
              onClick={() => onIndex(index + 1)}
            >
              ›
            </button>
          </>
        )}
        <span className="page-tool-gap" />
        <button
          className="page-tool wide danger"
          onClick={() => onRemove(index)}
          data-testid="cell-image-remove"
        >
          Убрать из ячейки
        </button>
      </div>
      <div className="kt-viewer-body">
        {url ? (
          <img src={url} alt={img.alt ?? ''} />
        ) : (
          <span className="muted">Загружаю картинку…</span>
        )}
      </div>
      <div className="kt-viewer-props">
        <label className="kt-viewer-field">
          <span className="muted">Подпись</span>
          <CommitInput
            key={`${img.asset}-${index}`}
            className="kt-viewer-caption"
            value={img.caption ?? ''}
            placeholder="Например: 80 монет / Обычный"
            aria-label="Подпись под картинкой"
            onCommit={(v) => onChange(index, { caption: v })}
            data-testid="cell-image-caption"
          />
        </label>
        <div className="kt-viewer-field">
          <span className="muted">Размер в ячейке</span>
          <div className="row" role="radiogroup" aria-label="Размер в ячейке">
            {SIZES.map((s) => (
              <button
                key={s.name}
                role="radio"
                aria-checked={(img.size ?? null) === s.size}
                className="project-chip"
                onClick={() => onChange(index, { size: s.size })}
                data-testid="cell-image-size"
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
        {img.alt && <div className="kt-viewer-alt muted">{img.alt}</div>}
      </div>
    </div>
  );
}

/** Файлы → картинки ячейки: в хранилище устройства (на хаб уйдут сами). */
export async function storeCellImages(files: readonly File[]): Promise<CellImage[]> {
  const out: CellImage[] = [];
  for (const f of files) {
    const s = await assets.add(f);
    out.push({ asset: s.assetId, w: s.width, h: s.height });
  }
  return out;
}

/** Выбор картинок с устройства для ячейки: камера, галерея, файлы. */
export function useImagePicker(onFiles: (files: File[]) => void): {
  input: React.ReactNode;
  pick: () => void;
} {
  const ref = useRef<HTMLInputElement>(null);
  return {
    pick: () => ref.current?.click(),
    input: (
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="cell-image-input"
        onChange={(e) => {
          const files = imageFiles(e.target.files);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    ),
  };
}
