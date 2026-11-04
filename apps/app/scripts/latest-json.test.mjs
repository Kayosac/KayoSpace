import { describe, expect, it } from 'vitest';
import { latestJson } from './latest-json.mjs';

describe('latest.json для автообновления', () => {
  const files = [
    'dist/macos/Kayospace.app.tar.gz',
    'dist/macos/Kayospace.app.tar.gz.sig',
    'dist/dmg/Kayospace_0.10.0_universal.dmg',
    'dist/nsis/Kayospace_0.10.0_x64-setup.exe',
    'dist/nsis/Kayospace_0.10.0_x64-setup.exe.sig',
    'dist/msi/Kayospace_0.10.0_x64_en-US.msi',
    'dist/kayospace-v0.10.0-android-arm64.apk',
  ];
  it('macOS (обе архитектуры) и Windows, подписи из .sig', () => {
    const j = latestJson(files, 'v0.10.0', 'Kayosac/KayoSpace', (p) => `sig:${p}\n`);
    expect(j.version).toBe('0.10.0');
    expect(Object.keys(j.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'windows-x86_64',
    ]);
    expect(j.platforms['windows-x86_64']).toEqual({
      signature: 'sig:dist/nsis/Kayospace_0.10.0_x64-setup.exe.sig',
      url: 'https://github.com/Kayosac/KayoSpace/releases/download/v0.10.0/Kayospace_0.10.0_x64-setup.exe',
    });
    expect(j.platforms['darwin-aarch64'].url).toMatch(/\/v0\.10\.0\/Kayospace\.app\.tar\.gz$/);
  });

  it('без подписей — ошибка, а не пустой список', () => {
    expect(() => latestJson(['a/Kayospace.app.tar.gz'], 'v1.0.0', 'o/r')).toThrow();
  });
});
