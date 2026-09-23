//! テーブル・タイムラプス (#739) — ウォッチ登録したテーブルの世代スナップショットと、
//! 任意の 2 世代間の行差分。
//!
//! `flight_recorder` / `history` と同じ分割: [`store`] がローカル専用 SQLite
//! (`<data_dir>/table_timelapse.sqlite`) を持ち、ここは store と IPC 層
//! (`commands::timelapse`) が共有する型と**純関数** (フィンガープリント・列の
//! 位置合わせ・世代間差分) を持つ。
//!
//! ## 設計 (Issue #739 の受け入れ条件との対応)
//!
//! - **保存先**: アプリデータディレクトリ配下のローカル専用ストアのみ。外部送信・
//!   リモート書き込みは一切しない。Unix ではファイルを `0600` に絞る
//!   (`flight_recorder::store` と同じ多層防御)。
//! - **秘密情報を含めない**: 保存するのはプロファイル ID・データベース名・テーブル名・
//!   列名/型・行データのみ。接続先ホストや資格情報は保存しない (パスワード等は
//!   従来どおり OS keyring にだけある)。ただし**行データは実データのローカル
//!   コピー**なので機微データを含みうる — これは登録時の確認ダイアログで明示する。
//! - **機微カラムマスク (#1069) の扱い**: マスクは結果グリッドと同じく**表示専用**。
//!   スナップショットには実値を保存する (マスク後の値を保存すると値の変化を検出
//!   できないため)。差分表示側は結果グリッドと同じパターン設定で該当列を伏せ字に
//!   する (変化したこと自体はハイライトで分かるが、値は reveal しない限り出さない)。
//! - **容量**: 行数上限は既存のデータ比較と同じ `MAX_DATA_ROWS` (5000)。超える
//!   テーブルは登録時に明示的な同意 (「先頭 N 行だけを記録」) が無ければ拒否し、
//!   同意した場合も各世代に `truncated` を記録して部分取得であることを表示する。
//!   世代数はウォッチ単位で [`clamp_max_generations`] の範囲 (既定 20) で
//!   ローテーションし、全ウォッチ合計の保存量は [`MAX_TOTAL_BYTES`] で頭打ちにする
//!   (古い世代から削除。各ウォッチの最新世代は残す)。
//! - **同一内容なら世代を増やさない**: 列名 + 行データの直列化に対する
//!   [`fingerprint`] を直前世代と比較する。
//! - **読み取り専用**: 取得は PK 順の単一 `SELECT` のみで、クエリ履歴にも記録
//!   しない (`Connection::execute` を直接呼ぶ。`compare_table_data` と同じ経路)。

pub mod store;

use serde::{Deserialize, Serialize};

use crate::db::data_diff::{compute_data_diff, DataDiff};
use crate::db::types::Value;
use crate::db::DriverKind;

/// ウォッチ 1 件あたりの保持世代数の既定値 (フロントの設定既定値と揃える)。
pub const DEFAULT_MAX_GENERATIONS: usize = 20;
/// 保持世代数として受け付ける上限。
pub const MAX_MAX_GENERATIONS: usize = 100;
/// 全ウォッチ合計の保存量の上限 (行データ JSON のバイト数の合計)。
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB

/// 設定値 (未指定・範囲外を含む) を実際に使う保持世代数へ丸める。
pub fn clamp_max_generations(requested: Option<u32>) -> usize {
    match requested {
        None => DEFAULT_MAX_GENERATIONS,
        Some(n) => (n as usize).clamp(1, MAX_MAX_GENERATIONS),
    }
}

/// 1 回の取得結果 (1 世代の中身)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub columns: Vec<String>,
    /// `columns` と同じ並びの型名。
    pub column_types: Vec<String>,
    pub primary_key: Vec<String>,
    /// PK 順の行 (各行は `columns` の並び)。
    pub rows: Vec<Vec<Value>>,
    /// 行数上限に達し、先頭 N 行だけを取得したとき true。
    pub truncated: bool,
}

/// 保存済み世代のメタデータ (一覧表示用。行データは含まない)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationMeta {
    pub id: i64,
    /// 取得時刻 (RFC 3339)。
    pub captured_at: String,
    pub row_count: usize,
    pub truncated: bool,
    /// この世代の保存量 (行データ JSON のバイト数)。
    pub bytes: u64,
}

/// ウォッチ登録 1 件と、その世代一覧 (新しい順)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableWatch {
    pub id: i64,
    pub profile_id: String,
    /// `DriverKind` のワイヤ名 ("mysql" / "postgres" / ...)。
    pub driver: String,
    pub database: String,
    pub table: String,
    /// false のときはウォッチ解除済み (世代データを残す選択をした)。自動取得の
    /// 対象外だが、保存済み世代の閲覧・差分表示はできる。
    pub active: bool,
    /// 登録時に行数上限を超えており、先頭 N 行だけの記録に同意したか。
    pub partial: bool,
    pub created_at: String,
    pub generations: Vec<GenerationMeta>,
}

/// 2 世代間の差分。`diff` の `source` 側が**新しい世代**、`target` 側が**古い世代**:
/// `source_only` = 追加された行、`target_only` = 削除された行、`different` =
/// 変更された行 (`changed_columns` がセル単位の変更列)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationDiff {
    pub diff: DataDiff,
    /// 古い世代に無く新しい世代にある列 (新しい世代の列で表示するため、古い側の値は NULL 扱い)。
    pub columns_added: Vec<String>,
    /// 古い世代にあり新しい世代に無い列 (差分表示の対象外)。
    pub columns_removed: Vec<String>,
    /// どちらかの世代が部分取得 (行数上限で打ち切り) なら true。範囲外の行は
    /// 追加/削除として誤って現れうる。
    pub partial: bool,
    pub from_captured_at: String,
    pub to_captured_at: String,
}

/// 決定的な 64bit FNV-1a。dedupe 目的の内容フィンガープリント専用で暗号学的な
/// 強度は不要。`std` の `DefaultHasher` はリリース間で値が変わりうると明記されて
/// おり、ディスクに保存して次回起動時に比較する用途には使えないため自前で持つ。
fn fnv1a64(parts: &[&[u8]]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in *part {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        // 区切り (列名と行の境界をずらした衝突を避ける)。
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 列名 + 行データ JSON からフィンガープリント (16 桁 16 進) を作る。
pub fn fingerprint(columns: &[String], rows_json: &str) -> String {
    let cols = columns.join("\u{1f}");
    format!("{:016x}", fnv1a64(&[cols.as_bytes(), rows_json.as_bytes()]))
}

/// `rows` (並びは `from`) を `to` の列並びへ並べ替える。`to` にあって `from` に
/// 無い列は `NULL` で埋める。世代間で列が追加・削除されていても、名前で揃えて
/// から PK ペアリングに渡すため。
pub fn align_rows(from: &[String], to: &[String], rows: &[Vec<Value>]) -> Vec<Vec<Value>> {
    let idx: Vec<Option<usize>> = to
        .iter()
        .map(|name| from.iter().position(|c| c == name))
        .collect();
    rows.iter()
        .map(|row| {
            idx.iter()
                .map(|i| i.and_then(|i| row.get(i).cloned()).unwrap_or(Value::Null))
                .collect()
        })
        .collect()
}

/// 2 世代 (`older` → `newer`) の行差分を計算する。PK ペアリングと変更列の判定は
/// データ比較と同じ `db::data_diff::compute_data_diff` をそのまま使う。列・PK は
/// 新しい世代のものに揃える。
pub fn diff_snapshots(
    driver: DriverKind,
    table: &str,
    older: &Snapshot,
    newer: &Snapshot,
) -> (DataDiff, Vec<String>, Vec<String>) {
    let columns = newer.columns.clone();
    let older_rows = align_rows(&older.columns, &columns, &older.rows);
    let pk_idx: Vec<usize> = newer
        .primary_key
        .iter()
        .filter_map(|name| columns.iter().position(|c| c == name))
        .collect();
    let rows = compute_data_diff(&columns, &pk_idx, &newer.rows, &older_rows);
    let columns_added = newer
        .columns
        .iter()
        .filter(|c| !older.columns.contains(c))
        .cloned()
        .collect();
    let columns_removed = older
        .columns
        .iter()
        .filter(|c| !newer.columns.contains(c))
        .cloned()
        .collect();
    let diff = DataDiff {
        target_driver: driver,
        table: table.to_string(),
        columns,
        column_types: newer.column_types.clone(),
        primary_key: newer.primary_key.clone(),
        rows,
        truncated: older.truncated || newer.truncated,
        source_count: newer.rows.len(),
        target_count: older.rows.len(),
    };
    (diff, columns_added, columns_removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::data_diff::RowStatus;

    fn s(v: &str) -> String {
        v.to_string()
    }

    fn snap(columns: &[&str], rows: Vec<Vec<Value>>) -> Snapshot {
        Snapshot {
            columns: columns.iter().map(|c| s(c)).collect(),
            column_types: columns.iter().map(|_| s("TEXT")).collect(),
            primary_key: vec![s("id")],
            rows,
            truncated: false,
        }
    }

    #[test]
    fn clamp_max_generations_defaults_and_bounds() {
        assert_eq!(clamp_max_generations(None), DEFAULT_MAX_GENERATIONS);
        assert_eq!(clamp_max_generations(Some(0)), 1);
        assert_eq!(clamp_max_generations(Some(5)), 5);
        assert_eq!(clamp_max_generations(Some(10_000)), MAX_MAX_GENERATIONS);
    }

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        let cols = vec![s("id"), s("v")];
        let a = fingerprint(&cols, "[[1,\"x\"]]");
        assert_eq!(a, fingerprint(&cols, "[[1,\"x\"]]"));
        assert_eq!(a.len(), 16);
        assert_ne!(a, fingerprint(&cols, "[[1,\"y\"]]"));
        // 列名の変更 (値は同じ) も別内容として扱う。
        assert_ne!(a, fingerprint(&[s("id"), s("w")], "[[1,\"x\"]]"));
        // 境界をずらした入力が衝突しない。
        assert_ne!(fingerprint(&[s("ab")], "c"), fingerprint(&[s("a")], "bc"));
    }

    #[test]
    fn align_rows_reorders_and_fills_missing_columns_with_null() {
        let from = vec![s("id"), s("name")];
        let to = vec![s("name"), s("id"), s("added")];
        let rows = vec![vec![Value::Int(1), Value::String(s("a"))]];
        assert_eq!(
            align_rows(&from, &to, &rows),
            vec![vec![Value::String(s("a")), Value::Int(1), Value::Null]]
        );
    }

    #[test]
    fn diff_snapshots_classifies_added_removed_and_changed_rows() {
        let older = snap(
            &["id", "price"],
            vec![
                vec![Value::Int(1), Value::Int(100)],
                vec![Value::Int(2), Value::Int(200)],
                vec![Value::Int(3), Value::Int(300)],
            ],
        );
        let newer = snap(
            &["id", "price"],
            vec![
                vec![Value::Int(1), Value::Int(100)],
                vec![Value::Int(2), Value::Int(250)],
                vec![Value::Int(4), Value::Int(400)],
            ],
        );
        let (diff, added, removed) = diff_snapshots(DriverKind::Mysql, "fees", &older, &newer);
        assert!(added.is_empty() && removed.is_empty());
        assert_eq!(diff.table, "fees");
        assert_eq!(diff.source_count, 3);
        assert_eq!(diff.target_count, 3);
        let by_status = |st: RowStatus| diff.rows.iter().filter(|r| r.status == st).count();
        // source = 新しい世代なので source_only = 追加、target_only = 削除。
        assert_eq!(by_status(RowStatus::SourceOnly), 1);
        assert_eq!(by_status(RowStatus::TargetOnly), 1);
        assert_eq!(by_status(RowStatus::Different), 1);
        let changed = diff
            .rows
            .iter()
            .find(|r| r.status == RowStatus::Different)
            .unwrap();
        assert_eq!(changed.key, vec![Value::Int(2)]);
        assert_eq!(changed.changed_columns, vec![s("price")]);
        assert_eq!(changed.source.as_ref().unwrap()[1], Value::Int(250));
        assert_eq!(changed.target.as_ref().unwrap()[1], Value::Int(200));
    }

    #[test]
    fn diff_snapshots_handles_column_changes_between_generations() {
        let older = snap(
            &["id", "legacy", "v"],
            vec![vec![Value::Int(1), Value::Int(9), Value::Int(1)]],
        );
        let newer = snap(
            &["id", "v", "note"],
            vec![vec![Value::Int(1), Value::Int(1), Value::String(s("n"))]],
        );
        let (diff, added, removed) = diff_snapshots(DriverKind::Sqlite, "t", &older, &newer);
        assert_eq!(added, vec![s("note")]);
        assert_eq!(removed, vec![s("legacy")]);
        assert_eq!(diff.columns, vec![s("id"), s("v"), s("note")]);
        // 追加列は古い側が NULL 扱いなので「変更」として現れる。削除列は比較対象外。
        assert_eq!(diff.rows.len(), 1);
        assert_eq!(diff.rows[0].changed_columns, vec![s("note")]);
    }

    #[test]
    fn diff_snapshots_marks_partial_generations() {
        let older = snap(&["id"], vec![]);
        let mut newer = snap(&["id"], vec![vec![Value::Int(1)]]);
        newer.truncated = true;
        let (diff, _, _) = diff_snapshots(DriverKind::Postgres, "t", &older, &newer);
        assert!(diff.truncated);
    }

    #[test]
    fn identical_snapshots_produce_no_rows() {
        let a = snap(
            &["id", "v"],
            vec![vec![Value::Int(1), Value::String(s("x"))]],
        );
        let (diff, _, _) = diff_snapshots(DriverKind::Mssql, "t", &a, &a.clone());
        assert!(diff.rows.is_empty());
    }
}
