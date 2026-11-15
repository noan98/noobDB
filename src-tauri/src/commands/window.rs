//! ウィンドウ自体を操作する IPC コマンド。
//!
//! フロントが `core:window:allow-set-title` のような capability を増やさずに済むよう、
//! タイトルの更新は Rust コマンド経由にする (capabilities を最小に保つ方針)。

use serde::Deserialize;
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

/// ウィンドウ背景の素材 (#2359)。外観設定の「ウィンドウ素材」と 1 対 1 に対応する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowMaterial {
    /// 素材なし (既定)。効果を解除して不透明な表示に戻す。
    None,
    /// Windows 11 の Mica。
    Mica,
    /// Windows 11 の Mica Alt (Tabbed)。
    MicaAlt,
}

/// 実行中の OS ビルド番号が Mica の対象 (Windows 11) かを判定する純関数。
#[cfg(any(target_os = "windows", test))]
fn build_supports_mica(build: u32) -> bool {
    // 22000 は Windows 11 21H2 の最初のビルド。
    build >= 22000
}

/// 実行中の OS が Windows 11 以降か。Windows 以外では常に false。
#[cfg(target_os = "windows")]
fn is_windows_11() -> bool {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    // SAFETY: ゼロ初期化した OSVERSIONINFOW に正しいサイズを書いて渡す。RtlGetVersion は
    // マニフェストに左右されずに実バージョンを返し、構造体の外へは書き込まない。
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    let status = unsafe { RtlGetVersion(&mut info) };
    status >= 0 && build_supports_mica(info.dwBuildNumber)
}

#[cfg(not(target_os = "windows"))]
fn is_windows_11() -> bool {
    false
}

/// ウィンドウ素材 (Mica) を使える環境か (#2359)。Windows 11 だけ true。設定画面が、使えない
/// 環境で項目を無効にして理由を出すために問い合わせる。
#[tauri::command]
pub fn window_material_supported() -> bool {
    is_windows_11()
}

/// ウィンドウ背景の素材を適用 / 解除する (#2359)。`dark` はアプリの実効テーマが暗いか
/// (素材の明暗を OS 設定ではなくアプリのテーマに合わせるため)。効果が実際に敷かれたら true。
/// Windows 11 以外や OS が拒否した場合はエラーにせず false を返し、フロントは「なし」と
/// 同じ表示に戻す。`material = none` は解除で、常に false。
#[tauri::command]
pub fn set_window_material(
    window: WebviewWindow,
    material: WindowMaterial,
    dark: bool,
) -> Result<bool> {
    apply_material(&window, material, dark)
}

#[cfg(target_os = "windows")]
fn apply_material(window: &WebviewWindow, material: WindowMaterial, dark: bool) -> Result<bool> {
    use tauri::window::{Effect, EffectsBuilder};

    if material == WindowMaterial::None {
        // 解除に失敗しても (非対応 OS など) 見た目は不透明のままなので無視してよい。
        let _ = window.set_effects(None);
        return Ok(false);
    }
    if !is_windows_11() {
        return Ok(false);
    }
    let effect = match (material, dark) {
        (WindowMaterial::MicaAlt, true) => Effect::TabbedDark,
        (WindowMaterial::MicaAlt, false) => Effect::TabbedLight,
        (_, true) => Effect::MicaDark,
        (_, false) => Effect::MicaLight,
    };
    // 古い 21H2 は Mica Alt (Tabbed) を持たず OS 側がエラーを返す。その場合も「適用されなかった」
    // として false を返す。
    Ok(window
        .set_effects(EffectsBuilder::new().effect(effect).build())
        .is_ok())
}

#[cfg(not(target_os = "windows"))]
fn apply_material(_window: &WebviewWindow, _material: WindowMaterial, _dark: bool) -> Result<bool> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mica_needs_windows_11_build() {
        assert!(!build_supports_mica(19045)); // Windows 10 22H2
        assert!(build_supports_mica(22000)); // Windows 11 21H2
        assert!(build_supports_mica(26100));
    }

    #[test]
    fn window_material_deserializes_kebab_case() {
        let m: WindowMaterial = serde_json::from_str("\"mica-alt\"").unwrap();
        assert_eq!(m, WindowMaterial::MicaAlt);
        assert!(serde_json::from_str::<WindowMaterial>("\"acrylic\"").is_err());
    }

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
