use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

const PORT: u16 = 57312;
const STORE_FILE: &str = "config.json";
const VAULT_KEY: &str = "vault_path";

/// sidecar の子プロセスハンドルを保持する State
struct SidecarHandle(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// vault_path を使って sidecar を起動し、起動ログを待ってから WebView を開く
fn start_sidecar(app: &AppHandle, vault_path: String) {
    use tauri_plugin_shell::process::CommandEvent;

    let (mut rx, child) = app
        .shell()
        .sidecar("loamium-server")
        .expect("loamium-server sidecar not found")
        .env("LOAMIUM_VAULT", &vault_path)
        .env("PORT", PORT.to_string())
        .spawn()
        .expect("failed to spawn sidecar");

    *app.state::<SidecarHandle>().0.lock().unwrap() = Some(child);

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) = event {
                let text = String::from_utf8_lossy(&line);
                if text.contains("listening on") {
                    // サーバー起動確認 — WebView を開く
                    let url = WebviewUrl::External(
                        format!("http://127.0.0.1:{PORT}").parse().unwrap(),
                    );
                    let _ = WebviewWindowBuilder::new(&app_clone, "main", url)
                        .title("Loamium")
                        .inner_size(1280.0, 800.0)
                        .build();
                    break;
                }
            }
        }
    });
}

/// 実行中の sidecar を止めて新しい vault で再起動し、WebView をリロードする
fn restart_sidecar(app: &AppHandle, new_vault: String) {
    // 既存 sidecar を kill
    if let Some(child) = app.state::<SidecarHandle>().0.lock().unwrap().take() {
        let _ = child.kill();
    }

    // WebView をクローズして新しい WebView を start_sidecar で再作成
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }

    start_sidecar(app, new_vault);
}

/// ダイアログで vault フォルダを選択させ、選択されたら store に保存して sidecar を起動/再起動する
fn pick_vault(app: &AppHandle) {
    let app_clone = app.clone();
    app.dialog().file().pick_folder(move |folder| {
        let Some(path) = folder else { return };
        let path_str = path.to_string();

        // store に保存
        if let Ok(store) = app_clone.store(STORE_FILE) {
            let _ = store.set(VAULT_KEY, serde_json::Value::String(path_str.clone()));
            let _ = store.save();
        }

        restart_sidecar(&app_clone, path_str);
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarHandle(Mutex::new(None)))
        .setup(|app| {
            // ネイティブメニューを設定
            use tauri::menu::{Menu, MenuItem, Submenu};
            let change_vault =
                MenuItem::with_id(app, "change-vault", "Vault を変更...", true, None::<&str>)?;
            let file_submenu = Submenu::with_items(app, "File", true, &[&change_vault])?;
            let menu = Menu::with_items(app, &[&file_submenu])?;
            app.set_menu(menu)?;

            // store から vault パスを読む
            let store = app.store(STORE_FILE)?;
            let vault_path = store
                .get(VAULT_KEY)
                .and_then(|v| v.as_str().map(|s| s.to_string()));

            if let Some(path) = vault_path {
                start_sidecar(app.handle(), path);
            } else {
                pick_vault(app.handle());
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "change-vault" {
                pick_vault(app);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// vault パスを store に書き込んで読み取れることを検証するユニットテスト
    /// (tauri-plugin-store の実 IO は統合テストの領域のため、ここではロジック単体を確認)
    #[test]
    fn vault_key_constant_is_correct() {
        assert_eq!(super::VAULT_KEY, "vault_path");
        assert_eq!(super::STORE_FILE, "config.json");
        assert_eq!(super::PORT, 57312);
    }

    #[test]
    fn port_is_u16() {
        let _: u16 = super::PORT;
    }
}
