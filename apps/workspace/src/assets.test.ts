import { describe, expect, it } from 'vitest';
import { imageFiles, sha256Hex } from './assets';

describe('картинки', () => {
  it('id картинки — SHA-256 содержимого', async () => {
    const id = await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    expect(id).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('из списка файлов берутся только растровые картинки', () => {
    const files = [
      new File(['x'], 'a.png', { type: 'image/png' }),
      new File(['x'], 'b.txt', { type: 'text/plain' }),
      new File(['x'], 'c.svg', { type: 'image/svg+xml' }),
      new File(['x'], 'd.jpg', { type: 'image/jpeg' }),
    ];
    expect(imageFiles(files as unknown as FileList).map((f) => f.name)).toEqual(['a.png', 'd.jpg']);
    expect(imageFiles(null)).toEqual([]);
  });
});
