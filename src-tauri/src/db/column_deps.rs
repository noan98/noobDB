//! DROP COLUMN の依存オブジェクト検出 (#1758) の純ロジック。
//!
//! 列を DROP すると、その列を参照するビュー・生成列・インデックス・外部キー・トリガーが
//! DB 側でエラーになるか、黙って壊れる (MySQL はビューが後から失敗し、インデックスは縮む)。
//! 実行前にそれらを列挙するため、ここでは DB から集めた部品 (インデックス一覧・FK 一覧・
//! 生成列の式) を「削除する列」と突き合わせて [`ColumnDependency`] にまとめる。
//! ビュー / トリガーの定義本文の走査は既存の Where-used (`where_used.rs`) に任せ、
//! `commands::schema::column_dependencies` が結果を合流させる。

use serde::Serialize;

use super::schema_insight::IncomingForeignKey;
use super::sync::quote_ident;
use super::types::{ForeignKey, IndexInfo};
use super::where_used::{find_references, ReferenceConfidence, WhereUsedTarget};
use super::DriverKind;

/// DROP COLUMN で影響を受ける依存 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnDependency {
    /// 削除対象の列名 (どの列に起因する依存か)。
    pub column: String,
    /// `"view"` / `"materialized_view"` / `"trigger"` / `"generated_column"` / `"index"` /
    /// `"foreign_key"` (この表の FK 列) / `"referenced_by"` (他テーブルの FK の参照先)。
    pub kind: String,
    /// 依存オブジェクトの名前 (ビュー名・インデックス名・制約名・生成列名・子テーブル名)。
    pub name: String,
    /// 補足 (インデックスの構成列、FK の参照先、生成列の式など)。
    pub detail: Option<String>,
    /// 参照の確からしさ。定義本文の走査で「対象テーブルとの結び付きを確認できなかった」ものは
    /// `possible`。カタログから直接分かる依存 (インデックス / FK / 生成列) は常に `direct`。
    pub confidence: ReferenceConfidence,
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn is_dropped<'a>(dropped: &'a [String], col: &str) -> Option<&'a String> {
    dropped.iter().find(|d| same(d, col))
}

/// 削除する列を含むインデックス。
pub fn index_dependencies(indexes: &[IndexInfo], dropped: &[String]) -> Vec<ColumnDependency> {
    let mut out = Vec::new();
    for idx in indexes {
        for d in dropped {
            if idx.columns.iter().any(|c| same(c, d)) {
                out.push(ColumnDependency {
                    column: d.clone(),
                    kind: "index".into(),
                    name: idx.name.clone(),
                    detail: Some(idx.columns.join(", ")),
                    confidence: ReferenceConfidence::Direct,
                });
            }
        }
    }
    out
}

/// 削除する列を FK 列に持つ制約 (`own`) と、削除する列を参照先に持つ他テーブルの FK (`incoming`)。
/// `own` は `table` 自身の行だけを渡すこと。
pub fn foreign_key_dependencies(
    table: &str,
    own: &[ForeignKey],
    incoming: &[IncomingForeignKey],
    dropped: &[String],
) -> Vec<ColumnDependency> {
    let mut out = Vec::new();
    for fk in own {
        if let Some(d) = is_dropped(dropped, &fk.column) {
            out.push(ColumnDependency {
                column: d.clone(),
                kind: "foreign_key".into(),
                name: fk
                    .constraint_name
                    .clone()
                    .unwrap_or_else(|| fk.column.clone()),
                detail: Some(format!(
                    "{}.{} → {}{}",
                    table,
                    fk.column,
                    fk.referenced_table,
                    fk.referenced_column
                        .as_deref()
                        .map(|c| format!(".{c}"))
                        .unwrap_or_default()
                )),
                confidence: ReferenceConfidence::Direct,
            });
        }
    }
    for fk in incoming {
        if let Some(d) = is_dropped(dropped, &fk.referenced_column) {
            out.push(ColumnDependency {
                column: d.clone(),
                kind: "referenced_by".into(),
                name: fk.table.clone(),
                detail: Some(format!(
                    "{}.{} → {}.{}",
                    fk.table, fk.column, table, fk.referenced_column
                )),
                confidence: ReferenceConfidence::Direct,
            });
        }
    }
    out
}

/// 生成列の式 (`(列名, 式)`) のうち、削除する列を参照するもの。削除対象に自身も含まれる生成列は
/// 一緒に消えるので依存に数えない。式の走査は Where-used と同じ識別子解析 (引用・コメント・
/// 文字列リテラルの除外) を `SELECT <式> FROM <表>` として使う。
pub fn generated_column_dependencies(
    driver: DriverKind,
    database: &str,
    table: &str,
    generated: &[(String, String)],
    dropped: &[String],
) -> Vec<ColumnDependency> {
    let mut out = Vec::new();
    for (gen_name, expr) in generated {
        if is_dropped(dropped, gen_name).is_some() {
            continue;
        }
        let sql = format!("SELECT {} FROM {}", expr, quote_ident(driver, table));
        for d in dropped {
            let target = WhereUsedTarget {
                database: database.to_string(),
                table: table.to_string(),
                column: Some(d.clone()),
            };
            if !find_references(&sql, &target, driver).is_empty() {
                out.push(ColumnDependency {
                    column: d.clone(),
                    kind: "generated_column".into(),
                    name: gen_name.clone(),
                    detail: Some(expr.clone()),
                    confidence: ReferenceConfidence::Direct,
                });
            }
        }
    }
    out
}

/// SQLite の `CREATE TABLE` 文から生成列 (`... AS (式)` / `GENERATED ALWAYS AS (式)`) の
/// `(列名, 式)` を取り出す。SQLite は `PRAGMA table_info` が生成列を返さず、式は
/// `sqlite_master.sql` にしか無いため、文字列・引用符・括弧の深さだけを見る簡易スキャンで切り出す。
pub fn sqlite_generated_exprs(create_sql: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = create_sql.chars().collect();
    // 列定義全体を囲む最初の '(' を探す。
    let Some(open) = chars.iter().position(|&c| c == '(') else {
        return Vec::new();
    };
    // 列定義を最上位のカンマで分割する。
    let mut defs: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut depth = 0usize;
    let mut i = open + 1;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' | '[' => {
                let close = if c == '[' { ']' } else { c };
                cur.push(c);
                i += 1;
                while i < chars.len() {
                    cur.push(chars[i]);
                    if chars[i] == close {
                        // 引用符の連続 ('' / "") は文字そのもの。
                        if close != ']' && chars.get(i + 1) == Some(&close) {
                            i += 1;
                            cur.push(chars[i]);
                        } else {
                            break;
                        }
                    }
                    i += 1;
                }
            }
            '(' => {
                depth += 1;
                cur.push(c);
            }
            ')' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                cur.push(c);
            }
            ',' if depth == 0 => {
                defs.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
        i += 1;
    }
    if !cur.trim().is_empty() {
        defs.push(cur);
    }

    let mut out = Vec::new();
    for def in defs {
        let def = def.trim();
        let upper = def.to_uppercase();
        if ["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]
            .iter()
            .any(|k| {
                upper.starts_with(k)
                    && !upper[k.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_')
            })
        {
            continue;
        }
        let Some((name, rest)) = split_leading_ident(def) else {
            continue;
        };
        if let Some(expr) = generated_expr(rest) {
            out.push((name, expr));
        }
    }
    out
}

/// 先頭の識別子 (引用符つきも可) とその残りに分ける。
fn split_leading_ident(def: &str) -> Option<(String, &str)> {
    let mut it = def.char_indices();
    let (_, first) = it.next()?;
    let (close, quoted) = match first {
        '"' | '`' => (first, true),
        '[' => (']', true),
        _ => (' ', false),
    };
    if quoted {
        let body = &def[first.len_utf8()..];
        let mut name = String::new();
        let mut chars = body.char_indices().peekable();
        while let Some((idx, c)) = chars.next() {
            if c == close {
                if close != ']' && chars.peek().map(|&(_, n)| n) == Some(close) {
                    name.push(c);
                    chars.next();
                    continue;
                }
                return Some((name, &body[idx + c.len_utf8()..]));
            }
            name.push(c);
        }
        None
    } else {
        let end = def.find(|c: char| c.is_whitespace()).unwrap_or(def.len());
        Some((def[..end].to_string(), &def[end..]))
    }
}

/// 列定義の残りから `AS (式)` の式を取り出す。
fn generated_expr(rest: &str) -> Option<String> {
    let chars: Vec<char> = rest.chars().collect();
    let mut i = 0;
    let mut depth = 0usize;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                i += 1;
                while i < chars.len() && chars[i] != c {
                    i += 1;
                }
            }
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            'a' | 'A' if depth == 0 => {
                let prev_ok = i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == ')';
                let is_as = matches!(chars.get(i + 1), Some('s' | 'S'));
                if prev_ok && is_as {
                    let mut j = i + 2;
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if chars.get(j) == Some(&'(') {
                        let start = j + 1;
                        let mut d = 1usize;
                        let mut k = start;
                        while k < chars.len() {
                            match chars[k] {
                                '\'' | '"' | '`' => {
                                    let q = chars[k];
                                    k += 1;
                                    while k < chars.len() && chars[k] != q {
                                        k += 1;
                                    }
                                }
                                '(' => d += 1,
                                ')' => {
                                    d -= 1;
                                    if d == 0 {
                                        return Some(chars[start..k].iter().collect());
                                    }
                                }
                                _ => {}
                            }
                            k += 1;
                        }
                        return None;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(name: &str, cols: &[&str]) -> IndexInfo {
        IndexInfo {
            name: name.into(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn index_containing_dropped_column() {
        let deps = index_dependencies(
            &[idx("idx_a", &["A", "b"]), idx("idx_c", &["c"])],
            &["a".to_string()],
        );
        assert_eq!(deps.len(), 1);
        assert_eq!(deps[0].name, "idx_a");
        assert_eq!(deps[0].column, "a");
        assert_eq!(deps[0].kind, "index");
    }

    #[test]
    fn foreign_keys_own_and_incoming() {
        let own = vec![ForeignKey {
            table: "t".into(),
            column: "user_id".into(),
            referenced_table: "users".into(),
            referenced_column: Some("id".into()),
            constraint_name: Some("fk_user".into()),
            on_delete: None,
            on_update: None,
        }];
        let incoming = vec![IncomingForeignKey {
            table: "child".into(),
            column: "t_id".into(),
            referenced_column: "id".into(),
            on_delete: None,
        }];
        let deps = foreign_key_dependencies(
            "t",
            &own,
            &incoming,
            &["user_id".to_string(), "id".to_string()],
        );
        assert_eq!(deps.len(), 2);
        assert_eq!(deps[0].kind, "foreign_key");
        assert_eq!(deps[0].name, "fk_user");
        assert_eq!(deps[1].kind, "referenced_by");
        assert_eq!(deps[1].name, "child");
        assert!(foreign_key_dependencies("t", &own, &incoming, &["other".to_string()]).is_empty());
    }

    #[test]
    fn generated_column_references_dropped_column() {
        let gen = vec![
            ("total".to_string(), "`price` * `qty`".to_string()),
            ("label".to_string(), "concat('price', name)".to_string()),
        ];
        let deps = generated_column_dependencies(
            DriverKind::Mysql,
            "db",
            "t",
            &gen,
            &["price".to_string()],
        );
        assert_eq!(deps.len(), 1, "{deps:?}");
        assert_eq!(deps[0].name, "total");
        // 文字列リテラル中の語は参照ではない。
        assert!(generated_column_dependencies(
            DriverKind::Mysql,
            "db",
            "t",
            &gen,
            &["qty".to_string(), "total".to_string()]
        )
        .is_empty());
    }

    #[test]
    fn sqlite_generated_columns_are_extracted() {
        let sql = r#"CREATE TABLE "t" (
            id INTEGER PRIMARY KEY,
            price REAL,
            qty INTEGER NOT NULL DEFAULT (1),
            "total" REAL GENERATED ALWAYS AS (price * qty) STORED,
            label TEXT AS (substr(price || ',x', 1, 3)) VIRTUAL,
            CHECK (price > 0)
        )"#;
        let got = sqlite_generated_exprs(sql);
        assert_eq!(
            got,
            vec![
                ("total".to_string(), "price * qty".to_string()),
                (
                    "label".to_string(),
                    "substr(price || ',x', 1, 3)".to_string()
                ),
            ]
        );
        assert!(sqlite_generated_exprs("CREATE TABLE t (a INT, b TEXT)").is_empty());
    }
}
