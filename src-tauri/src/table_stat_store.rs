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

/// プロファイル削除時に、そのプロファイルのスナップショットをすべて消す (全データベース分)。
/// 削除した件数を返す。キーは `"{profile_id}|{database}"`。
pub fn delete_profile_data(profile_id: &str) -> Result<u64> {
    // 該当が無ければ書き込まない (先に読んで確認する)。
    let prefix = format!("{profile_id}|");
    let file: SnapshotFile = STORE.read()?;
    if !file.snapshots.keys().any(|k| k.starts_with(&prefix)) {
        return Ok(0);
    }
    // `|` を含む別 ID (例: `a` を消すときの `a|b`) のキーも `a|` で始まるので、
    // 現存するプロファイルのうち `{profile_id}|` で始まる ID のキーは巻き込まない。
    // 一覧が読めないときは安全側に倒し、何も消さない。
    let others: Vec<String> = crate::profiles::store::load_all()?
        .into_iter()
        .map(|p| p.id)
        .filter(|k| k != profile_id && k.starts_with(&prefix))
        .collect();
    STORE.update::<SnapshotFile, _>(|f| purge_profile(f, profile_id, &others))
}

/// 保存済みのプロファイル ID (起動時の孤立データ掃除用)。プロファイルを持たない一時接続
/// (キー接頭辞 `-`) は含まない。キーは最初の `|` で分けるので、`|` を含む ID は先頭部分だけが
/// 返る。呼び出し側 (`profiles::cleanup::select_orphans`) が、既知 ID の接頭辞になっている
/// 候補を除いて誤削除を防ぐ。
pub fn profile_ids() -> Result<Vec<String>> {
    let file: SnapshotFile = STORE.read()?;
    Ok(ids_in(&file))
}

fn ids_in(file: &SnapshotFile) -> Vec<String> {
    let set: std::collections::BTreeSet<&str> = file
        .snapshots
        .keys()
        .filter_map(|k| k.split_once('|').map(|(p, _)| p))
        .filter(|p| *p != "-")
        .collect();
    set.into_iter().map(str::to_string).collect()
}

/// `others` は `{profile_id}|` で始まる、現存する別のプロファイル ID。そのキーは残す。
fn purge_profile(file: &mut SnapshotFile, profile_id: &str, others: &[String]) -> u64 {
    let prefix = format!("{profile_id}|");
    let before = file.snapshots.len();
    file.snapshots.retain(|k, _| {
        !k.starts_with(&prefix) || others.iter().any(|o| k.starts_with(&format!("{o}|")))
    });
    (before - file.snapshots.len()) as u64
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
            dead_rows: None,
            last_vacuum_at: None,
            last_analyze_at: None,
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

    #[test]
    fn purge_profile_removes_only_that_profile_and_lists_ids() {
        let mut file = SnapshotFile::default();
        let mut stats = vec![stat("a", 1, 1)];
        attach_in(
            &mut file,
            Some("p"),
            "db1",
            &mut stats,
            "2026-01-01T00:00:00Z",
        );
        attach_in(
            &mut file,
            Some("p"),
            "db2",
            &mut stats,
            "2026-01-01T00:00:00Z",
        );
        attach_in(
            &mut file,
            Some("pp"),
            "db1",
            &mut stats,
            "2026-01-01T00:00:00Z",
        );
        attach_in(&mut file, None, "db1", &mut stats, "2026-01-01T00:00:00Z");
        assert_eq!(ids_in(&file), vec!["p", "pp"]);
        // 接頭辞が同じ別 ID ("pp") は巻き込まない。
        assert_eq!(purge_profile(&mut file, "p", &[]), 2);
        assert_eq!(ids_in(&file), vec!["pp"]);
        assert_eq!(file.snapshots.len(), 2);
    }

    #[test]
    fn ids_split_at_the_first_pipe_so_pipe_ids_yield_a_prefix() {
        let mut file = SnapshotFile::default();
        let mut stats = vec![stat("a", 1, 1)];
        attach_in(
            &mut file,
            Some("a|b"),
            "db",
            &mut stats,
            "2026-01-01T00:00:00Z",
        );
        // 呼び出し側 (cleanup::select_orphans) が既知 ID の接頭辞として除外できる形で返る。
        assert_eq!(ids_in(&file), vec!["a"]);
        // 接頭辞だけの ID を消しても、`|` を含む別 ID のキーは巻き込まない。
        assert_eq!(purge_profile(&mut file, "a|b", &[]), 1);
    }

    #[test]
    fn purging_a_prefix_id_keeps_snapshots_of_an_existing_pipe_id() {
        let mut file = SnapshotFile::default();
        for id in ["a", "a|b"] {
            let mut stats = vec![stat("t", 1, 1)];
            attach_in(
                &mut file,
                Some(id),
                "db",
                &mut stats,
                "2026-01-01T00:00:00Z",
            );
        }
        // `a` を消しても、現存する `a|b` のスナップショットは残る。
        assert_eq!(purge_profile(&mut file, "a", &["a|b".to_string()]), 1);
        assert!(file.snapshots.contains_key("a|b|db"));
        assert!(!file.snapshots.contains_key("a|db"));
    }
}
