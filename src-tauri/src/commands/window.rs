//! ウィンドウ自体を操作する IPC コマンド。
//!
//! フロントが `core:window:allow-set-title` のような capability を増やさずに済むよう、
//! タイトルの更新は Rust コマンド経由にする (capabilities を最小に保つ方針)。

use tauri::WebviewWindow;

use crate::error::{AppError, Result};

/// タイトルとして渡せる最大の文字数。OS のタスクバーや Alt+Tab で切れるのは OS 側に任せつつ、
/// 異常に長い文字列がウィンドウ API に渡らないようにする。
const MAX_TITLE_CHARS: usize = 200;

/// タイトルが空になったときの既定。
const DEFAULT_TITLE: &str = "noobDB";

/// タイトル文字列を整える。制御文字 (改行・タブなど) は空白にし、前後の空白を除いて
/// 長さを `MAX_TITLE_CHARS` に切り詰める。空になったら既定のタイトルにする。
pub(crate) fn sanitize_window_title(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return DEFAULT_TITLE.to_string();
    }
    trimmed.chars().take(MAX_TITLE_CHARS).collect()
}

/// ウィンドウタイトルを設定する (#1631)。接続名と本番 / サンドボックスの区別を載せ、OS の
/// タスクバーや Alt+Tab で本番接続を判別できるようにするためにフロントが呼ぶ。
#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) -> Result<()> {
    window
        .set_title(&sanitize_window_title(&title))
        .map_err(|e| AppError::Other(format!("failed to set the window title: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_normal_title() {
        assert_eq!(
            sanitize_window_title("[PROD] main-db — noobDB"),
            "[PROD] main-db — noobDB"
        );
    }

    #[test]
    fn replaces_control_characters_and_trims() {
        assert_eq!(sanitize_window_title("  a\nb\tc  "), "a b c");
    }

    #[test]
    fn falls_back_to_default_when_empty() {
        assert_eq!(sanitize_window_title(""), "noobDB");
        assert_eq!(sanitize_window_title(" \n\t "), "noobDB");
    }

    #[test]
    fn truncates_by_characters_not_bytes() {
        let long = "あ".repeat(500);
        let out = sanitize_window_title(&long);
        assert_eq!(out.chars().count(), MAX_TITLE_CHARS);
    }
}
