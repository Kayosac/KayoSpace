/// Точка входа для всех платформ. На Android/iOS её вызывает мобильная обёртка.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("не удалось запустить Kayospace");
}
