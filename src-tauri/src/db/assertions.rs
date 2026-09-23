//! データ品質アサーション (#742) のルール → 読み取り専用 SQL 変換と判定。
//!
//! **副作用なしの純ロジック**。ドライバ非依存で、方言の差は識別子クォート
//! (`sync::quote_ident`) と値のリテラル化 (`data_diff::sql_literal`) を共有して
//! 吸収する (SQL のレンダリングを二重実装しない — `noobdb-features` の方針)。
//!
//! 1 ルールにつき 2 本の SQL を生成する:
//!
//! - `check_sql` — 1 行 1 列の件数を返す集計クエリ。ルールごとの意味は
//!   [`build_sql`] を参照。`row_count` 以外は「違反件数」で、0 なら pass。
//! - `violations_sql` — 違反の中身を見るためのクエリ。UI は fail から**実行せずに**
//!   新規タブで開き、利用者が SQL を確認してから実行する。
//!
//! 生成した SQL は両方とも `is_read_only_sql_for` を通ることを**生成時に検証**し
//! (多層防御)、さらに実行は常に読み取り専用を強制する `run_lookup_query` 経路を
//! 通る。したがって read_only セッションでも全ルールが動く。

use crate::assertions::{AssertionRule, RowCountOp};
use crate::db::data_diff::sql_literal;
use crate::db::native_dump::is_numeric_literal;
use crate::db::sync::quote_ident;
use crate::db::types::Value;
use crate::db::{is_read_only_sql_for, DriverKind};
use crate::error::{AppError, Result};
use serde::Serialize;

/// 1 ルール分の生成 SQL。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssertionSql {
    /// 件数 (違反件数、`row_count` では総行数) を 1 行 1 列で返す集計クエリ。
    pub check_sql: String,
    /// 違反行 (`unique` は重複キーの一覧、`row_count` は行数) を表示するクエリ。
    pub violations_sql: String,
}

/// 違反件数 / 総行数の集計式。SQL Server の `COUNT(*)` は `INT` で 2^31 を超えると
/// 算術オーバーフローになるため `COUNT_BIG(*)` を使う。
fn count_expr(driver: DriverKind) -> &'static str {
    match driver {
        DriverKind::Mssql => "COUNT_BIG(*)",
        DriverKind::Mysql | DriverKind::Postgres | DriverKind::Sqlite | DriverKind::DuckDb => {
            "COUNT(*)"
        }
    }
}

fn non_blank(s: &str) -> bool {
    !s.trim().is_empty()
}

fn invalid(msg: &str) -> AppError {
    AppError::InvalidInput(format!("assertion: {msg}"))
}

/// 空・空白だけの `Option<String>` を `None` に寄せる。
fn opt_trimmed(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// `schema.table` をドライバ別にクォートして連結する。`schema` が空なら表名だけ。
fn qualified(driver: DriverKind, schema: Option<&str>, table: &str) -> String {
    match schema.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", quote_ident(driver, s), quote_ident(driver, table)),
        None => quote_ident(driver, table),
    }
}

/// 範囲の境界値のリテラル化。十進数値ならそのまま (引用符なし)、それ以外 (日付・
/// 日時など) は文字列リテラルにして比較をエンジンの暗黙変換に任せる。数値判定は
/// `native_dump::is_numeric_literal` を共有する — 数値と判定されなかった入力は必ず
/// 引用符で囲まれエスケープされるので、SQL インジェクションにならない。
fn bound_literal(driver: DriverKind, raw: &str) -> String {
    let s = raw.trim();
    if is_numeric_literal(s) {
        s.to_string()
    } else {
        sql_literal(driver, &Value::String(s.to_string()))
    }
}

/// ルールの入力検証。保存時 (`save_assertion`) と SQL 生成時の両方で使う。
pub fn validate(table: &str, rule: &AssertionRule) -> Result<()> {
    if !non_blank(table) {
        return Err(invalid("table is required"));
    }
    match rule {
        AssertionRule::NotNull { column } => {
            if !non_blank(column) {
                return Err(invalid("column is required"));
            }
        }
        AssertionRule::Unique { columns } => {
            if columns.is_empty() || !columns.iter().all(|c| non_blank(c)) {
                return Err(invalid("unique needs at least one non-empty column"));
            }
        }
        AssertionRule::AcceptedValues { column, values } => {
            if !non_blank(column) {
                return Err(invalid("column is required"));
            }
            if values.is_empty() {
                return Err(invalid("accepted_values needs at least one value"));
            }
        }
        AssertionRule::Range { column, min, max } => {
            if !non_blank(column) {
                return Err(invalid("column is required"));
            }
            if opt_trimmed(min).is_none() && opt_trimmed(max).is_none() {
                return Err(invalid("range needs a min or a max"));
            }
        }
        AssertionRule::Referential {
            columns,
            ref_table,
            ref_columns,
            ..
        } => {
            if !non_blank(ref_table) {
                return Err(invalid("referenced table is required"));
            }
            if columns.is_empty()
                || columns.len() != ref_columns.len()
                || !columns
                    .iter()
                    .chain(ref_columns.iter())
                    .all(|c| non_blank(c))
            {
                return Err(invalid(
                    "referential needs the same number of non-empty source and referenced columns",
                ));
            }
        }
        AssertionRule::RowCount { op, value, max } => {
            if *op == RowCountOp::Between {
                match max {
                    Some(m) if m >= value => {}
                    _ => return Err(invalid("row_count between needs max >= value")),
                }
            }
        }
    }
    Ok(())
}

/// ルールを `driver` 方言の読み取り専用 SQL に変換する。
///
/// | ルール | `check_sql` が数えるもの |
/// |---|---|
/// | `not_null` | 列が NULL の行数 |
/// | `unique` | 重複しているキー (列の組) の種類数。NULL を含む組は対象外 |
/// | `accepted_values` | 非 NULL でリスト外の値を持つ行数 |
/// | `range` | 非 NULL で範囲 (両端含む) の外にある行数 |
/// | `referential` | 参照列がすべて非 NULL で、参照先に対応行が無い行数 |
/// | `row_count` | 総行数 (pass/fail は [`evaluate`] が条件と比較して決める) |
pub fn build_sql(
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    rule: &AssertionRule,
) -> Result<AssertionSql> {
    validate(table, rule)?;
    let q = |name: &str| quote_ident(driver, name.trim());
    let from = qualified(driver, schema, table.trim());
    let count = count_expr(driver);

    let (check_sql, violations_sql) = match rule {
        AssertionRule::NotNull { column } => {
            let where_ = format!("{} IS NULL", q(column));
            (
                format!("SELECT {count} AS observed FROM {from} WHERE {where_}"),
                format!("SELECT * FROM {from} WHERE {where_}"),
            )
        }
        AssertionRule::Unique { columns } => {
            let cols = columns.iter().map(|c| q(c)).collect::<Vec<_>>();
            let list = cols.join(", ");
            let not_null = cols
                .iter()
                .map(|c| format!("{c} IS NOT NULL"))
                .collect::<Vec<_>>()
                .join(" AND ");
            let grouped = format!(
                "SELECT {list} FROM {from} WHERE {not_null} GROUP BY {list} HAVING COUNT(*) > 1"
            );
            (
                format!("SELECT {count} AS observed FROM ({grouped}) AS a_dup"),
                format!(
                    "SELECT {list}, {count} AS duplicate_count FROM {from} WHERE {not_null} \
                     GROUP BY {list} HAVING COUNT(*) > 1 ORDER BY duplicate_count DESC"
                ),
            )
        }
        AssertionRule::AcceptedValues { column, values } => {
            let col = q(column);
            let list = values
                .iter()
                .map(|v| sql_literal(driver, &Value::String(v.clone())))
                .collect::<Vec<_>>()
                .join(", ");
            let where_ = format!("{col} IS NOT NULL AND {col} NOT IN ({list})");
            (
                format!("SELECT {count} AS observed FROM {from} WHERE {where_}"),
                format!("SELECT * FROM {from} WHERE {where_}"),
            )
        }
        AssertionRule::Range { column, min, max } => {
            let col = q(column);
            let mut outside = Vec::new();
            if let Some(lo) = opt_trimmed(min) {
                outside.push(format!("{col} < {}", bound_literal(driver, lo)));
            }
            if let Some(hi) = opt_trimmed(max) {
                outside.push(format!("{col} > {}", bound_literal(driver, hi)));
            }
            let where_ = format!("{col} IS NOT NULL AND ({})", outside.join(" OR "));
            (
                format!("SELECT {count} AS observed FROM {from} WHERE {where_}"),
                format!("SELECT * FROM {from} WHERE {where_}"),
            )
        }
        AssertionRule::Referential {
            columns,
            ref_schema,
            ref_table,
            ref_columns,
        } => {
            let target = qualified(driver, opt_trimmed(ref_schema), ref_table.trim());
            let not_null = columns
                .iter()
                .map(|c| format!("a_src.{} IS NOT NULL", q(c)))
                .collect::<Vec<_>>()
                .join(" AND ");
            let join = columns
                .iter()
                .zip(ref_columns.iter())
                .map(|(c, r)| format!("a_ref.{} = a_src.{}", q(r), q(c)))
                .collect::<Vec<_>>()
                .join(" AND ");
            let where_ =
                format!("{not_null} AND NOT EXISTS (SELECT 1 FROM {target} AS a_ref WHERE {join})");
            (
                format!("SELECT {count} AS observed FROM {from} AS a_src WHERE {where_}"),
                format!("SELECT a_src.* FROM {from} AS a_src WHERE {where_}"),
            )
        }
        AssertionRule::RowCount { .. } => (
            format!("SELECT {count} AS observed FROM {from}"),
            format!("SELECT {count} AS row_count FROM {from}"),
        ),
    };

    // 多層防御: 生成物が読み取り専用の単一文であることを生成時にも検証する。
    // クォート/エスケープが正しい限り到達しないが、ここで弾けば実行経路に
    // 書き込み文が渡る余地が構造的に無くなる。
    for sql in [&check_sql, &violations_sql] {
        if !is_read_only_sql_for(driver, sql) {
            return Err(AppError::ReadOnly(
                "assertion produced a non-read-only statement".into(),
            ));
        }
    }
    Ok(AssertionSql {
        check_sql,
        violations_sql,
    })
}

/// `check_sql` の結果 (件数) からルールの pass/fail を決める。`row_count` は条件と
/// 比較し、それ以外は違反件数が 0 なら pass。
pub fn evaluate(rule: &AssertionRule, observed: u64) -> bool {
    match rule {
        AssertionRule::RowCount { op, value, max } => match op {
            RowCountOp::Gt => observed > *value,
            RowCountOp::Gte => observed >= *value,
            RowCountOp::Lt => observed < *value,
            RowCountOp::Lte => observed <= *value,
            RowCountOp::Eq => observed == *value,
            RowCountOp::Between => observed >= *value && observed <= max.unwrap_or(*value),
        },
        _ => observed == 0,
    }
}

/// `check_sql` の 1 セル目を件数として読む。ドライバによって `COUNT(*)` の型が
/// 異なり (`BIGINT` → `Int`、JS 安全整数超過は `from_*_lossless` で `String`、
/// DuckDB の `HUGEINT` は文字列化など)、どれも受ける。負数や数値でない値は `None`。
pub fn count_from_value(value: &Value) -> Option<u64> {
    match value {
        Value::Int(i) => u64::try_from(*i).ok(),
        Value::UInt(u) => Some(*u),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        Value::Float(f) if f.is_finite() && *f >= 0.0 && f.fract() == 0.0 => {
            // 整数値の浮動小数 (一部ドライバの NUMERIC 経由) を件数として受ける。
            // `u64::MAX` を超える値は飽和するが、件数としては到達し得ない。
            Some(*f as u64)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [DriverKind; 5] = [
        DriverKind::Mysql,
        DriverKind::Postgres,
        DriverKind::Sqlite,
        DriverKind::DuckDb,
        DriverKind::Mssql,
    ];

    fn s(v: &str) -> String {
        v.to_string()
    }

    fn all_rules() -> Vec<AssertionRule> {
        vec![
            AssertionRule::NotNull { column: s("email") },
            AssertionRule::Unique {
                columns: vec![s("tenant_id"), s("email")],
            },
            AssertionRule::AcceptedValues {
                column: s("status"),
                values: vec![s("active"), s("banned")],
            },
            AssertionRule::Range {
                column: s("age"),
                min: Some(s("0")),
                max: Some(s("150")),
            },
            AssertionRule::Referential {
                columns: vec![s("order_id")],
                ref_schema: None,
                ref_table: s("orders"),
                ref_columns: vec![s("id")],
            },
            AssertionRule::RowCount {
                op: RowCountOp::Gt,
                value: 0,
                max: None,
            },
        ]
    }

    fn sql(
        driver: DriverKind,
        schema: Option<&str>,
        table: &str,
        rule: &AssertionRule,
    ) -> AssertionSql {
        build_sql(driver, schema, table, rule).unwrap()
    }

    // 受け入れ条件: 6 ルール × 全方言で、生成物がすべて読み取り専用 SQL であること。
    #[test]
    fn every_rule_renders_read_only_sql_for_every_dialect() {
        for driver in ALL {
            for rule in all_rules() {
                let out = sql(driver, None, "t", &rule);
                assert!(
                    is_read_only_sql_for(driver, &out.check_sql),
                    "{driver:?} {rule:?}: {}",
                    out.check_sql
                );
                assert!(
                    is_read_only_sql_for(driver, &out.violations_sql),
                    "{driver:?} {rule:?}: {}",
                    out.violations_sql
                );
            }
        }
    }

    #[test]
    fn not_null_quotes_identifiers_per_dialect() {
        let rule = AssertionRule::NotNull { column: s("email") };
        assert_eq!(
            sql(DriverKind::Mysql, None, "users", &rule).check_sql,
            "SELECT COUNT(*) AS observed FROM `users` WHERE `email` IS NULL"
        );
        assert_eq!(
            sql(DriverKind::Postgres, Some("public"), "users", &rule).check_sql,
            "SELECT COUNT(*) AS observed FROM \"public\".\"users\" WHERE \"email\" IS NULL"
        );
        assert_eq!(
            sql(DriverKind::Sqlite, None, "users", &rule).violations_sql,
            "SELECT * FROM \"users\" WHERE \"email\" IS NULL"
        );
        assert_eq!(
            sql(DriverKind::Mssql, Some("dbo"), "users", &rule).check_sql,
            "SELECT COUNT_BIG(*) AS observed FROM [dbo].[users] WHERE [email] IS NULL"
        );
        assert_eq!(
            sql(DriverKind::DuckDb, None, "users", &rule).check_sql,
            "SELECT COUNT(*) AS observed FROM \"users\" WHERE \"email\" IS NULL"
        );
    }

    #[test]
    fn unique_counts_duplicate_keys_and_skips_nulls() {
        let rule = AssertionRule::Unique {
            columns: vec![s("a"), s("b")],
        };
        let out = sql(DriverKind::Postgres, None, "t", &rule);
        assert_eq!(
            out.check_sql,
            "SELECT COUNT(*) AS observed FROM (SELECT \"a\", \"b\" FROM \"t\" WHERE \"a\" IS NOT NULL \
             AND \"b\" IS NOT NULL GROUP BY \"a\", \"b\" HAVING COUNT(*) > 1) AS a_dup"
        );
        assert_eq!(
            out.violations_sql,
            "SELECT \"a\", \"b\", COUNT(*) AS duplicate_count FROM \"t\" WHERE \"a\" IS NOT NULL \
             AND \"b\" IS NOT NULL GROUP BY \"a\", \"b\" HAVING COUNT(*) > 1 ORDER BY duplicate_count DESC"
        );
        let my = sql(
            DriverKind::Mysql,
            None,
            "t",
            &AssertionRule::Unique {
                columns: vec![s("a")],
            },
        );
        assert_eq!(
            my.check_sql,
            "SELECT COUNT(*) AS observed FROM (SELECT `a` FROM `t` WHERE `a` IS NOT NULL GROUP BY `a` \
             HAVING COUNT(*) > 1) AS a_dup"
        );
    }

    #[test]
    fn accepted_values_escape_literals_per_dialect() {
        let rule = AssertionRule::AcceptedValues {
            column: s("status"),
            values: vec![s("a'b"), s("c\\d")],
        };
        // MySQL は既定モードでバックスラッシュもエスケープ文字なので二重化する。
        assert_eq!(
            sql(DriverKind::Mysql, None, "t", &rule).check_sql,
            "SELECT COUNT(*) AS observed FROM `t` WHERE `status` IS NOT NULL AND `status` NOT IN ('a''b', 'c\\\\d')"
        );
        assert_eq!(
            sql(DriverKind::Sqlite, None, "t", &rule).check_sql,
            "SELECT COUNT(*) AS observed FROM \"t\" WHERE \"status\" IS NOT NULL AND \"status\" NOT IN ('a''b', 'c\\d')"
        );
        assert_eq!(
            sql(DriverKind::Mssql, None, "t", &rule).violations_sql,
            "SELECT * FROM [t] WHERE [status] IS NOT NULL AND [status] NOT IN ('a''b', 'c\\d')"
        );
    }

    #[test]
    fn range_renders_numbers_bare_and_dates_quoted() {
        let rule = AssertionRule::Range {
            column: s("n"),
            min: Some(s(" -1.5 ")),
            max: None,
        };
        assert_eq!(
            sql(DriverKind::Postgres, None, "t", &rule).check_sql,
            "SELECT COUNT(*) AS observed FROM \"t\" WHERE \"n\" IS NOT NULL AND (\"n\" < -1.5)"
        );
        let dates = AssertionRule::Range {
            column: s("d"),
            min: Some(s("2024-01-01")),
            max: Some(s("2024-12-31")),
        };
        assert_eq!(
            sql(DriverKind::Mysql, None, "t", &dates).check_sql,
            "SELECT COUNT(*) AS observed FROM `t` WHERE `d` IS NOT NULL AND (`d` < '2024-01-01' OR `d` > '2024-12-31')"
        );
        assert_eq!(
            sql(DriverKind::Mssql, None, "t", &dates).check_sql,
            "SELECT COUNT_BIG(*) AS observed FROM [t] WHERE [d] IS NOT NULL AND ([d] < '2024-01-01' OR [d] > '2024-12-31')"
        );
    }

    #[test]
    fn referential_uses_not_exists_with_composite_keys() {
        let rule = AssertionRule::Referential {
            columns: vec![s("o_id"), s("o_rev")],
            ref_schema: Some(s("sales")),
            ref_table: s("orders"),
            ref_columns: vec![s("id"), s("rev")],
        };
        let out = sql(DriverKind::Postgres, Some("sales"), "items", &rule);
        assert_eq!(
            out.check_sql,
            "SELECT COUNT(*) AS observed FROM \"sales\".\"items\" AS a_src WHERE a_src.\"o_id\" IS NOT NULL \
             AND a_src.\"o_rev\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM \"sales\".\"orders\" AS a_ref \
             WHERE a_ref.\"id\" = a_src.\"o_id\" AND a_ref.\"rev\" = a_src.\"o_rev\")"
        );
        assert!(out
            .violations_sql
            .starts_with("SELECT a_src.* FROM \"sales\".\"items\" AS a_src WHERE"));
        let my = sql(
            DriverKind::Mysql,
            None,
            "items",
            &AssertionRule::Referential {
                columns: vec![s("order_id")],
                ref_schema: None,
                ref_table: s("orders"),
                ref_columns: vec![s("id")],
            },
        );
        assert_eq!(
            my.check_sql,
            "SELECT COUNT(*) AS observed FROM `items` AS a_src WHERE a_src.`order_id` IS NOT NULL AND \
             NOT EXISTS (SELECT 1 FROM `orders` AS a_ref WHERE a_ref.`id` = a_src.`order_id`)"
        );
    }

    #[test]
    fn row_count_counts_all_rows() {
        let rule = AssertionRule::RowCount {
            op: RowCountOp::Between,
            value: 1,
            max: Some(10),
        };
        let out = sql(DriverKind::Sqlite, None, "t", &rule);
        assert_eq!(out.check_sql, "SELECT COUNT(*) AS observed FROM \"t\"");
        assert_eq!(
            out.violations_sql,
            "SELECT COUNT(*) AS row_count FROM \"t\""
        );
        assert_eq!(
            sql(DriverKind::Mssql, None, "t", &rule).check_sql,
            "SELECT COUNT_BIG(*) AS observed FROM [t]"
        );
    }

    // 識別子・値に引用符やセミコロン・コメントを混ぜても、**書き込み文や
    // スタック文を返すことは決してない**: 返すなら必ず読み取り専用の単一文で、
    // そうでなければ生成時の多層防御が `ReadOnly` で拒否する。
    //
    // SQL Server だけは拒否側に倒れうる — 安全網のマスク (`mask_for_driver`) が
    // `[...]` 識別子を引用として扱わないため、`'` / `;` / `--` を含む識別子は
    // 括弧の中身が「素の SQL」に見える (fail-closed。そうした識別子を持つ現実的な
    // スキーマはまず無いので、誤検出の代償より安全網を緩めない方を選ぶ)。
    #[test]
    fn hostile_identifiers_and_values_never_yield_writable_sql() {
        let evil = "x\"`]'; DROP TABLE users; --";
        let rules = vec![
            AssertionRule::NotNull { column: s(evil) },
            AssertionRule::Unique {
                columns: vec![s(evil)],
            },
            AssertionRule::AcceptedValues {
                column: s(evil),
                values: vec![s("'); DELETE FROM users; --"), s("\\'; DROP TABLE t; --")],
            },
            AssertionRule::Range {
                column: s(evil),
                min: Some(s("1; DROP TABLE t")),
                max: Some(s("'; UPDATE t SET a = 1; --")),
            },
            AssertionRule::Referential {
                columns: vec![s(evil)],
                ref_schema: Some(s(evil)),
                ref_table: s(evil),
                ref_columns: vec![s(evil)],
            },
            AssertionRule::RowCount {
                op: RowCountOp::Eq,
                value: 3,
                max: None,
            },
        ];
        for driver in ALL {
            for rule in &rules {
                match build_sql(driver, Some(evil), evil, rule) {
                    Ok(out) => {
                        assert!(
                            is_read_only_sql_for(driver, &out.check_sql),
                            "{driver:?}: {}",
                            out.check_sql
                        );
                        assert!(
                            is_read_only_sql_for(driver, &out.violations_sql),
                            "{driver:?}: {}",
                            out.violations_sql
                        );
                    }
                    Err(AppError::ReadOnly(_)) if driver == DriverKind::Mssql => {}
                    Err(e) => panic!("{driver:?} {rule:?}: {e}"),
                }
            }
        }
        // `]` を含む識別子 (現実的な範囲) は MSSQL でも `]]` に二重化して生成できる。
        let bracket = "odd]name col";
        for rule in [
            AssertionRule::NotNull { column: s(bracket) },
            AssertionRule::Unique {
                columns: vec![s(bracket), s("b")],
            },
        ] {
            let out = build_sql(DriverKind::Mssql, None, bracket, &rule).unwrap();
            assert!(
                out.check_sql.contains("[odd]]name col]"),
                "{}",
                out.check_sql
            );
        }
    }

    #[test]
    fn validate_rejects_incomplete_rules() {
        let bad = [
            ("", AssertionRule::NotNull { column: s("a") }),
            ("t", AssertionRule::NotNull { column: s("  ") }),
            ("t", AssertionRule::Unique { columns: vec![] }),
            (
                "t",
                AssertionRule::Unique {
                    columns: vec![s("a"), s("")],
                },
            ),
            (
                "t",
                AssertionRule::AcceptedValues {
                    column: s("a"),
                    values: vec![],
                },
            ),
            (
                "t",
                AssertionRule::Range {
                    column: s("a"),
                    min: None,
                    max: Some(s(" ")),
                },
            ),
            (
                "t",
                AssertionRule::Referential {
                    columns: vec![s("a")],
                    ref_schema: None,
                    ref_table: s("r"),
                    ref_columns: vec![s("x"), s("y")],
                },
            ),
            (
                "t",
                AssertionRule::Referential {
                    columns: vec![s("a")],
                    ref_schema: None,
                    ref_table: s(""),
                    ref_columns: vec![s("x")],
                },
            ),
            (
                "t",
                AssertionRule::RowCount {
                    op: RowCountOp::Between,
                    value: 5,
                    max: None,
                },
            ),
            (
                "t",
                AssertionRule::RowCount {
                    op: RowCountOp::Between,
                    value: 5,
                    max: Some(4),
                },
            ),
        ];
        for (table, rule) in bad {
            let err = build_sql(DriverKind::Postgres, None, table, &rule)
                .expect_err(&format!("must reject {table:?} {rule:?}"));
            assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
        }
    }

    #[test]
    fn evaluate_compares_row_count_and_zero_violations() {
        let rc = |op, value, max| AssertionRule::RowCount { op, value, max };
        assert!(evaluate(&rc(RowCountOp::Gt, 0, None), 1));
        assert!(!evaluate(&rc(RowCountOp::Gt, 0, None), 0));
        assert!(evaluate(&rc(RowCountOp::Gte, 3, None), 3));
        assert!(evaluate(&rc(RowCountOp::Lt, 3, None), 2));
        assert!(!evaluate(&rc(RowCountOp::Lt, 3, None), 3));
        assert!(evaluate(&rc(RowCountOp::Lte, 3, None), 3));
        assert!(evaluate(&rc(RowCountOp::Eq, 3, None), 3));
        assert!(!evaluate(&rc(RowCountOp::Eq, 3, None), 4));
        assert!(evaluate(&rc(RowCountOp::Between, 1, Some(10)), 1));
        assert!(evaluate(&rc(RowCountOp::Between, 1, Some(10)), 10));
        assert!(!evaluate(&rc(RowCountOp::Between, 1, Some(10)), 11));
        assert!(!evaluate(&rc(RowCountOp::Between, 1, Some(10)), 0));
        let nn = AssertionRule::NotNull { column: s("a") };
        assert!(evaluate(&nn, 0));
        assert!(!evaluate(&nn, 1));
    }

    #[test]
    fn count_from_value_accepts_every_driver_shape() {
        assert_eq!(count_from_value(&Value::Int(3)), Some(3));
        assert_eq!(count_from_value(&Value::UInt(4)), Some(4));
        assert_eq!(
            count_from_value(&Value::String(s("9007199254740993"))),
            Some(9_007_199_254_740_993)
        );
        assert_eq!(count_from_value(&Value::Float(2.0)), Some(2));
        assert_eq!(count_from_value(&Value::Int(-1)), None);
        assert_eq!(count_from_value(&Value::Float(1.5)), None);
        assert_eq!(count_from_value(&Value::Null), None);
        assert_eq!(count_from_value(&Value::String(s("x"))), None);
    }
}
