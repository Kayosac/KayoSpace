const COMMANDS: &[&str] = &["take"];

/// Kayospace в списке «Поделиться» Android: текст и ссылки, одна или несколько картинок, PDF.
const INTENT_FILTERS: &str = r#"<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="text/plain" />
</intent-filter>
<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/*" />
</intent-filter>
<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="application/pdf" />
</intent-filter>
<intent-filter>
    <action android:name="android.intent.action.SEND_MULTIPLE" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/*" />
</intent-filter>"#;

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
    // Фильтры — в активность приложения (сгенерированный AndroidManifest.xml); вне сборки
    // под Android функция ничего не делает.
    println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
    tauri_plugin::mobile::update_android_manifest("SHARE TARGET PLUGIN", "activity", INTENT_FILTERS.to_string())
        .expect("не удалось дописать AndroidManifest.xml");
}
