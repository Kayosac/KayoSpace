//! macOS Keychain и Windows Credential Manager. Ключи — строки вида «hub-token».

use serde::Serialize;

/// Имя «сервиса» в хранилище — совпадает с идентификатором приложения.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const SERVICE: &str = "app.kayospace.workspace";

#[derive(Serialize)]
pub struct Value {
    value: Option<String>,
}

fn check_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err("недопустимое имя секрета".into())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn entry(key: &str) -> Result<keyring::Entry, String> {
    check_key(key)?;
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("хранилище ОС: {e}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub async fn get(key: String) -> Result<Value, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Value { value: Some(v) }),
        Err(keyring::Error::NoEntry) => Ok(Value { value: None }),
        Err(e) => Err(format!("хранилище ОС: {e}")),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub async fn set(key: String, value: String) -> Result<(), String> {
    entry(&key)?
        .set_password(&value)
        .map_err(|e| format!("хранилище ОС: {e}"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
pub async fn remove(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("хранилище ОС: {e}")),
    }
}

// Остальные настольные системы (Linux) пока не поддерживаем: приложение под них не собирается.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const UNSUPPORTED: &str = "защищённое хранилище на этой системе не поддерживается";

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
pub async fn get(key: String) -> Result<Value, String> {
    check_key(&key)?;
    Err(UNSUPPORTED.into())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
pub async fn set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;
    let _ = value;
    Err(UNSUPPORTED.into())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
pub async fn remove(key: String) -> Result<(), String> {
    check_key(&key)?;
    Err(UNSUPPORTED.into())
}

#[cfg(test)]
mod tests {
    use super::check_key;

    #[test]
    fn key_names() {
        assert!(check_key("hub-token").is_ok());
        assert!(check_key("").is_err());
        assert!(check_key("../etc").is_err());
        assert!(check_key("Hub").is_err());
        assert!(check_key(&"a".repeat(65)).is_err());
    }
}
