//! AI の使用量台帳 (#1540)。完了した AI 呼び出しごとに、日 (JST) × タスク種別 × モデルの
//! トークン数を `ai_usage.json` (data_dir) へ積み上げる。
//!
//! - **保存するのは数値だけ**: API キーも送信内容 (プロンプト / 応答 / スキーマ) も一切含めない。
//! - 書き込みは `snippets::store` と同じ規約 (ストア単位の `Mutex` で read-modify-write を直列化し、
//!   一時ファイル + `rename` でアトミックに差し替える)。
//! - 概算コストはここでは持たない。単価はフロント `aiModels.ts` の表で掛ける (単価の変更で
//!   過去の記録を書き換えずに済む)。
//! - 記録は best-effort: 保存に失敗しても AI 呼び出し自体は失敗させず、`warn` ログだけ残す。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use chrono::{DateTime, Duration, FixedOffset, Utc};
use serde::{Deserialize, Serialize};

use super::models::AiTaskKind;
use super::sse::AiUsage;
use crate::error::{AppError, Result};

/// 保持する日数。これより古い日の記録は書き込みのたびに捨てる (ファイルの肥大化防止)。
const RETENTION_DAYS: i64 = 400;
const JST_OFFSET_SECS: i32 = 9 * 60 * 60;

/// 1 日 × 1 タスク種別 × 1 モデルの累計。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageRecord {
    /// JST の `YYYY-MM-DD`。
    pub day: String,
    /// タスク種別 (`AiTaskKind` の camelCase 名。廃止された種別が残っても読めるよう文字列で持つ)。
    pub task: String,
    /// 実際に応答したモデル ID (フォールバック後)。
    pub model: String,
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UsageFile {
    #[serde(default)]
    records: Vec<AiUsageRecord>,
}

static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// JST の日付キー。
pub fn jst_day(now: DateTime<Utc>) -> String {
    // 固定オフセット (+9h) は常に有効なので `None` は起きないが、unwrap を避けて UTC に倒す。
    match FixedOffset::east_opt(JST_OFFSET_SECS) {
        Some(off) => now.with_timezone(&off).format("%Y-%m-%d").to_string(),
        None => now.format("%Y-%m-%d").to_string(),
    }
}

fn task_name(task: AiTaskKind) -> String {
    serde_json::to_value(task)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "generic".to_string())
}

/// 1 件の完了を台帳へ加算する (純関数。保存は呼び出し側)。保持期間外の古い日は同時に捨てる。
pub fn apply(
    records: &mut Vec<AiUsageRecord>,
    now: DateTime<Utc>,
    task: &str,
    model: &str,
    usage: &AiUsage,
) {
    let day = jst_day(now);
    let cutoff = jst_day(now - Duration::days(RETENTION_DAYS));
    records.retain(|r| r.day >= cutoff);
    let idx = records
        .iter()
        .position(|r| r.day == day && r.task == task && r.model == model);
    let rec = match idx {
        Some(i) => &mut records[i],
        None => {
            records.push(AiUsageRecord {
                day,
                task: task.to_string(),
                model: model.to_string(),
                calls: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            });
            let last = records.len() - 1;
            &mut records[last]
        }
    };
    rec.calls = rec.calls.saturating_add(1);
    rec.input_tokens = rec.input_tokens.saturating_add(usage.input_tokens);
    rec.output_tokens = rec.output_tokens.saturating_add(usage.output_tokens);
    rec.cache_read_input_tokens = rec
        .cache_read_input_tokens
        .saturating_add(usage.cache_read_input_tokens);
    rec.cache_creation_input_tokens = rec
        .cache_creation_input_tokens
        .saturating_add(usage.cache_creation_input_tokens);
}

fn usage_path() -> Result<PathBuf> {
    let dir = crate::snippets::store::data_dir().ok_or(AppError::ConfigDir)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("ai_usage.json"))
}

fn load_locked() -> Result<Vec<AiUsageRecord>> {
    read_records(&usage_path()?)
}

fn read_records(path: &Path) -> Result<Vec<AiUsageRecord>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<UsageFile>(&content) {
        Ok(file) => Ok(file.records),
        Err(e) => {
            // 壊れた台帳は読めないままだと記録も表示も恒久的に失敗するので、`.bak` へ退避して
            // 空から始める (使用量は集計値で、失っても機能・安全性に影響しない)。
            tracing::warn!(error = %e, "ai_usage.json is corrupt; moving it to a .bak file and starting empty");
            // 退避先は `ai_usage.json.bak.<unix秒>` (既存の退避を上書きしない)。失敗は warn のみ。
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let mut name = path.as_os_str().to_os_string();
            name.push(format!(".bak.{secs}"));
            if let Err(re) = std::fs::rename(path, PathBuf::from(name)) {
                tracing::warn!(error = %re, "failed to move the corrupt ai_usage.json aside");
            }
            Ok(Vec::new())
        }
    }
}

fn save_locked(records: Vec<AiUsageRecord>) -> Result<()> {
    let path = usage_path()?;
    let content = serde_json::to_string_pretty(&UsageFile { records })?;
    write_atomic(&path, content.as_bytes())?;
    Ok(())
}

/// `snippets::store::write_atomic` と同じ手順 (PID + プロセス内カウンタの一時ファイルを
/// `create_new` で排他予約 → `sync_all` → `rename`)。失敗時は自分の一時ファイルを消す。
fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(".ai_usage.json.tmp.{}.{}", std::process::id(), seq));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)?;
    let written = f.write_all(content).and_then(|()| f.sync_all());
    drop(f);
    let written = written.and_then(|()| std::fs::rename(&tmp_path, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    written
}

/// 完了 1 件を記録する。ファイル I/O は同期なので、非同期ランタイムのワーカーを塞がないよう
/// blocking スレッドへ逃がす。返る `JoinHandle` を await すると保存完了を待てる (完了通知の前に
/// 台帳へ入っていることを保証したい呼び出し側用。待たなくてもよい)。失敗しても AI 処理は
/// 続けたいので `warn` ログのみ。
pub fn record(
    task: AiTaskKind,
    model: &str,
    usage: &AiUsage,
) -> tauri::async_runtime::JoinHandle<()> {
    let model = model.to_string();
    let usage = *usage;
    tauri::async_runtime::spawn_blocking(move || record_blocking(task, &model, &usage))
}

fn record_blocking(task: AiTaskKind, model: &str, usage: &AiUsage) {
    let result = (|| -> Result<()> {
        let _guard = lock_store();
        let mut all = load_locked()?;
        apply(&mut all, Utc::now(), &task_name(task), model, usage);
        save_locked(all)
    })();
    if let Err(e) = result {
        tracing::warn!(error = %e, "failed to record ai usage");
    }
}

fn load_all_blocking() -> Result<Vec<AiUsageRecord>> {
    let _guard = lock_store();
    load_locked()
}

fn clear_blocking() -> Result<()> {
    let _guard = lock_store();
    save_locked(Vec::new())
}

pub async fn load_all() -> Result<Vec<AiUsageRecord>> {
    tauri::async_runtime::spawn_blocking(load_all_blocking)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

pub async fn clear() -> Result<()> {
    tauri::async_runtime::spawn_blocking(clear_blocking)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn usage(i: u64, o: u64, cr: u64, cw: u64) -> AiUsage {
        AiUsage {
            input_tokens: i,
            output_tokens: o,
            cache_read_input_tokens: cr,
            cache_creation_input_tokens: cw,
        }
    }

    #[test]
    fn corrupt_ledger_is_moved_to_bak_and_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("noobdb-ai-usage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ai_usage.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_records(&path).unwrap().is_empty());
        assert!(!path.exists());
        let bak: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("ai_usage.json.bak."))
            .collect();
        assert_eq!(bak.len(), 1);
        assert_eq!(
            std::fs::read_to_string(dir.join(&bak[0])).unwrap(),
            "{ not json"
        );
        // 無いファイル / 空ファイルも空。
        assert!(read_records(&path).unwrap().is_empty());
        std::fs::write(&path, "  ").unwrap();
        assert!(read_records(&path).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn day_key_is_jst() {
        // 14:59 UTC は JST 同日 23:59、15:00 UTC は JST 翌日 00:00。
        let a = Utc.with_ymd_and_hms(2026, 10, 12, 14, 59, 0).unwrap();
        let b = Utc.with_ymd_and_hms(2026, 10, 12, 15, 0, 0).unwrap();
        assert_eq!(jst_day(a), "2026-10-12");
        assert_eq!(jst_day(b), "2026-10-13");
    }

    #[test]
    fn same_day_task_model_accumulate_and_others_split() {
        let now = Utc.with_ymd_and_hms(2026, 10, 12, 1, 0, 0).unwrap();
        let mut r = Vec::new();
        apply(
            &mut r,
            now,
            "nl2sql",
            "claude-opus-5-5",
            &usage(10, 20, 3, 4),
        );
        apply(&mut r, now, "nl2sql", "claude-opus-5-5", &usage(1, 2, 3, 4));
        apply(
            &mut r,
            now,
            "nl2sql",
            "claude-haiku-5-5",
            &usage(5, 5, 0, 0),
        );
        apply(
            &mut r,
            now,
            "generic",
            "claude-opus-5-5",
            &usage(7, 7, 0, 0),
        );
        assert_eq!(r.len(), 3);
        let first = &r[0];
        assert_eq!(first.calls, 2);
        assert_eq!(first.input_tokens, 11);
        assert_eq!(first.output_tokens, 22);
        assert_eq!(first.cache_read_input_tokens, 6);
        assert_eq!(first.cache_creation_input_tokens, 8);
        let next_day = now + Duration::days(1);
        apply(
            &mut r,
            next_day,
            "nl2sql",
            "claude-opus-5-5",
            &usage(1, 1, 0, 0),
        );
        assert_eq!(r.len(), 4);
    }

    #[test]
    fn old_days_are_pruned_and_counters_saturate() {
        let now = Utc.with_ymd_and_hms(2026, 10, 12, 1, 0, 0).unwrap();
        let old = now - Duration::days(RETENTION_DAYS + 5);
        let mut r = Vec::new();
        apply(&mut r, old, "generic", "m", &usage(1, 1, 0, 0));
        apply(&mut r, now, "generic", "m", &usage(u64::MAX, 1, 0, 0));
        apply(&mut r, now, "generic", "m", &usage(5, 1, 0, 0));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].input_tokens, u64::MAX);
        assert_eq!(r[0].calls, 2);
    }

    #[test]
    fn task_names_are_camel_case_and_record_has_no_content_fields() {
        assert_eq!(task_name(AiTaskKind::Nl2sql), "nl2sql");
        assert_eq!(task_name(AiTaskKind::InlineComplete), "inlineComplete");
        let mut r = Vec::new();
        let now = Utc.with_ymd_and_hms(2026, 10, 12, 1, 0, 0).unwrap();
        apply(&mut r, now, "generic", "m", &usage(1, 2, 3, 4));
        let v = serde_json::to_value(&r[0]).unwrap();
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "cacheCreationInputTokens",
                "cacheReadInputTokens",
                "calls",
                "day",
                "inputTokens",
                "model",
                "outputTokens",
                "task"
            ]
        );
    }
}
