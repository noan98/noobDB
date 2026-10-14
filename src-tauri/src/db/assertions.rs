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
use crate::db::data_diff::is_numeric_literal;
use crate::db::data_diff::sql_literal;
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

/// 違反件数 / 総行数の集計式。
fn count_expr(driver: DriverKind) -> &'static str {
    let _ = driver;
    "COUNT(*)"
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
/// `data_diff::is_numeric_literal` を共有する — 数値と判定されなかった入力は必ず
/// 引用符で囲まれエスケープされるので、SQL インジェクションにならない。
fn bound_literal(driver: DriverKind, raw: &str) -> String {
    let s = raw.trim();
    if is_numeric_literal(s) {
        s.to_string()
    } else {
        sql_literal(driver, &Value::String(s.to_string()))
    }
}

/// 範囲比較の違反条件 (`op` は `<` か `>`)。SQLite は TEXT 親和性の列に数値リテラルを比べると、
/// リテラル側が文字列化されて文字列比較になり ('10' > '5' が偽)、エラーも出ず件数だけ狂う。
/// 数値境界のときは値の型で分けて数値比較を強制する:
/// - `integer` / `real` はそのまま比べる。
/// - `text` は数値の書式 (符号は先頭のみ・小数点は高々 1 つ・指数なし) に合うものだけ CAST して比べる。
/// - 書式に合わない text (`'abc'` / `'12abc'`) と blob は、比較できないので違反として数える。
///
/// MySQL は文字列列と数値を数値として比較し、PostgreSQL は型不一致をエラーにするので、そのまま比較する。
fn range_violation(driver: DriverKind, col: &str, op: &str, bound: &str) -> String {
    let lit = bound_literal(driver, bound);
    if driver == DriverKind::Sqlite && is_numeric_literal(bound.trim()) {
        let numeric = format!(
            "CASE WHEN typeof({col}) IN ('integer', 'real') THEN {col} \
             WHEN typeof({col}) = 'text' AND {col} NOT GLOB '*[^0-9.+-]*' AND {col} GLOB '*[0-9]*' \
             AND {col} NOT GLOB '*[0-9.][+-]*' AND {col} NOT GLOB '*[+-][+-]*' \
             AND {col} NOT GLOB '*.*.*' THEN CAST({col} AS NUMERIC) END"
        );
        format!("({numeric} IS NULL OR {numeric} {op} {lit})")
    } else {
        format!("{col} {op} {lit}")
    }
}

/// 先頭キーワードが `SELECT` / `WITH` か (前後の空白・開き括弧は許す)。
fn starts_with_select_or_with(sql: &str) -> bool {
    let body = sql.trim_start().trim_start_matches('(').trim_start();
    let word: String = body
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    word.eq_ignore_ascii_case("select") || word.eq_ignore_ascii_case("with")
}

/// 括弧の数え方の方言差。文字列リテラルの終端を決める規則がドライバで違う。
#[derive(Clone, Copy)]
struct QuoteRules {
    /// MySQL 既定: `'` / `"` の中で `\` が次の 1 文字をエスケープする。
    backslash_escapes: bool,
    /// PostgreSQL: `$tag$ ... $tag$` のドル引用。
    dollar_quotes: bool,
}

impl QuoteRules {
    fn for_driver(driver: DriverKind) -> Self {
        Self {
            backslash_escapes: driver == DriverKind::Mysql,
            dollar_quotes: driver == DriverKind::Postgres,
        }
    }
}

/// ドライバが決まらない保存時用: どれかの方言で釣り合っていれば受理する。実行時の
/// `build_sql` が実際のドライバの規則で再検証するので、ここは緩めでよい
/// (正しい SQL を方言違いの規則で誤って拒否しないため)。
fn parens_balanced_any_dialect(sql: &str) -> bool {
    [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite]
        .into_iter()
        .any(|d| parens_balanced(sql, QuoteRules::for_driver(d)))
}

/// 文字列・識別子クォートとコメントの外で括弧が釣り合っているか。サブクエリの
/// 閉じ括弧を先取りして包みから抜け出す本文を弾く。コメント内の括弧は読み飛ばす。
fn parens_balanced(sql: &str, rules: QuoteRules) -> bool {
    let chars: Vec<char> = sql.chars().collect();
    let mut depth: i64 = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                i += 1;
                while i < chars.len() && chars[i] != c {
                    // MySQL の文字列では `\'` は閉じ引用符ではない (バッククォート識別子は対象外)。
                    if rules.backslash_escapes && c != '`' && chars[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            '$' if rules.dollar_quotes
                && !(i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '_')) =>
            {
                // `$tag$` の開きタグ (tag は空でもよい。`$1` のような位置パラメータは対象外)。
                let mut j = i + 1;
                if j < chars.len() && (chars[j].is_alphabetic() || chars[j] == '_') {
                    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                        j += 1;
                    }
                }
                if chars.get(j) == Some(&'$') {
                    let tag: Vec<char> = chars[i..=j].to_vec();
                    let mut k = j + 1;
                    let mut closed = false;
                    while k + tag.len() <= chars.len() {
                        if chars[k..k + tag.len()] == tag[..] {
                            closed = true;
                            break;
                        }
                        k += 1;
                    }
                    // 閉じが無ければ残りすべてが文字列 (他のクォートの未閉鎖と同じ扱い)。
                    i = if closed {
                        k + tag.len() - 1
                    } else {
                        chars.len()
                    };
                }
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 1;
            }
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
        i += 1;
    }
    depth == 0
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
        AssertionRule::CustomSql { sql } => {
            if !non_blank(sql) {
                return Err(invalid("sql is required"));
            }
            // ドライバ非依存の保守的判定。ドライバ別の再検証は `build_sql` の末尾で行う。
            if !crate::db::is_read_only_sql(sql) {
                return Err(AppError::ReadOnly(
                    "custom assertion SQL must be a single read-only statement".into(),
                ));
            }
            // SHOW / EXPLAIN / TABLE などは読み取り専用でもサブクエリに包めない。
            if !starts_with_select_or_with(sql) {
                return Err(invalid(
                    "custom assertion SQL must start with SELECT or WITH",
                ));
            }
            if !parens_balanced_any_dialect(sql) {
                return Err(invalid("custom assertion SQL has unbalanced parentheses"));
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
/// | `custom_sql` | 利用者の SELECT が返す行数 (0 行なら pass) |
pub fn build_sql(
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    rule: &AssertionRule,
) -> Result<AssertionSql> {
    validate(table, rule)?;
    if let AssertionRule::CustomSql { sql } = rule {
        // 保存時の検証は方言を問わず緩いので、実行するドライバの引用規則で括弧を再検証する。
        if !parens_balanced(sql, QuoteRules::for_driver(driver)) {
            return Err(invalid("custom assertion SQL has unbalanced parentheses"));
        }
    }
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
                outside.push(range_violation(driver, &col, "<", lo));
            }
            if let Some(hi) = opt_trimmed(max) {
                outside.push(range_violation(driver, &col, ">", hi));
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
        AssertionRule::CustomSql { sql } => {
            // 末尾の `;` と空白を落とし、サブクエリに包む。改行で挟むのは末尾の
            // `--` コメントが閉じ括弧を巻き込まないようにするため。
            let body = sql
                .trim()
                .trim_end_matches(|c: char| c == ';' || c.is_whitespace());
            (
                format!("SELECT {count} AS observed FROM (\n{body}\n) AS a_custom"),
                body.to_string(),
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

/// MySQL の派生表は列名の重複を許さない (ERROR 1060)。`custom_sql` の `check_sql` は本文を
/// 派生表に包むため、`SELECT a.id, b.id …` のような同名列を含む本文だけが件数チェックで失敗する
/// (`violations_sql` は素の SELECT なので動く)。その失敗かを判定し、原因が分かる案内を返す。
pub fn custom_sql_duplicate_column_hint(
    driver: DriverKind,
    rule: &AssertionRule,
    error_message: &str,
) -> Option<String> {
    if driver != DriverKind::Mysql || !matches!(rule, AssertionRule::CustomSql { .. }) {
        return None;
    }
    let lower = error_message.to_lowercase();
    (lower.contains("duplicate column name") || lower.contains("1060 (42s21)")).then(|| {
        format!(
            "custom_sql has duplicate column names in its SELECT. MySQL wraps the SELECT in a \
             derived table for the count check, so give each column a unique alias (AS): \
             {error_message}"
        )
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
/// 異なり (`BIGINT` → `Int`、JS 安全整数超過は `from_*_lossless` で `String`
/// など)、どれも受ける。負数や数値でない値は `None`。
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
    #[test]
    fn duplicate_column_error_gets_a_hint_only_for_mysql_custom_sql() {
        let custom = AssertionRule::CustomSql {
            sql: "SELECT a.id, b.id FROM a JOIN b".into(),
        };
        let err = "error returned from database: 1060 (42S21): Duplicate column name 'id'";
        assert!(custom_sql_duplicate_column_hint(DriverKind::Mysql, &custom, err).is_some());
        // 単なる "1060" だけの文字列には反応しない (行番号などの偶然一致を避ける)。
        assert!(
            custom_sql_duplicate_column_hint(DriverKind::Mysql, &custom, "near line 1060")
                .is_none()
        );
        assert!(custom_sql_duplicate_column_hint(DriverKind::Postgres, &custom, err).is_none());
        assert!(
            custom_sql_duplicate_column_hint(DriverKind::Mysql, &custom, "Unknown column 'x'")
                .is_none()
        );
    }

    use super::*;

    const ALL: [DriverKind; 3] = [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite];

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
            AssertionRule::CustomSql {
                sql: s("SELECT * FROM t WHERE a > b;"),
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
    }

    #[test]
    fn sqlite_non_numeric_bound_is_not_wrapped() {
        let dates = AssertionRule::Range {
            column: s("d"),
            min: Some(s("2024-01-01")),
            max: None,
        };
        assert_eq!(
            sql(DriverKind::Sqlite, None, "t", &dates).check_sql,
            "SELECT COUNT(*) AS observed FROM \"t\" WHERE \"d\" IS NOT NULL AND (\"d\" < '2024-01-01')"
        );
    }

    /// SQLite の実エンジンで、型の混在した列に対する範囲チェックの違反件数を固定する。
    #[tokio::test]
    async fn sqlite_numeric_range_counts_non_numeric_values_as_violations() {
        use sqlx::Connection;
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite connection");
        // 親和性なし (BLOB) の列にして、挿入した値の型をそのまま残す。
        sqlx::query("CREATE TABLE t (v)")
            .execute(&mut conn)
            .await
            .expect("create table");
        for lit in [
            "1", "'abc'", "'12abc'", "'7'", "'10'", "3.5", "NULL", "x'00'",
        ] {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "INSERT INTO t (v) VALUES ({lit})"
            )))
            .execute(&mut conn)
            .await
            .expect("insert");
        }
        let count = |rule: AssertionRule| {
            let check = sql(DriverKind::Sqlite, None, "t", &rule).check_sql;
            async move { check }
        };
        let max5 = count(AssertionRule::Range {
            column: s("v"),
            min: None,
            max: Some(s("5")),
        })
        .await;
        let observed: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(max5))
            .fetch_one(&mut conn)
            .await
            .expect("count");
        // 違反: 'abc' / '12abc' (数値でない text) / x'00' (blob) / '10' (text を数値の 10 として > 5)。
        // 適合: 1 / 3.5 / '7' は数値の 7 として比較するので違反 (> 5)。NULL は対象外。
        // → 違反は 'abc', '12abc', '7', '10', x'00' の 5 件。
        assert_eq!(observed, 5);

        let max8 = count(AssertionRule::Range {
            column: s("v"),
            min: None,
            max: Some(s("8")),
        })
        .await;
        let observed: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(max8))
            .fetch_one(&mut conn)
            .await
            .expect("count");
        // '7' は数値の 7 として 8 以下なので適合。'10' は違反。→ 'abc', '12abc', '10', x'00' の 4 件。
        assert_eq!(observed, 4);
    }

    #[test]
    fn parens_follow_the_drivers_quoting_rules() {
        let mysql = QuoteRules::for_driver(DriverKind::Mysql);
        let pg = QuoteRules::for_driver(DriverKind::Postgres);
        let sqlite = QuoteRules::for_driver(DriverKind::Sqlite);
        // MySQL: \' は閉じ引用符ではない。
        let bs = r"SELECT * FROM t WHERE note = 'a\'(b'";
        assert!(parens_balanced(bs, mysql));
        assert!(!parens_balanced(bs, sqlite));
        assert!(parens_balanced_any_dialect(bs));
        // PostgreSQL: ドル引用の中の括弧は数えない。
        let dollar = "SELECT $$ ( $$, $tag$ ) ' $tag$ FROM t";
        assert!(parens_balanced(dollar, pg));
        assert!(!parens_balanced("SELECT $$ ( $$ FROM t", mysql));
        assert!(parens_balanced("SELECT $$ ( $$ FROM t", pg));
        // 位置パラメータ $1 はドル引用ではない。
        assert!(parens_balanced("SELECT ($1 + $2)", pg));
        // 本当に釣り合っていない SQL はどの方言でも拒否する。
        assert!(!parens_balanced_any_dialect("SELECT (1"));
        assert!(!parens_balanced_any_dialect("SELECT 1) UNION (SELECT 2"));
    }

    #[test]
    fn build_sql_checks_parens_with_the_target_driver_rules() {
        let rule = AssertionRule::CustomSql {
            sql: r"SELECT * FROM t WHERE note = 'a\'(b'".into(),
        };
        assert!(validate("t", &rule).is_ok());
        assert!(build_sql(DriverKind::Mysql, None, "t", &rule).is_ok());
        assert!(build_sql(DriverKind::Sqlite, None, "t", &rule).is_err());
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
    }

    // 識別子・値に引用符やセミコロン・コメントを混ぜても、**書き込み文や
    // スタック文を返すことは決してない**: 返すなら必ず読み取り専用の単一文で、
    // そうでなければ生成時の多層防御が `ReadOnly` で拒否する。
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
                    Err(e) => panic!("{driver:?} {rule:?}: {e}"),
                }
            }
        }
    }

    #[test]
    fn custom_sql_wraps_as_subquery_and_rejects_writes() {
        let rule = AssertionRule::CustomSql {
            sql: s("SELECT id FROM t WHERE end_at < start_at -- コメント\n;"),
        };
        for driver in ALL {
            let out = sql(driver, None, "t", &rule);
            assert!(out.check_sql.contains("AS a_custom"), "{}", out.check_sql);
            assert!(out.violations_sql.ends_with("start_at -- コメント"));
        }
        for bad in [
            "DELETE FROM t",
            "SELECT 1; DELETE FROM t",
            "UPDATE t SET a = 1",
            "   ",
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "SELECT * FROM t FOR UPDATE",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "TABLE t",
            "SELECT 1) AS a_custom UNION SELECT (1",
        ] {
            let rule = AssertionRule::CustomSql { sql: s(bad) };
            assert!(
                build_sql(DriverKind::Postgres, None, "t", &rule).is_err(),
                "{bad}"
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
