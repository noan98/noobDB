//! スキーマ一括取得の結果を画面向けに束ねる純ロジック (#1255)。
//!
//! テーブル統計ダッシュボード (サイズ + 列数・インデックス数・PK 有無・FK 数) と、
//! 結果グリッドの逆方向 FK ジャンプ (「このテーブルを参照している子テーブル」)。
//! どちらも以前はフロント (`tableSize.ts` の `buildTableStatRows` /
//! `fkNavigation.ts` の `incomingForeignKeys`) が IPC の戻り値を JS で結合して
//! いた。N+1 の IPC をやめるのと同時に、この結合も Rust へ移した。I/O を持たない
//! 純関数なので、ドライバなしでテストできる。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::diff::TableColumns;
use super::types::{ForeignKey, TableIndexes, TableSizeInfo};

/// 1 テーブルのサイズ + 構造統計 (テーブル統計ダッシュボード、#562 / #660)。
///
/// サイズ・行数は [`TableSizeInfo`] と同じ意味 (エンジンが報告しなければ `None`)。
/// 構造メタは一括取得した列・インデックス・FK から合成する。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableStatistic {
    pub name: String,
    pub row_estimate: Option<i64>,
    pub data_bytes: Option<i64>,
    pub index_bytes: Option<i64>,
    pub total_bytes: Option<i64>,
    /// 列数。列メタデータが無いテーブル (PostgreSQL のマテビューなど) は `None`
    /// (「不明」と「0」を区別する)。
    pub column_count: Option<i64>,
    /// インデックス数 (PRIMARY を含む)。
    pub index_count: i64,
    /// PRIMARY KEY を持つか (インデックスに `primary` が 1 件でもあれば true)。
    pub has_primary_key: bool,
    /// 外部キー (制約単位) の数。
    pub foreign_key_count: i64,
}

/// 外部キー行 (参照列 1 件につき 1 行、複合キーは `constraint_name` を共有) を、
/// テーブルごとの**制約単位**の件数に畳み込む。制約名を持たない行 (一部の SQLite)
/// は「参照列→参照先」の組を一意キーにして数える。
pub fn foreign_key_counts(fks: &[ForeignKey]) -> HashMap<&str, i64> {
    let mut per_table: HashMap<&str, HashSet<String>> = HashMap::new();
    for fk in fks {
        let key = fk.constraint_name.clone().unwrap_or_else(|| {
            format!(
                "{}->{}.{}",
                fk.column,
                fk.referenced_table,
                fk.referenced_column.as_deref().unwrap_or("")
            )
        });
        per_table.entry(fk.table.as_str()).or_default().insert(key);
    }
    per_table
        .into_iter()
        .map(|(t, set)| (t, set.len() as i64))
        .collect()
}

/// サイズ一覧を基準に、列数・インデックス・FK を名前で突き合わせて統計行を作る。
/// テーブル集合と並びは `sizes` (サイズダッシュボードの対象 = ベーステーブル) に
/// 従う。FK は全テーブルを走査した結果なので、1 件も無いテーブルは「不明」では
/// なく 0。インデックスも同様に、一括取得に現れないテーブルは 0 件 / PK 無し。
pub fn build_table_statistics(
    sizes: Vec<TableSizeInfo>,
    columns: &[TableColumns],
    indexes: &[TableIndexes],
    foreign_keys: &[ForeignKey],
) -> Vec<TableStatistic> {
    let column_counts: HashMap<&str, i64> = columns
        .iter()
        .map(|t| (t.name.as_str(), t.columns.len() as i64))
        .collect();
    let index_by_table: HashMap<&str, &TableIndexes> =
        indexes.iter().map(|t| (t.name.as_str(), t)).collect();
    let fk_counts = foreign_key_counts(foreign_keys);
    sizes
        .into_iter()
        .map(|s| {
            let idx = index_by_table.get(s.name.as_str());
            TableStatistic {
                column_count: column_counts.get(s.name.as_str()).copied(),
                index_count: idx.map_or(0, |t| t.indexes.len() as i64),
                has_primary_key: idx.is_some_and(|t| t.indexes.iter().any(|i| i.primary)),
                foreign_key_count: fk_counts.get(s.name.as_str()).copied().unwrap_or(0),
                name: s.name,
                row_estimate: s.row_estimate,
                data_bytes: s.data_bytes,
                index_bytes: s.index_bytes,
                total_bytes: s.total_bytes,
            }
        })
        .collect()
}

/// `table` を参照している子テーブル側の外部キー 1 件 (逆参照)。結果グリッドの
/// 「参照している行へジャンプ」(#621) の材料。フロントの `IncomingFk` と同じ
/// camelCase で送る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingForeignKey {
    /// FK を持つ子テーブル。
    pub table: String,
    /// 現在のテーブルを参照している子テーブルのカラム。
    pub column: String,
    /// 子テーブルが指す、現在 (参照先) テーブル側のカラム。
    pub referenced_column: String,
}

/// `table` を参照している外部キー (逆参照) を抽出する。参照先カラムが不明な
/// エントリは結合キーを解決できないため除外する。
pub fn incoming_foreign_keys(all: &[ForeignKey], table: &str) -> Vec<IncomingForeignKey> {
    all.iter()
        .filter(|fk| fk.referenced_table == table)
        .filter_map(|fk| {
            let referenced_column = fk.referenced_column.as_ref()?;
            if referenced_column.is_empty() {
                return None;
            }
            Some(IncomingForeignKey {
                table: fk.table.clone(),
                column: fk.column.clone(),
                referenced_column: referenced_column.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::{IndexInfo, TableColumnInfo};

    fn size(name: &str) -> TableSizeInfo {
        TableSizeInfo {
            name: name.to_string(),
            row_estimate: Some(10),
            data_bytes: Some(100),
            index_bytes: Some(20),
            total_bytes: Some(120),
        }
    }

    fn col(name: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: "int".into(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn fk(
        table: &str,
        column: &str,
        to: &str,
        to_col: Option<&str>,
        name: Option<&str>,
    ) -> ForeignKey {
        ForeignKey {
            table: table.to_string(),
            column: column.to_string(),
            referenced_table: to.to_string(),
            referenced_column: to_col.map(str::to_string),
            constraint_name: name.map(str::to_string),
        }
    }

    fn index(name: &str, primary: bool) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: vec!["id".into()],
            unique: primary,
            primary,
            method: None,
        }
    }

    #[test]
    fn composite_fk_counts_as_one_constraint() {
        let fks = vec![
            fk("orders", "a", "p", Some("x"), Some("fk1")),
            fk("orders", "b", "p", Some("y"), Some("fk1")),
            fk("orders", "c", "q", Some("z"), Some("fk2")),
            fk("items", "o", "orders", Some("id"), Some("fk3")),
        ];
        let counts = foreign_key_counts(&fks);
        assert_eq!(counts.get("orders"), Some(&2));
        assert_eq!(counts.get("items"), Some(&1));
        assert_eq!(counts.get("none"), None);
    }

    #[test]
    fn fk_without_constraint_name_is_keyed_by_column_and_target() {
        let fks = vec![
            fk("t", "a", "p", Some("id"), None),
            fk("t", "a", "p", Some("id"), None),
            fk("t", "b", "p", Some("id"), None),
        ];
        assert_eq!(foreign_key_counts(&fks).get("t"), Some(&2));
    }

    #[test]
    fn statistics_join_sizes_columns_indexes_and_fks_by_name() {
        let sizes = vec![size("users"), size("orders"), size("ghost")];
        let columns = vec![
            TableColumns {
                name: "users".into(),
                columns: vec![col("id"), col("name")],
            },
            TableColumns {
                name: "orders".into(),
                columns: vec![col("id")],
            },
        ];
        let indexes = vec![TableIndexes {
            name: "users".into(),
            indexes: vec![index("PRIMARY", true), index("idx_name", false)],
        }];
        let fks = vec![fk("orders", "user_id", "users", Some("id"), Some("fk_u"))];
        let rows = build_table_statistics(sizes, &columns, &indexes, &fks);
        assert_eq!(rows.len(), 3);
        // 並びは sizes に従う。
        assert_eq!(rows[0].name, "users");
        assert_eq!(rows[0].column_count, Some(2));
        assert_eq!(rows[0].index_count, 2);
        assert!(rows[0].has_primary_key);
        assert_eq!(rows[0].foreign_key_count, 0);
        assert_eq!(rows[0].total_bytes, Some(120));
        // インデックスが無いテーブルは 0 件 / PK 無し、FK は制約単位。
        assert_eq!(rows[1].name, "orders");
        assert_eq!(rows[1].index_count, 0);
        assert!(!rows[1].has_primary_key);
        assert_eq!(rows[1].foreign_key_count, 1);
        // 列メタデータに無いテーブルの列数は「不明」。
        assert_eq!(rows[2].name, "ghost");
        assert_eq!(rows[2].column_count, None);
    }

    #[test]
    fn unique_only_indexes_do_not_imply_a_primary_key() {
        let indexes = vec![TableIndexes {
            name: "t".into(),
            indexes: vec![index("uq", false)],
        }];
        let rows = build_table_statistics(vec![size("t")], &[], &indexes, &[]);
        assert_eq!(rows[0].index_count, 1);
        assert!(!rows[0].has_primary_key);
    }

    #[test]
    fn incoming_fks_keep_only_references_to_the_table() {
        let fks = vec![
            fk("orders", "user_id", "users", Some("id"), None),
            fk("posts", "author_id", "users", Some("id"), None),
            fk("orders", "product_id", "products", Some("id"), None),
        ];
        let got = incoming_foreign_keys(&fks, "users");
        assert_eq!(
            got,
            vec![
                IncomingForeignKey {
                    table: "orders".into(),
                    column: "user_id".into(),
                    referenced_column: "id".into(),
                },
                IncomingForeignKey {
                    table: "posts".into(),
                    column: "author_id".into(),
                    referenced_column: "id".into(),
                },
            ]
        );
    }

    #[test]
    fn incoming_fks_skip_unresolved_referenced_columns() {
        let fks = vec![
            fk("a", "x", "users", None, None),
            fk("b", "y", "users", Some(""), None),
        ];
        assert!(incoming_foreign_keys(&fks, "users").is_empty());
        assert!(incoming_foreign_keys(&fks, "nowhere").is_empty());
    }

    #[test]
    fn incoming_fk_serializes_referenced_column_in_camel_case() {
        let v = serde_json::to_value(IncomingForeignKey {
            table: "o".into(),
            column: "u".into(),
            referenced_column: "id".into(),
        })
        .unwrap_or_default();
        assert_eq!(v["referencedColumn"], "id");
    }
}
