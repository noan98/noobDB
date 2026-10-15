//! アサーションの観測値の履歴 (#1621)。`assertion_history.json` に、アサーション ID ごとに
//! 直近 [`HISTORY_LIMIT`] 件の実行結果 (観測値・合否・所要時間・実行時刻) だけを残し、
//! 一覧に「前回から増減」を出す材料にする。
//!
//! 保存するのは非秘密のメタデータだけで、**違反行の中身は保存しない**。ストアの書き込み
//! 規約は `assertions::store` と同じ (ストア単位の `Mutex` + アトミック置換 + 壊れたファイルは
//! 退避して空から再開)。履歴は補助情報なので、記録の失敗は検証結果そのものを失敗させない
//! (呼び出し側が警告ログに留める)。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::error::Result;
use crate::json_store::JsonStore;

const FILE_NAME: &str = "assertion_history.json";
/// アサーション 1 件あたりに残す実行結果の最大件数。
pub const HISTORY_LIMIT: usize = 30;

/// 1 回の実行結果 (履歴の 1 行)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSample {
    /// 実行時刻 (UTC, RFC 3339)。
    pub at: String,
    pub observed: u64,
    pub passed: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HistoryFile {
    /// アサーション ID → 古い順の実行結果。
    #[serde(default)]
    runs: BTreeMap<String, Vec<RunSample>>,
}

static STORE: JsonStore = JsonStore::new(FILE_NAME);

/// `sample` を追記し、追記前の最新の結果 (= 「前回」) を返す。上限を超えた古い結果は捨てる。
fn push_sample(file: &mut HistoryFile, id: &str, sample: RunSample) -> Option<RunSample> {
    let runs = file.runs.entry(id.to_string()).or_default();
    let previous = runs.last().cloned();
    runs.push(sample);
    if runs.len() > HISTORY_LIMIT {
        let excess = runs.len() - HISTORY_LIMIT;
        runs.drain(..excess);
    }
    previous
}

/// 実行結果を記録して前回の結果を返す。
pub fn record(id: &str, sample: RunSample) -> Result<Option<RunSample>> {
    STORE.update::<HistoryFile, _>(|f| push_sample(f, id, sample))
}

/// 現在時刻の `RunSample` を作る。
pub fn sample_now(observed: u64, passed: bool, elapsed_ms: u64) -> RunSample {
    RunSample {
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        observed,
        passed,
        elapsed_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::json_store::update_at;
    use std::path::{Path, PathBuf};

    fn record_at(path: &Path, id: &str, sample: RunSample) -> Result<Option<RunSample>> {
        update_at::<HistoryFile, _>(path, |f| push_sample(f, id, sample))
    }

    fn load_file(path: &Path) -> Result<HistoryFile> {
        crate::json_store::load_from(path)
    }

    fn scratch(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("noobdb_assert_hist_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn s(observed: u64) -> RunSample {
        RunSample {
            at: "2026-01-01T00:00:00Z".into(),
            observed,
            passed: observed == 0,
            elapsed_ms: 5,
        }
    }

    #[test]
    fn record_returns_previous_and_caps_history() {
        let dir = scratch("cap");
        let path = dir.join(FILE_NAME);
        assert_eq!(record_at(&path, "a", s(3)).unwrap(), None);
        assert_eq!(record_at(&path, "a", s(12)).unwrap(), Some(s(3)));
        // 別 ID の履歴は混ざらない。
        assert_eq!(record_at(&path, "b", s(1)).unwrap(), None);
        for i in 0..(HISTORY_LIMIT as u64 + 5) {
            record_at(&path, "a", s(100 + i)).unwrap();
        }
        let file = load_file(&path).unwrap();
        assert_eq!(file.runs["a"].len(), HISTORY_LIMIT);
        assert_eq!(
            file.runs["a"].last().unwrap().observed,
            100 + HISTORY_LIMIT as u64 + 4
        );
        assert_eq!(file.runs["b"].len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_history_is_quarantined() {
        let dir = scratch("corrupt");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(record_at(&path, "a", s(1)).unwrap(), None);
        assert_eq!(load_file(&path).unwrap().runs["a"].len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
