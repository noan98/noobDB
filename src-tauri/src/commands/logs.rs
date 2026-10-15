use crate::error::Result;
use crate::logs;

/// Application log contents plus the on-disk path, for the Settings log viewer.
#[derive(serde::Serialize)]
pub struct LogView {
    pub text: String,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn read_logs() -> LogView {
    LogView {
        text: logs::read(),
        path: logs::path(),
    }
}

#[tauri::command]
pub async fn clear_logs() -> Result<()> {
    logs::clear().map_err(Into::into)
}

/// 設定画面の「パフォーマンス計測」トグルの状態と直近の計測値 (#1622)。
#[derive(serde::Serialize)]
pub struct PerfStatus {
    /// 実際に計測しているか (環境変数 または 設定のトグル)。
    pub enabled: bool,
    /// 設定のトグルの現在値。
    pub ui_enabled: bool,
    /// 環境変数 `NOOBDB_PERF_LOG` で有効化されているか (UI からは止められない)。
    pub env_enabled: bool,
    /// 直近の計測値 (新しい順)。SQL 本文・行データは含まない。
    pub samples: Vec<crate::perf::PerfSample>,
}

fn perf_status() -> PerfStatus {
    PerfStatus {
        enabled: crate::perf::perf_enabled(),
        ui_enabled: crate::perf::ui_enabled(),
        env_enabled: crate::perf::env_enabled(),
        samples: crate::perf::recent_samples(),
    }
}

#[tauri::command]
pub async fn get_perf_status() -> PerfStatus {
    perf_status()
}

#[tauri::command]
pub async fn set_perf_enabled(enabled: bool) -> PerfStatus {
    crate::perf::set_ui_enabled(enabled);
    perf_status()
}

#[tauri::command]
pub async fn clear_perf_samples() {
    crate::perf::clear_samples();
}

/// 匿名化した診断バンドル (プレーンテキスト) を返す (#1622)。保存はフロントが
/// 保存ダイアログ + 既存のテキスト書き出しで行う。
#[tauri::command]
pub async fn build_diagnostic_bundle() -> Result<String> {
    // keyring には書き込まない。接続フォームで診断済みならその結果、未実行なら unchecked。
    let keyring = match crate::profiles::secrets::cached_keyring_status() {
        Some(s) if s.available => "available".to_string(),
        Some(s) => format!("unavailable ({})", s.reason.unwrap_or("other")),
        None => "unchecked".to_string(),
    };
    let meta = crate::diagnostics::BundleMeta::current(&keyring);
    Ok(crate::diagnostics::build_bundle(
        &logs::read(),
        &meta,
        &crate::perf::recent_samples(),
    ))
}
