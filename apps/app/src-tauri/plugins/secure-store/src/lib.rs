//! Секреты устройства (токен хаба) в хранилище ОС — решение 0008.
//!
//! - macOS: Keychain; Windows: Credential Manager — через крейт `keyring` (desktop.rs).
//! - Android: Android Keystore — Kotlin-часть в `android/`, команды уходят туда напрямую.
//!
//! Из JS: `invoke('plugin:secure-store|get', { key })` → `{ value?: string }`,
//! `…|set` с `{ key, value }`, `…|remove` с `{ key }`.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;

#[cfg(target_os = "android")]
const ANDROID_PLUGIN: &str = "app.kayospace.securestore";

/// Ручка Kotlin-части: держим её в состоянии приложения, пока оно работает.
#[cfg(target_os = "android")]
struct AndroidHandle<R: Runtime>(#[allow(dead_code)] tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::<R>::new("secure-store");

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        desktop::get,
        desktop::set,
        desktop::remove
    ]);

    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        use tauri::Manager;
        let handle = api.register_android_plugin(ANDROID_PLUGIN, "SecureStorePlugin")?;
        app.manage(AndroidHandle(handle));
        Ok(())
    });

    builder.build()
}
