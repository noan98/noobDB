//! インポートの競合モード (UPSERT) の SQL 生成 (#972)。
//!
//! インポートは従来 INSERT 専用だった。同じ CSV を繰り返し取り込む「マスター
//! データ同期」用途のため、ユーザが指定したキー列集合で競合を判定し、
//!
//! - `skip`   … 既存キーの行は何もしない (DO NOTHING 相当)
//! - `update` … 既存キーの行を取り込み値で更新する (DO UPDATE 相当)
//!
//! を選べるようにする。方言ごとの構文差はすべてこのモジュールの**純関数**に
//! 閉じ込め、各ドライバは「従来の INSERT 文 + ここで作った接尾辞」または
//! 「MSSQL の MERGE 文」を実行するだけにする (ドライバ側は接続・バインドのみ)。
//!
//! | 方言 | skip | update |
//! |---|---|---|
//! | MySQL | `ON DUPLICATE KEY UPDATE k = k` (no-op) | `ON DUPLICATE KEY UPDATE c = VALUES(c)` |
//! | PostgreSQL / SQLite / DuckDB | `ON CONFLICT (keys) DO NOTHING` | `ON CONFLICT (keys) DO UPDATE SET c = EXCLUDED.c` |
//! | SQL Server | `MERGE … WHEN NOT MATCHED BY TARGET THEN INSERT` | 上に加えて `WHEN MATCHED THEN UPDATE SET` |
//!
//! MySQL の skip に `INSERT IGNORE` を使わないのは、IGNORE が重複キー以外の
//! エラー (型変換・NOT NULL 違反など) まで警告に格下げして黙って取り込んでしまい、
//! #687 の abort/skip の行エラー処理を素通りさせるため。

use std::borrow::Cow;
use std::collections::HashMap;

use serde::Deserialize;

use super::sync::quote_ident;
use super::DriverKind;
use crate::error::{AppError, Result};

/// 既存キーと衝突した行の扱い。既定 `Insert` は従来どおりの素の INSERT
/// (競合はエラー) で、フィールドを送らない古いリクエストとの後方互換を保つ。
#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictMode {
    /// 素の INSERT。キー重複は DB エラー (= #687 の abort/skip で処理)。
    #[default]
    Insert,
    /// 既存キーの行は変更せず読み飛ばす。
    Skip,
    /// 既存キーの行を取り込み値で更新する。
    Update,
}

/// インポート 1 回分の競合設定。`key_columns` は競合判定に使う列
/// (インポート対象列の部分集合)。`mode == Insert` のときは無視される。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportConflict {
    pub mode: ConflictMode,
    pub key_columns: Vec<String>,
}

impl ImportConflict {
    /// 従来の INSERT 専用設定 (サンドボックス取り込みなど競合を扱わない経路用)。
    pub fn insert_only() -> Self {
        Self::default()
    }

    pub fn is_upsert(&self) -> bool {
        self.mode != ConflictMode::Insert
    }

    /// 設定がインポート対象列と整合しているかを検証する。UPSERT モードでは
    /// キー列が 1 つ以上あり、重複がなく、すべてインポート対象列に含まれている
    /// 必要がある (取り込まない列をキーにしても比較する値が無い)。
    pub fn validate(&self, columns: &[String]) -> Result<()> {
        if !self.is_upsert() {
            return Ok(());
        }
        if self.key_columns.is_empty() {
            return Err(AppError::InvalidInput(
                "conflict mode requires at least one key column".into(),
            ));
        }
        for (i, key) in self.key_columns.iter().enumerate() {
            if self.key_columns[..i].contains(key) {
                return Err(AppError::InvalidInput(format!(
                    "duplicate key column: {key}"
                )));
            }
            if !columns.contains(key) {
                return Err(AppError::InvalidInput(format!(
                    "key column is not among the imported columns: {key}"
                )));
            }
        }
        Ok(())
    }

    /// キー列の `columns` 内の位置。`validate` 済みを前提とし、見つからない
    /// キーは単に無視する (パニックしない)。
    fn key_indices(&self, columns: &[String]) -> Vec<usize> {
        self.key_columns
            .iter()
            .filter_map(|k| columns.iter().position(|c| c == k))
            .collect()
    }

    /// 更新対象 (= キー以外) の列。
    fn non_key_columns<'a>(&self, columns: &'a [String]) -> Vec<&'a String> {
        columns
            .iter()
            .filter(|c| !self.key_columns.contains(c))
            .collect()
    }

    /// 1 文の中で同じキーが複数回現れる行を 1 行に畳む。
    ///
    /// PostgreSQL / DuckDB の `ON CONFLICT DO UPDATE` と SQL Server の `MERGE` は、
    /// 1 文の中で同じ行を二度更新しようとするとエラーにする ("cannot affect row a
    /// second time")。1 行ずつ順に適用したときと同じ結果になるよう、
    /// `update` は**最後の行が勝ち**、`skip` は**最初の行が勝つ** (後続は既存
    /// キーとして読み飛ばされるため)。畳まれた行は元の出現位置の順を保つ。
    ///
    /// 重複が無ければ (大半のケース) 複製せず借用のまま返す。キーの比較は
    /// ファイル上のテキスト完全一致 (`NULL` 同士は同一視しない — SQL の一意性と同じ)。
    pub fn collapse_duplicate_keys<'a>(
        &self,
        columns: &[String],
        rows: &'a [Vec<Option<String>>],
    ) -> Cow<'a, [Vec<Option<String>>]> {
        if !self.is_upsert() || rows.len() < 2 {
            return Cow::Borrowed(rows);
        }
        let idx = self.key_indices(columns);
        if idx.is_empty() {
            return Cow::Borrowed(rows);
        }
        // キー → 採用する行番号。
        let mut chosen: HashMap<Vec<&str>, usize> = HashMap::with_capacity(rows.len());
        let mut keep = vec![true; rows.len()];
        let mut any_dup = false;
        for (ri, row) in rows.iter().enumerate() {
            let mut key: Vec<&str> = Vec::with_capacity(idx.len());
            let mut has_null = false;
            for &ci in &idx {
                match row.get(ci).and_then(|c| c.as_deref()) {
                    Some(v) => key.push(v),
                    None => {
                        has_null = true;
                        break;
                    }
                }
            }
            if has_null {
                continue;
            }
            match chosen.get_mut(&key) {
                None => {
                    chosen.insert(key, ri);
                }
                Some(prev) => {
                    any_dup = true;
                    match self.mode {
                        ConflictMode::Update => {
                            keep[*prev] = false;
                            *prev = ri;
                        }
                        _ => keep[ri] = false,
                    }
                }
            }
        }
        if !any_dup {
            return Cow::Borrowed(rows);
        }
        Cow::Owned(
            rows.iter()
                .zip(keep)
                .filter(|(_, k)| *k)
                .map(|(r, _)| r.clone())
                .collect(),
        )
    }
}

/// MySQL / PostgreSQL / SQLite / DuckDB の `INSERT … VALUES (…)` の**後ろに付ける**
/// 競合句 (先頭に空白を含む)。`Insert` モードと SQL Server (MERGE を使う) は空文字。
pub fn conflict_clause(
    driver: DriverKind,
    columns: &[String],
    conflict: &ImportConflict,
) -> String {
    if !conflict.is_upsert() {
        return String::new();
    }
    let q = |c: &str| quote_ident(driver, c);
    let updates = conflict.non_key_columns(columns);
    let do_update = conflict.mode == ConflictMode::Update && !updates.is_empty();
    match driver {
        DriverKind::Mysql => {
            // ON DUPLICATE KEY はテーブルの全一意キーで判定する (キー列の指定は
            // 構文に現れない)。キー列はここでは「更新しない列」を決めるのに使う。
            // `VALUES(col)` は 8.0.20 で非推奨だが MariaDB 互換のため行エイリアス
            // (`AS new`) ではなくこちらを使う。
            let set = if do_update {
                updates
                    .iter()
                    .map(|c| format!("{0} = VALUES({0})", q(c)))
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                // 何も変えない代入で「既存行は読み飛ばす」を表す。
                let k = conflict
                    .key_columns
                    .first()
                    .map(String::as_str)
                    .or_else(|| columns.first().map(String::as_str))
                    .unwrap_or_default();
                format!("{0} = {0}", q(k))
            };
            format!(" ON DUPLICATE KEY UPDATE {set}")
        }
        DriverKind::Postgres | DriverKind::Sqlite | DriverKind::DuckDb => {
            let keys = conflict
                .key_columns
                .iter()
                .map(|k| q(k))
                .collect::<Vec<_>>()
                .join(", ");
            if do_update {
                let set = updates
                    .iter()
                    .map(|c| format!("{0} = EXCLUDED.{0}", q(c)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(" ON CONFLICT ({keys}) DO UPDATE SET {set}")
            } else {
                format!(" ON CONFLICT ({keys}) DO NOTHING")
            }
        }
        DriverKind::Mssql => String::new(),
    }
}

/// SQL Server のリテラル。`NULL` は型付きにする: `VALUES` 表構築子の列型は全行の
/// 型から決まるため、列が全行 NULL だと `int` になり、`date` 列などへの暗黙変換で
/// "Operand type clash" になる。`NVARCHAR(MAX)` はほぼ全型へ暗黙変換できる。
fn mssql_merge_literal(cell: Option<&str>) -> String {
    match cell {
        None => "CAST(NULL AS NVARCHAR(MAX))".to_string(),
        Some(s) => format!("N'{}'", s.replace('\'', "''")),
    }
}

/// SQL Server 用の UPSERT (`MERGE`) 文を組み立てる。値はドライバの INSERT と
/// 同じく N'…' リテラルで埋め込み、SQL Server の暗黙変換で列型へ寄せる。
///
/// ```sql
/// MERGE INTO [t] WITH (HOLDLOCK) AS tgt
/// USING (VALUES (N'1',N'a')) AS src ([id], [name])
/// ON tgt.[id] = src.[id]
/// WHEN MATCHED THEN UPDATE SET tgt.[name] = src.[name]
/// WHEN NOT MATCHED BY TARGET THEN INSERT ([id], [name]) VALUES (src.[id], src.[name]);
/// ```
///
/// `HOLDLOCK` は MERGE の既知の競合 (同時実行で一意制約違反) を避ける定石。
/// `rows` は [`ImportConflict::collapse_duplicate_keys`] で畳んだ後のものを渡す
/// (MERGE はソース側のキー重複をエラーにする)。
pub fn mssql_merge_sql(
    table: &str,
    columns: &[String],
    conflict: &ImportConflict,
    rows: &[Vec<Option<String>>],
) -> String {
    let q = |c: &str| quote_ident(DriverKind::Mssql, c);
    let cols = columns.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
    let mut values = String::new();
    for (r, row) in rows.iter().enumerate() {
        if r > 0 {
            values.push(',');
        }
        values.push('(');
        for ci in 0..columns.len() {
            if ci > 0 {
                values.push(',');
            }
            values.push_str(&mssql_merge_literal(row.get(ci).and_then(|c| c.as_deref())));
        }
        values.push(')');
    }
    let on = conflict
        .key_columns
        .iter()
        .map(|k| format!("tgt.{0} = src.{0}", q(k)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let updates = conflict.non_key_columns(columns);
    let matched = if conflict.mode == ConflictMode::Update && !updates.is_empty() {
        format!(
            " WHEN MATCHED THEN UPDATE SET {}",
            updates
                .iter()
                .map(|c| format!("tgt.{0} = src.{0}", q(c)))
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        String::new()
    };
    let src_cols = columns
        .iter()
        .map(|c| format!("src.{}", q(c)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "MERGE INTO {table} WITH (HOLDLOCK) AS tgt USING (VALUES {values}) AS src ({cols}) \
         ON {on}{matched} WHEN NOT MATCHED BY TARGET THEN INSERT ({cols}) VALUES ({src_cols});",
        table = q(table),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn conflict(mode: ConflictMode, keys: &[&str]) -> ImportConflict {
        ImportConflict {
            mode,
            key_columns: cols(keys),
        }
    }

    fn row(cells: &[Option<&str>]) -> Vec<Option<String>> {
        cells.iter().map(|c| c.map(str::to_string)).collect()
    }

    #[test]
    fn insert_mode_has_no_clause_for_any_driver() {
        let c = cols(&["id", "name"]);
        for d in [
            DriverKind::Mysql,
            DriverKind::Postgres,
            DriverKind::Sqlite,
            DriverKind::DuckDb,
            DriverKind::Mssql,
        ] {
            assert_eq!(conflict_clause(d, &c, &ImportConflict::insert_only()), "");
        }
    }

    #[test]
    fn mysql_update_uses_on_duplicate_key_update_values() {
        let c = cols(&["id", "name", "age"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Mysql,
                &c,
                &conflict(ConflictMode::Update, &["id"])
            ),
            " ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `age` = VALUES(`age`)"
        );
    }

    #[test]
    fn mysql_skip_is_a_no_op_assignment_not_insert_ignore() {
        let c = cols(&["id", "name"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Mysql,
                &c,
                &conflict(ConflictMode::Skip, &["id"])
            ),
            " ON DUPLICATE KEY UPDATE `id` = `id`"
        );
    }

    #[test]
    fn mysql_update_with_only_key_columns_degrades_to_skip() {
        let c = cols(&["a", "b"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Mysql,
                &c,
                &conflict(ConflictMode::Update, &["a", "b"])
            ),
            " ON DUPLICATE KEY UPDATE `a` = `a`"
        );
    }

    #[test]
    fn postgres_sqlite_duckdb_use_on_conflict() {
        let c = cols(&["id", "name"]);
        for d in [DriverKind::Postgres, DriverKind::Sqlite, DriverKind::DuckDb] {
            assert_eq!(
                conflict_clause(d, &c, &conflict(ConflictMode::Update, &["id"])),
                " ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\""
            );
            assert_eq!(
                conflict_clause(d, &c, &conflict(ConflictMode::Skip, &["id"])),
                " ON CONFLICT (\"id\") DO NOTHING"
            );
        }
    }

    #[test]
    fn on_conflict_composite_key_and_quoting() {
        let c = cols(&["a\"x", "b", "v"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Postgres,
                &c,
                &conflict(ConflictMode::Update, &["a\"x", "b"])
            ),
            " ON CONFLICT (\"a\"\"x\", \"b\") DO UPDATE SET \"v\" = EXCLUDED.\"v\""
        );
    }

    #[test]
    fn on_conflict_update_with_only_keys_is_do_nothing() {
        let c = cols(&["id"]);
        assert_eq!(
            conflict_clause(
                DriverKind::Sqlite,
                &c,
                &conflict(ConflictMode::Update, &["id"])
            ),
            " ON CONFLICT (\"id\") DO NOTHING"
        );
    }

    #[test]
    fn mssql_merge_update() {
        let c = cols(&["id", "name"]);
        let rows = vec![row(&[Some("1"), Some("a'b")]), row(&[Some("2"), None])];
        assert_eq!(
            mssql_merge_sql("t", &c, &conflict(ConflictMode::Update, &["id"]), &rows),
            "MERGE INTO [t] WITH (HOLDLOCK) AS tgt USING (VALUES (N'1',N'a''b'),\
             (N'2',CAST(NULL AS NVARCHAR(MAX)))) AS src ([id], [name]) \
             ON tgt.[id] = src.[id] WHEN MATCHED THEN UPDATE SET tgt.[name] = src.[name] \
             WHEN NOT MATCHED BY TARGET THEN INSERT ([id], [name]) VALUES (src.[id], src.[name]);"
        );
    }

    #[test]
    fn mssql_merge_skip_has_no_matched_branch_and_composite_on() {
        let c = cols(&["a", "b", "v"]);
        let rows = vec![row(&[Some("1"), Some("2"), Some("x")])];
        let sql = mssql_merge_sql("s]t", &c, &conflict(ConflictMode::Skip, &["a", "b"]), &rows);
        assert!(sql.starts_with("MERGE INTO [s]]t] WITH (HOLDLOCK)"));
        assert!(sql.contains("ON tgt.[a] = src.[a] AND tgt.[b] = src.[b] WHEN NOT MATCHED"));
        assert!(!sql.contains("WHEN MATCHED THEN"));
        assert!(sql.ends_with(';'));
    }

    #[test]
    fn validate_rules() {
        let c = cols(&["id", "name"]);
        assert!(ImportConflict::insert_only().validate(&c).is_ok());
        assert!(conflict(ConflictMode::Update, &["id"]).validate(&c).is_ok());
        assert!(conflict(ConflictMode::Update, &[]).validate(&c).is_err());
        assert!(conflict(ConflictMode::Skip, &["missing"])
            .validate(&c)
            .is_err());
        assert!(conflict(ConflictMode::Skip, &["id", "id"])
            .validate(&c)
            .is_err());
        // Insert モードではキー列の内容を問わない (無視される)。
        assert!(conflict(ConflictMode::Insert, &["missing"])
            .validate(&c)
            .is_ok());
    }

    #[test]
    fn collapse_update_keeps_last_occurrence_skip_keeps_first() {
        let c = cols(&["id", "v"]);
        let rows = vec![
            row(&[Some("1"), Some("a")]),
            row(&[Some("2"), Some("b")]),
            row(&[Some("1"), Some("c")]),
        ];
        let up = conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows);
        assert_eq!(
            up.as_ref(),
            &[row(&[Some("2"), Some("b")]), row(&[Some("1"), Some("c")])]
        );
        let sk = conflict(ConflictMode::Skip, &["id"]).collapse_duplicate_keys(&c, &rows);
        assert_eq!(
            sk.as_ref(),
            &[row(&[Some("1"), Some("a")]), row(&[Some("2"), Some("b")])]
        );
    }

    #[test]
    fn collapse_borrows_when_no_duplicates_or_insert_mode_and_ignores_null_keys() {
        let c = cols(&["id", "v"]);
        let rows = vec![row(&[None, Some("a")]), row(&[None, Some("b")])];
        assert!(matches!(
            conflict(ConflictMode::Update, &["id"]).collapse_duplicate_keys(&c, &rows),
            Cow::Borrowed(_)
        ));
        let dup = vec![row(&[Some("1"), Some("a")]), row(&[Some("1"), Some("b")])];
        assert!(matches!(
            ImportConflict::insert_only().collapse_duplicate_keys(&c, &dup),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn collapse_composite_key() {
        let c = cols(&["a", "b", "v"]);
        let rows = vec![
            row(&[Some("1"), Some("x"), Some("p")]),
            row(&[Some("1"), Some("y"), Some("q")]),
            row(&[Some("1"), Some("x"), Some("r")]),
        ];
        let out = conflict(ConflictMode::Update, &["a", "b"]).collapse_duplicate_keys(&c, &rows);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], row(&[Some("1"), Some("x"), Some("r")]));
    }
}
