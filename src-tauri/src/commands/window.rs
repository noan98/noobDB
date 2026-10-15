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

/// Unicode の書式文字 (Cf)。表示順を反転する U+202E (RLO) や不可視のゼロ幅文字などで、本番 / サンドボックス
/// の表示を偽装できないよう取り除く。外部クレートを増やさず、Cf の範囲を直接並べている。
fn is_format_char(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}

/// タイトル文字列を整える。制御文字 (改行・タブなど) は空白にし、書式文字 (Cf) は除き、前後の空白を除いて
/// 長さを `MAX_TITLE_CHARS` に切り詰める。空になったら既定のタイトルにする。
pub(crate) fn sanitize_window_title(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !is_format_char(*c))
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
    fn removes_unicode_format_characters() {
        // RLO / LRI / ゼロ幅スペース / BOM は表示の偽装に使えるので除く。
        assert_eq!(
            sanitize_window_title("a\u{202E}b\u{2066}c\u{200B}d\u{FEFF}"),
            "abcd"
        );
        assert_eq!(sanitize_window_title("\u{202E}\u{200B}"), "noobDB");
        // 通常の日本語・絵文字は残す。
        assert_eq!(sanitize_window_title("本番 ✓"), "本番 ✓");
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
