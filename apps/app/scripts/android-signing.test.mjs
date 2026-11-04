import { describe, expect, it } from 'vitest';
import { keystoreProperties, patchGradle } from './android-signing.mjs';

// Укороченный шаблон Tauri (tauri-cli templates/mobile/android/app/build.gradle.kts).
const TEMPLATE = `import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

android {
    compileSdk = 37
    buildTypes {
        getByName("debug") {
            isDebuggable = true
        }
        getByName("release") {
            optimization {
               enable = true
            }
        }
    }
}
`;

describe('подпись APK', () => {
  it('signingConfigs в android { }, подпись — у release, не у debug; второй раз не дублирует', () => {
    const out = patchGradle(TEMPLATE);
    expect(out.indexOf('signingConfigs {')).toBeGreaterThan(out.indexOf('android {'));
    expect(out.indexOf('signingConfigs {')).toBeLessThan(out.indexOf('buildTypes {'));
    const release = out.slice(out.indexOf('getByName("release") {'));
    expect(release).toMatch(/^getByName\("release"\) \{\n\s+signingConfig = signingConfigs/);
    const debug = out.slice(
      out.indexOf('getByName("debug")'),
      out.indexOf('getByName("release") {'),
    );
    expect(debug).not.toContain('signingConfig');
    expect(patchGradle(out)).toBe(out);
  });

  it('незнакомый шаблон — ошибка, а не тихо неподписанный APK', () => {
    expect(() => patchGradle('plugins {}\n')).toThrow();
  });

  it('свойства ключа экранированы', () => {
    expect(keystoreProperties('/tmp/k.jks', 'pa\\ss')).toBe(
      'storeFile=/tmp/k.jks\npassword=pa\\\\ss\nkeyAlias=kayospace\n',
    );
  });
});
