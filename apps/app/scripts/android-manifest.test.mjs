import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insertBlock, patchManifest, shareFilters } from './android-manifest.mjs';

const dir = join(import.meta.dirname, '..', 'src-tauri');
const buildRs = readFileSync(join(dir, 'plugins', 'share-target', 'build.rs'), 'utf8');
const conf = JSON.parse(readFileSync(join(dir, 'tauri.conf.json'), 'utf8'));

// Укороченный шаблон Tauri (tauri-cli templates/mobile/android/app/src/main/AndroidManifest.xml).
const TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Kayospace">
        <activity
            android:launchMode="singleTask"
            android:name=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

describe('фильтры активности Android', () => {
  it('«Поделиться» (текст, картинка, несколько картинок) и kayospace:// — внутри активности', () => {
    const out = patchManifest(TEMPLATE, { buildRs, conf });
    const activity = out.slice(out.indexOf('<activity'), out.indexOf('</activity>'));
    expect(activity).toContain('android.intent.action.SEND"');
    expect(activity).toContain('android.intent.action.SEND_MULTIPLE');
    expect(activity).toContain('android:mimeType="text/plain"');
    expect(activity).toContain('android:mimeType="image/*"');
    expect(activity).toContain('android:mimeType="application/pdf"');
    expect(activity).toContain('android:scheme="kayospace"');
    expect(activity).toContain('android.intent.action.MAIN');
    // Микрофон — разрешением приложения, до <application>.
    const head = out.slice(0, out.indexOf('<application'));
    expect(head).toContain('<uses-permission android:name="android.permission.RECORD_AUDIO" />');
  });

  it('второй раз блоки заменяются, а не дублируются (как у build.rs плагинов)', () => {
    const once = patchManifest(TEMPLATE, { buildRs, conf });
    expect(patchManifest(once, { buildRs, conf })).toBe(once);
    expect(once.match(/SHARE TARGET PLUGIN/g)).toHaveLength(2);
    expect(once.match(/RECORD_AUDIO/g)).toHaveLength(1);
    expect(shareFilters(buildRs).match(/<intent-filter>/g)).toHaveLength(6);
  });

  it('без активности — понятная ошибка', () => {
    expect(() => insertBlock('<manifest/>', 'X', '<a/>')).toThrow('</activity>');
  });
});
