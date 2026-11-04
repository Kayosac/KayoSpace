const COMMANDS: &[&str] = &["get", "set", "remove"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
