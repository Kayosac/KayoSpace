import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { androidUpdateFrom, isNewer } from './updates';

describe('версии', () => {
  it('сравнение по числам, а не по строкам', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('v1.2.10', '1.2.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.9', '0.10.0')).toBe(false);
  });

  it('APK из релиза — только если версия новее', () => {
    const release = {
      tag_name: 'v0.11.0',
      body: ' Что нового ',
      assets: [
        { name: 'Kayospace_0.11.0_x64-setup.exe', browser_download_url: 'https://x/exe' },
        { name: 'kayospace-v0.11.0-android-arm64.apk', browser_download_url: 'https://x/apk' },
      ],
    };
    expect(androidUpdateFrom(release, '0.10.0')).toEqual({
      version: '0.11.0',
      url: 'https://x/apk',
      notes: 'Что нового',
    });
    expect(androidUpdateFrom(release, '0.11.0')).toBeNull();
    expect(androidUpdateFrom({ ...release, assets: [] }, '0.10.0')).toBeNull();
  });

  it('у приложения одна версия: веб-часть, оболочка, Tauri и Rust', () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const web = JSON.parse(read('../package.json')).version as string;
    expect(JSON.parse(read('../../app/package.json')).version).toBe(web);
    expect(JSON.parse(read('../../app/src-tauri/tauri.conf.json')).version).toBe(web);
    expect(read('../../app/src-tauri/Cargo.toml')).toContain(`version = "${web}"`);
  });
});
