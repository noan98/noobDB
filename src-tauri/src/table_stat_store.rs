//! テーブル統計 (行数・合計サイズ) の前回値の保存 (#1621)。`table_stat_snapshots.json` に
//! (プロファイル, データベース) ごとに 1 件のスナップショットを持ち、テーブル統計
//! ダッシュボードが「前回取得からの増減」を出す基準にする。
//!
//! 保存するのはテーブル名・概算行数・サイズだけの非秘密のメタデータ。基準の据え置き / 更新の
//! 規則は純関数 `db::schema_insight::should_roll_baseline`。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::db::schema_insight::{
    apply_previous, should_roll_baseline, snapshot_of, StatSnapshot, TableStatistic,
};
use crate::error::Result;
use crate::json_store::JsonStore;

/// 基準を更新する最短間隔 (秒)。これより新しい基準は据え置き、増減を基準時刻からの累積で見せる。
pub const MIN_BASELINE_AGE_SECS: i64 = 300;
/// 保持する (プロファイル, データベース) の最大数。超えたら古いものから捨てる。
const MAX_KEYS: usize = 50;

#[derive(Debug, Default, Serialize, Deserialize)]
struct SnapshotFile {
    #[serde(default)]
    snapshots: BTreeMap<String, StatSnapshot>,
}

static STORE: JsonStore = JsonStore::new("table_stat_snapshots.json");

fn key_of(profile_id: Option<&str>, database: &str) -> String {
    format!("{}|{database}", profile_id.unwrap_or("-"))
}

fn attach_in(
    file: &mut SnapshotFile,
    profile_id: Option<&str>,
    database: &str,
    stats: &mut [TableStatistic],
    now: &str,
) {
    let key = key_of(profile_id, database);
    let baseline = file.snapshots.get(&key);
    apply_previous(stats, baseline);
    if should_roll_baseline(baseline, now, MIN_BASELINE_AGE_SECS) {
        file.snapshots.insert(key, snapshot_of(stats, now));
        // 件数の上限: 取得時刻の古いものから捨てる。
        while file.snapshots.len() > MAX_KEYS {
            let oldest = file
                .snapshots
                .iter()
                .min_by(|a, b| a.1.at.cmp(&b.1.at))
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => file.snapshots.remove(&k),
                None => break,
            };
        }
    }
}

/// 今回の統計に前回値を載せ、必要なら基準を今回のものに更新する (1 回のロックで)。
pub fn attach_and_roll(
    profile_id: Option<&str>,
    database: &str,
    stats: &mut [TableStatistic],
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    STORE.update::<SnapshotFile, _>(|f| attach_in(f, profile_id, database, stats, &now))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(name: &str, rows: i64, bytes: i64) -> TableStatistic {
        TableStatistic {
            name: name.into(),
            row_estimate: Some(rows),
            data_bytes: Some(bytes),
            index_bytes: Some(0),
            total_bytes: Some(bytes),
            column_count: Some(1),
            index_count: 0,
            has_primary_key: true,
            foreign_key_count: 0,
            previous: None,
        }
    }

    #[test]
    fn first_fetch_has_no_previous_then_diffs_against_the_baseline() {
        let mut file = SnapshotFile::default();
        let mut first = vec![stat("a", 10, 100)];
        attach_in(
            &mut file,
            Some("p"),
            "db",
            &mut first,
            "2026-01-01T00:00:00Z",
        );
        assert!(first[0].previous.is_none());

        // 十分あとの再取得: 前回値が載り、基準は今回へ更新される。
        let mut second = vec![stat("a", 25, 400), stat("new", 1, 1)];
        attach_in(
            &mut file,
            Some("p"),
            "db",
            &mut second,
            "2026-01-01T01:00:00Z",
        );
        let prev = second[0].previous.as_ref().expect("previous");
        assert_eq!(prev.row_estimate, Some(10));
        assert_eq!(prev.total_bytes, Some(100));
        assert_eq!(prev.at, "2026-01-01T00:00:00Z");
        assert!(
            second[1].previous.is_none(),
            "前回に無かったテーブルは差分なし"
        );

        let mut third = vec![stat("a", 30, 500)];
        attach_in(
            &mut file,
            Some("p"),
            "db",
            &mut third,
            "2026-01-01T02:00:00Z",
        );
        assert_eq!(third[0].previous.as_ref().unwrap().row_estimate, Some(25));
    }

    #[test]
    fn rapid_refreshes_keep_the_baseline_so_deltas_do_not_collapse_to_zero() {
        let mut file = SnapshotFile::default();
        attach_in(
            &mut file,
            None,
            "db",
            &mut [stat("a", 10, 100)],
            "2026-01-01T00:00:00Z",
        );
        let mut quick = vec![stat("a", 12, 120)];
        attach_in(&mut file, None, "db", &mut quick, "2026-01-01T00:01:00Z");
        assert_eq!(quick[0].previous.as_ref().unwrap().row_estimate, Some(10));
        // 1 分後にもう一度 — 基準は据え置かれたまま (最初の取得との差を見せ続ける)。
        let mut again = vec![stat("a", 13, 130)];
        attach_in(&mut file, None, "db", &mut again, "2026-01-01T00:02:00Z");
        assert_eq!(again[0].previous.as_ref().unwrap().row_estimate, Some(10));
        assert_eq!(
            again[0].previous.as_ref().unwrap().at,
            "2026-01-01T00:00:00Z"
        );
    }

    #[test]
    fn baselines_are_separate_per_profile_and_database_and_capped() {
        let mut file = SnapshotFile::default();
        attach_in(
            &mut file,
            Some("p1"),
            "db",
            &mut [stat("a", 1, 1)],
            "2026-01-01T00:00:00Z",
        );
        let mut other = vec![stat("a", 2, 2)];
        attach_in(
            &mut file,
            Some("p2"),
            "db",
            &mut other,
            "2026-01-01T01:00:00Z",
        );
        assert!(other[0].previous.is_none());
        attach_in(
            &mut file,
            Some("p1"),
            "db2",
            &mut [stat("a", 1, 1)],
            "2026-01-01T01:00:00Z",
        );
        assert_eq!(file.snapshots.len(), 3);

        for i in 0..(MAX_KEYS + 5) {
            attach_in(
                &mut file,
                Some(&format!("x{i}")),
                "db",
                &mut [stat("a", 1, 1)],
                &format!("2026-02-01T00:{:02}:00Z", i % 60),
            );
        }
        assert_eq!(file.snapshots.len(), MAX_KEYS);
    }
}
