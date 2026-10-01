//! スキーマドリフト・タイムライン (#736) — プロファイル単位のスキーマ世代と、
//! 世代間の差分サマリ。
//!
//! 旧実装はフロントが `list_tables` + テーブルごとの `describe_table` /
//! `list_indexes` (直列 2N IPC) でスナップショットを集め、`localStorage` に
//! 1 世代 200KB × 20 世代を同期で読み書きしていた (#1260)。現在は
//! `timelapse` と同じ構成で、取得 (`Connection::columns_for_database` /
//! `indexes_for_database` の 2 クエリ)・正規化・フィンガープリント・保存・
//! ローテーション・前世代との差分計算をすべて Rust 内で完結させ、フロントへは
//! 要約だけを返す。[`store`] がローカル専用 SQLite (`<data_dir>/schema_drift.sqlite`)
//! を持ち、ここは store と IPC 層 (`commands::schema_drift`) が共有する型と
//! **純関数** (正規化・フィンガープリント・インデックス差分・サマリ整形) を持つ。
//!
//! 保存するのはスキーマ (テーブル名・列の型・インデックス定義) のみで、行データや
//! 接続先の資格情報は含めない。

pub mod store;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::db::diff::{compute_schema_diff, DiffStatus, SchemaDiff, TableColumns};
use crate::db::types::{IndexInfo, TableColumnInfo, TableIndexes};
use crate::db::{Connection, DriverKind};
use crate::error::Result;

/// 1 プロファイルあたり保持する世代の上限 (超過した古い世代は切り捨て)。
pub const MAX_GENERATIONS: usize = 20;

/// 1 世代の直列化ペイロードがこのサイズ (バイト) を超えたら中身の保存を省略する
/// 「サイズ暴走ガード」。旧実装は localStorage のクォータ保護で 200KB だったが、
/// SQLite ストアでは桁違いに余裕があるため 8 MiB に緩めた。超過時も世代メタ
/// (取得時刻・フィンガープリント・テーブル数) は記録し `omitted: true` を立てる。
pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

/// 1 テーブル分のスナップショット: 列メタデータ + インデックス一覧。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotTable {
    pub name: String,
    pub columns: Vec<TableColumnInfo>,
    #[serde(default)]
    pub indexes: Vec<IndexInfo>,
}

/// 1 世代分の完全なスナップショット内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotPayload {
    pub driver: DriverKind,
    pub database: String,
    pub tables: Vec<SnapshotTable>,
}

/// 保存済み世代のメタデータ (一覧表示用。ペイロードは含まない)。フロントは localStorage
/// 時代から `capturedAt` / `tableCount` の camelCase で読むため、ワイヤ名もそれに揃える。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationMeta {
    /// ストア内の世代 ID (ワイヤでは文字列。フロントの `<select>` の値として使う)。
    pub id: String,
    /// 取得時刻 (RFC 3339)。
    pub captured_at: String,
    pub driver: DriverKind,
    pub database: String,
    /// [`fingerprint_payload`] による内容フィンガープリント (dedupe 用)。
    pub fingerprint: String,
    /// キャプチャ時点のテーブル数 (ペイロードが省略されていても保持)。
    pub table_count: usize,
    /// true のとき、サイズ暴走ガードでペイロードを保存していない (差分表示不可)。
    pub omitted: bool,
}

/// インデックス差分の種別。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexDriftStatus {
    Added,
    Removed,
    Changed,
}

/// テーブル 1 つ内、インデックス 1 本の差分。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexDriftEntry {
    pub table: String,
    pub index_name: String,
    pub status: IndexDriftStatus,
}

/// テーブル自体の増減 (`Added` / `Removed`) か、両側に存在するテーブル内の変化 (`Changed`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TableChangeStatus {
    Added,
    Removed,
    Changed,
}

/// 1 テーブルの変化サマリ。フロントの整形ロジック (`formatTableChangeFragment`) と
/// 同じ camelCase のフィールド名で返す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeSummary {
    pub table: String,
    pub table_status: TableChangeStatus,
    pub columns_added: usize,
    pub columns_removed: usize,
    pub columns_changed: usize,
    pub indexes_added: usize,
    pub indexes_removed: usize,
    pub indexes_changed: usize,
    /// 追加/削除/変更された列名 (`Changed` テーブルのみ。名前順)。アクティビティの
    /// 詳細表示で「どのテーブルにどの列が増えたか」を見せるために件数と並べて返す。
    pub added_columns: Vec<String>,
    pub removed_columns: Vec<String>,
    pub changed_columns: Vec<String>,
    /// 追加/削除/変更されたインデックス名 (名前順)。
    pub added_indexes: Vec<String>,
    pub removed_indexes: Vec<String>,
    pub changed_indexes: Vec<String>,
}

/// 2 世代間の変化サマリ全体。変化のあったテーブルのみ、名前順。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DriftSummary {
    pub tables: Vec<TableChangeSummary>,
}

/// 決定的な短いハッシュ (FNV-1a, 32bit) を 8 桁の 16 進文字列で返す。dedupe 目的の
/// 内容フィンガープリント専用で暗号学的な強度は不要。`std` の `DefaultHasher` は
/// リリース間で値が変わりうるため、ディスクに保存して比較する用途には使えない。
pub fn fnv1a32(input: &[u8]) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for b in input {
        hash ^= u32::from(*b);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// ペイロードの直列化 JSON。フィンガープリントとサイズ判定の共通入力。
pub fn serialize_payload(payload: &SnapshotPayload) -> Result<String> {
    Ok(serde_json::to_string(payload)?)
}

/// ペイロードの内容フィンガープリント (直列化 JSON の FNV-1a)。
pub fn fingerprint_payload(payload: &SnapshotPayload) -> Result<String> {
    Ok(fnv1a32(serialize_payload(payload)?.as_bytes()))
}

/// 一括取得した列・インデックスからペイロードを組み立てる (純粋)。テーブルを名前順に
/// 正規化するため、ドライバの返却順に依らずフィンガープリントが安定する。
/// インデックスを持たないテーブルは空配列になる。
pub fn build_payload(
    driver: DriverKind,
    database: &str,
    columns: Vec<TableColumns>,
    indexes: Vec<TableIndexes>,
) -> SnapshotPayload {
    let mut by_table: HashMap<String, Vec<IndexInfo>> =
        indexes.into_iter().map(|t| (t.name, t.indexes)).collect();
    let mut tables: Vec<SnapshotTable> = columns
        .into_iter()
        .map(|t| SnapshotTable {
            indexes: by_table.remove(&t.name).unwrap_or_default(),
            name: t.name,
            columns: t.columns,
        })
        .collect();
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    SnapshotPayload {
        driver,
        database: database.to_string(),
        tables,
    }
}

/// 接続から `database` のスキーマスナップショットを取得する。列とインデックスを
/// それぞれ 1 クエリで DB 全体ぶん取る (テーブル数に比例した往復をしない)。
/// キャッシュは経由せず常にドライバへ直接問い合わせる (変化の検知が目的のため)。
pub async fn capture_payload(conn: &Connection, database: &str) -> Result<SnapshotPayload> {
    let (columns, indexes) = tokio::join!(
        conn.columns_for_database(database),
        conn.indexes_for_database(database)
    );
    Ok(build_payload(
        conn.driver_kind(),
        database,
        columns?,
        indexes?,
    ))
}

/// インデックスの実質的な定義 (名前は除く)。
fn index_shape(idx: &IndexInfo) -> (&[String], bool, bool, Option<&str>) {
    (&idx.columns, idx.unique, idx.primary, idx.method.as_deref())
}

/// 2 世代間でインデックスの追加/削除/変更を検出する (純粋)。両世代に存在する
/// テーブルのみを対象にする — テーブル自体の追加/削除は `compute_schema_diff` が
/// 一段上のレベルで報告するため、ここで二重に数えない。
pub fn diff_indexes(prev: &SnapshotPayload, next: &SnapshotPayload) -> Vec<IndexDriftEntry> {
    let prev_by_table: HashMap<&str, &SnapshotTable> =
        prev.tables.iter().map(|t| (t.name.as_str(), t)).collect();
    let mut entries = Vec::new();
    for next_table in &next.tables {
        let Some(prev_table) = prev_by_table.get(next_table.name.as_str()) else {
            continue;
        };
        let prev_idx: HashMap<&str, &IndexInfo> = prev_table
            .indexes
            .iter()
            .map(|i| (i.name.as_str(), i))
            .collect();
        let next_idx: HashMap<&str, &IndexInfo> = next_table
            .indexes
            .iter()
            .map(|i| (i.name.as_str(), i))
            .collect();
        for (name, idx) in &next_idx {
            match prev_idx.get(name) {
                None => entries.push(IndexDriftEntry {
                    table: next_table.name.clone(),
                    index_name: (*name).to_string(),
                    status: IndexDriftStatus::Added,
                }),
                Some(old) if index_shape(old) != index_shape(idx) => {
                    entries.push(IndexDriftEntry {
                        table: next_table.name.clone(),
                        index_name: (*name).to_string(),
                        status: IndexDriftStatus::Changed,
                    })
                }
                Some(_) => {}
            }
        }
        for name in prev_idx.keys() {
            if !next_idx.contains_key(name) {
                entries.push(IndexDriftEntry {
                    table: next_table.name.clone(),
                    index_name: (*name).to_string(),
                    status: IndexDriftStatus::Removed,
                });
            }
        }
    }
    entries.sort_by(|a, b| (&a.table, &a.index_name).cmp(&(&b.table, &b.index_name)));
    entries
}

/// `compute_schema_diff` の結果とインデックス差分を突き合わせ、テーブル単位の
/// 変化サマリへ整形する (純粋)。変化がまったく無いテーブルは結果から除外する。
pub fn summarize_drift(diff: &SchemaDiff, index_drift: &[IndexDriftEntry]) -> DriftSummary {
    let mut by_table: HashMap<&str, Vec<&IndexDriftEntry>> = HashMap::new();
    for e in index_drift {
        by_table.entry(e.table.as_str()).or_default().push(e);
    }
    let mut tables = Vec::new();
    for t in &diff.tables {
        let idx = by_table.get(t.name.as_str());
        let count =
            |s: IndexDriftStatus| idx.map_or(0, |v| v.iter().filter(|e| e.status == s).count());
        let index_names = |st: IndexDriftStatus| -> Vec<String> {
            let mut v: Vec<String> = idx.map_or_else(Vec::new, |v| {
                v.iter()
                    .filter(|e| e.status == st)
                    .map(|e| e.index_name.clone())
                    .collect()
            });
            v.sort();
            v
        };
        let indexes_added = count(IndexDriftStatus::Added);
        let indexes_removed = count(IndexDriftStatus::Removed);
        let indexes_changed = count(IndexDriftStatus::Changed);
        let mut summary = TableChangeSummary {
            table: t.name.clone(),
            table_status: TableChangeStatus::Changed,
            columns_added: 0,
            columns_removed: 0,
            columns_changed: 0,
            indexes_added,
            indexes_removed,
            indexes_changed,
            added_columns: Vec::new(),
            removed_columns: Vec::new(),
            changed_columns: Vec::new(),
            added_indexes: index_names(IndexDriftStatus::Added),
            removed_indexes: index_names(IndexDriftStatus::Removed),
            changed_indexes: index_names(IndexDriftStatus::Changed),
        };
        match t.status {
            // source = 旧世代。旧にだけある = その後で削除された。
            DiffStatus::SourceOnly => summary.table_status = TableChangeStatus::Removed,
            DiffStatus::TargetOnly => summary.table_status = TableChangeStatus::Added,
            DiffStatus::Same | DiffStatus::Different => {
                let n = |s: DiffStatus| t.columns.iter().filter(|c| c.status == s).count();
                summary.columns_added = n(DiffStatus::TargetOnly);
                summary.columns_removed = n(DiffStatus::SourceOnly);
                summary.columns_changed = n(DiffStatus::Different);
                let names = |s: DiffStatus| -> Vec<String> {
                    let mut v: Vec<String> = t
                        .columns
                        .iter()
                        .filter(|c| c.status == s)
                        .map(|c| c.name.clone())
                        .collect();
                    v.sort();
                    v
                };
                summary.added_columns = names(DiffStatus::TargetOnly);
                summary.removed_columns = names(DiffStatus::SourceOnly);
                summary.changed_columns = names(DiffStatus::Different);
                let has_change = t.status == DiffStatus::Different
                    || indexes_added > 0
                    || indexes_removed > 0
                    || indexes_changed > 0;
                if !has_change {
                    continue;
                }
            }
        }
        tables.push(summary);
    }
    tables.sort_by(|a, b| a.table.cmp(&b.table));
    DriftSummary { tables }
}

/// 旧世代 `prev` から新世代 `next` への変化サマリ (列: `compute_schema_diff`、
/// インデックス: [`diff_indexes`])。
pub fn summarize_payloads(prev: &SnapshotPayload, next: &SnapshotPayload) -> DriftSummary {
    let to_columns = |p: &SnapshotPayload| -> Vec<TableColumns> {
        p.tables
            .iter()
            .map(|t| TableColumns {
                name: t.name.clone(),
                columns: t.columns.clone(),
            })
            .collect()
    };
    let diff = compute_schema_diff(
        prev.driver,
        next.driver,
        &to_columns(prev),
        &to_columns(next),
    );
    summarize_drift(&diff, &diff_indexes(prev, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn idx(name: &str, cols: &[&str], unique: bool) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            unique,
            primary: false,
            method: Some("BTREE".to_string()),
        }
    }

    fn table(name: &str, cols: Vec<TableColumnInfo>, indexes: Vec<IndexInfo>) -> SnapshotTable {
        SnapshotTable {
            name: name.to_string(),
            columns: cols,
            indexes,
        }
    }

    fn payload(tables: Vec<SnapshotTable>) -> SnapshotPayload {
        SnapshotPayload {
            driver: DriverKind::Mysql,
            database: "app".to_string(),
            tables,
        }
    }

    #[test]
    fn fnv1a32_matches_known_vectors() {
        // 標準的な FNV-1a 32bit のテストベクタ。
        assert_eq!(fnv1a32(b""), "811c9dc5");
        assert_eq!(fnv1a32(b"a"), "e40c292c");
        assert_eq!(fnv1a32(b"foobar"), "bf9cf968");
    }

    #[test]
    fn build_payload_sorts_tables_and_merges_indexes() {
        let columns = vec![
            TableColumns {
                name: "b".into(),
                columns: vec![col("id", "int")],
            },
            TableColumns {
                name: "a".into(),
                columns: vec![col("id", "int")],
            },
        ];
        let indexes = vec![TableIndexes {
            name: "b".into(),
            indexes: vec![idx("ix_b", &["id"], false)],
        }];
        let p = build_payload(DriverKind::Mysql, "app", columns, indexes);
        let names: Vec<&str> = p.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
        assert!(p.tables[0].indexes.is_empty());
        assert_eq!(p.tables[1].indexes.len(), 1);
    }

    #[test]
    fn fingerprint_is_stable_across_input_order_and_sensitive_to_content() {
        let a = build_payload(
            DriverKind::Mysql,
            "app",
            vec![
                TableColumns {
                    name: "b".into(),
                    columns: vec![col("id", "int")],
                },
                TableColumns {
                    name: "a".into(),
                    columns: vec![col("id", "int")],
                },
            ],
            vec![],
        );
        let b = build_payload(
            DriverKind::Mysql,
            "app",
            vec![
                TableColumns {
                    name: "a".into(),
                    columns: vec![col("id", "int")],
                },
                TableColumns {
                    name: "b".into(),
                    columns: vec![col("id", "int")],
                },
            ],
            vec![],
        );
        assert_eq!(
            fingerprint_payload(&a).unwrap(),
            fingerprint_payload(&b).unwrap()
        );
        let c = build_payload(
            DriverKind::Mysql,
            "app",
            vec![TableColumns {
                name: "a".into(),
                columns: vec![col("id", "bigint")],
            }],
            vec![],
        );
        assert_ne!(
            fingerprint_payload(&a).unwrap(),
            fingerprint_payload(&c).unwrap()
        );
    }

    #[test]
    fn diff_indexes_detects_added_removed_and_changed() {
        let prev = payload(vec![table(
            "orders",
            vec![col("id", "int")],
            vec![
                idx("ix_keep", &["id"], false),
                idx("ix_drop", &["id"], false),
                idx("ix_chg", &["id"], false),
            ],
        )]);
        let next = payload(vec![table(
            "orders",
            vec![col("id", "int")],
            vec![
                idx("ix_keep", &["id"], false),
                idx("ix_new", &["id"], false),
                idx("ix_chg", &["id"], true),
            ],
        )]);
        let got = diff_indexes(&prev, &next);
        assert_eq!(
            got,
            vec![
                IndexDriftEntry {
                    table: "orders".into(),
                    index_name: "ix_chg".into(),
                    status: IndexDriftStatus::Changed
                },
                IndexDriftEntry {
                    table: "orders".into(),
                    index_name: "ix_drop".into(),
                    status: IndexDriftStatus::Removed
                },
                IndexDriftEntry {
                    table: "orders".into(),
                    index_name: "ix_new".into(),
                    status: IndexDriftStatus::Added
                },
            ]
        );
    }

    #[test]
    fn diff_indexes_treats_method_and_primary_as_part_of_the_shape() {
        let mut changed = idx("ix", &["id"], false);
        changed.method = Some("HASH".into());
        let prev = payload(vec![table("t", vec![], vec![idx("ix", &["id"], false)])]);
        let next = payload(vec![table("t", vec![], vec![changed])]);
        assert_eq!(diff_indexes(&prev, &next).len(), 1);
        let mut primary = idx("ix", &["id"], false);
        primary.primary = true;
        let next = payload(vec![table("t", vec![], vec![primary])]);
        assert_eq!(diff_indexes(&prev, &next).len(), 1);
    }

    #[test]
    fn diff_indexes_ignores_tables_present_on_one_side_only() {
        let prev = payload(vec![table("gone", vec![], vec![idx("ix", &["id"], false)])]);
        let next = payload(vec![table(
            "fresh",
            vec![],
            vec![idx("ix", &["id"], false)],
        )]);
        assert!(diff_indexes(&prev, &next).is_empty());
    }

    #[test]
    fn summarize_reports_table_and_column_and_index_changes() {
        let prev = payload(vec![
            table(
                "orders",
                vec![col("id", "int"), col("legacy", "int")],
                vec![idx("ix_a", &["id"], false)],
            ),
            table("same", vec![col("id", "int")], vec![]),
            table("removed", vec![col("id", "int")], vec![]),
        ]);
        let next = payload(vec![
            table(
                "orders",
                vec![col("id", "bigint"), col("total", "int")],
                vec![idx("ix_a", &["id"], false), idx("ix_b", &["total"], false)],
            ),
            table("same", vec![col("id", "int")], vec![]),
            table("added", vec![col("id", "int")], vec![]),
        ]);
        let s = summarize_payloads(&prev, &next);
        let find = |n: &str| s.tables.iter().find(|t| t.table == n);
        assert!(find("same").is_none(), "unchanged tables are omitted");
        assert_eq!(
            find("added").map(|t| t.table_status),
            Some(TableChangeStatus::Added)
        );
        assert_eq!(
            find("removed").map(|t| t.table_status),
            Some(TableChangeStatus::Removed)
        );
        let orders = find("orders").expect("orders changed");
        assert_eq!(orders.table_status, TableChangeStatus::Changed);
        assert_eq!(orders.columns_added, 1);
        assert_eq!(orders.columns_removed, 1);
        assert_eq!(orders.columns_changed, 1);
        assert_eq!(orders.indexes_added, 1);
        assert_eq!(orders.indexes_removed, 0);
        assert_eq!(orders.added_columns, ["total"]);
        assert_eq!(orders.removed_columns, ["legacy"]);
        assert_eq!(orders.changed_columns, ["id"]);
        assert_eq!(orders.added_indexes, ["ix_b"]);
        assert!(orders.removed_indexes.is_empty());
        let names: Vec<&str> = s.tables.iter().map(|t| t.table.as_str()).collect();
        assert_eq!(names, ["added", "orders", "removed"]);
    }

    #[test]
    fn summarize_flags_index_only_change_as_a_changed_table() {
        let prev = payload(vec![table("t", vec![col("id", "int")], vec![])]);
        let next = payload(vec![table(
            "t",
            vec![col("id", "int")],
            vec![idx("ix", &["id"], false)],
        )]);
        let s = summarize_payloads(&prev, &next);
        assert_eq!(s.tables.len(), 1);
        assert_eq!(s.tables[0].indexes_added, 1);
        assert_eq!(s.tables[0].columns_added, 0);
    }

    #[test]
    fn summary_serializes_with_camel_case_fields() {
        let prev = payload(vec![]);
        let next = payload(vec![table("t", vec![col("id", "int")], vec![])]);
        let v = serde_json::to_value(summarize_payloads(&prev, &next)).unwrap();
        assert_eq!(v["tables"][0]["tableStatus"], "added");
        assert_eq!(v["tables"][0]["columnsAdded"], 0);
    }
}
