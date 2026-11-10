import { useEffect, useRef, useState } from 'react';
import { cellImageHeight, type CellImage } from '@kayospace/page';
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

/** Картинки ячейки в ряд — в высоту строки (решение 0024); касание — открыть крупно. */
export function CellImages({
  images,
  rowHeight,
  onOpen,
}: {
  images: readonly CellImage[];
  rowHeight: number | undefined;
  onOpen: (index: number) => void;
}) {
  const h = cellImageHeight(rowHeight);
  return (
    <span className="kt-imgs">
      {images.map((img, i) => (
        <CellThumb
          key={`${img.asset}-${i}`}
          img={img}
          h={h}
          label={img.alt || `Картинка ${i + 1}`}
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
  return (
    <button
      className="kt-img"
      style={{ width: w, height: h }}
      aria-label={label}
      title={label}
      onClick={onOpen}
      data-testid="cell-image"
    >
      {url ? <img src={url} alt={label} draggable={false} /> : <span className="kt-img-wait" />}
    </button>
  );
}

/** Картинка крупно: убрать из ячейки, переставить, закрыть — касаниями. */
export function CellImageViewer({
  images,
  index,
  onIndex,
  onRemove,
  onClose,
}: {
  images: readonly CellImage[];
  index: number;
  onIndex: (i: number) => void;
  onRemove: (i: number) => void;
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
      {img.alt && <div className="kt-viewer-alt muted">{img.alt}</div>}
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
