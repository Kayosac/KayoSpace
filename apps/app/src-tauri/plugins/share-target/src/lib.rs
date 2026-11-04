//! «Поделиться» → Kayospace на Android (решение 0010).
//!
//! Активность приложения принимает ACTION_SEND / ACTION_SEND_MULTIPLE (фильтры дописывает build.rs).
//! Kotlin-часть (`android/`) читает присланное и отдаёт его в JS: команда `take` забирает то,
//! с чем приложение запустили, событие `shared` приходит, когда приложение уже открыто.
//!
//! Из JS: `invoke('plugin:share-target|take')` → `{ text?, subject?, files: [{ name, mime, data }] }`
//! (data — base64). На компьютере — всегда пусто.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const ANDROID_PLUGIN: &str = "app.kayospace.share";

#[cfg(target_os = "android")]
struct AndroidHandle<R: Runtime>(#[allow(dead_code)] tauri::plugin::PluginHandle<R>);

/// На компьютере делиться в приложение нечем.
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn take() -> serde_json::Value {
    serde_json::json!({ "files": [] })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::<R>::new("share-target");

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![take]);

    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        use tauri::Manager;
        let handle = api.register_android_plugin(ANDROID_PLUGIN, "SharePlugin")?;
        app.manage(AndroidHandle(handle));
        Ok(())
    });

    builder.build()
}
