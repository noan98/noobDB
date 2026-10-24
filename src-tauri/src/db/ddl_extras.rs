//! CHECK 制約と生成列の式 (`TableDdlExtras`) を 3 ドライバで揃える純層 (#1837)。
//!
//! PostgreSQL は `pg_get_constraintdef` / `pg_get_expr` がそのまま `CHECK (...)` 句・式を返す。
//! MySQL は `information_schema.CHECK_CONSTRAINTS` が式だけ (`CHECK_CLAUSE`) を返すので
//! [`mysql_check_definition`] で `CHECK (...)` 句にそろえ、`GENERATION_EXPRESSION` の
//! エスケープを [`mysql_generation_expression`] で戻す。SQLite は式を返す PRAGMA が無いので
//! `sqlite_master.sql` の `CREATE TABLE` を [`parse_sqlite_extras`] で読む。
//! 比較は [`normalize_expr`] で空白・大小・冗長な外側括弧の違いを吸収して行う。
//!
//! すべて DB 無しでテストできる純関数。

use super::column_deps::unescape_mysql_generation_expression;
use super::types::{GeneratedColumnInfo, TableDdlExtras};

// ───────────────────────── MySQL ─────────────────────────

/// `information_schema.CHECK_CONSTRAINTS.CHECK_CLAUSE` (式のみ) を `CHECK (...)` 句にする。
/// `enforced` が false (`NOT ENFORCED`) のときは末尾にそれを足す。
pub fn mysql_check_definition(clause: &str, enforced: bool) -> String {
    let inner = strip_outer_parens(clause.trim());
    let mut def = format!("CHECK ({})", unescape_mysql_generation_expression(inner));
    if !enforced {
        def.push_str(" NOT ENFORCED");
    }
    def
}

/// `COLUMNS.GENERATION_EXPRESSION` を DDL に書ける式に戻す。MySQL はこの列の文字列リテラルを
/// `_utf8mb4\'x\'` のように引用符をバックスラッシュで逃がして返す。
pub fn mysql_generation_expression(expr: &str) -> String {
    unescape_mysql_generation_expression(expr.trim())
}

/// MySQL の `COLUMNS.EXTRA` から生成列が VIRTUAL かを判定する (STORED / PERSISTENT は false)。
pub fn mysql_extra_is_virtual(extra: &str) -> bool {
    extra.to_ascii_uppercase().contains("VIRTUAL")
}

// ───────────────────────── 比較用の正規化 ─────────────────────────

/// 式 (`CHECK (...)` 句全体でも生成式でもよい) を比較用に正規化する。文字列リテラル
/// (`'...'`) と引用付き識別子の外側で空白を畳み、括弧・カンマ・演算子まわりの空白を
/// 取り、小文字にそろえる。生成式は外側の冗長な括弧も外す。
pub fn normalize_expr(expr: &str) -> String {
    let mut out = String::with_capacity(expr.len());
    let mut chars = expr.trim().chars().peekable();
    let mut pending_space = false;
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' | '`' => {
                if pending_space {
                    push_space(&mut out);
                    pending_space = false;
                }
                out.push(c);
                // 閉じ引用符まで原文のまま (二重化による引用符のエスケープを含む)。
                while let Some(n) = chars.next() {
                    out.push(n);
                    if n == c {
                        if chars.peek() == Some(&c) {
                            if let Some(d) = chars.next() {
                                out.push(d);
                            }
                        } else {
                            break;
                        }
                    }
                }
            }
            c if c.is_whitespace() => pending_space = true,
            _ => {
                if pending_space {
                    push_space(&mut out);
                    pending_space = false;
                }
                out.extend(c.to_lowercase());
            }
        }
    }
    // 括弧・カンマ・比較/算術演算子の前後の空白は意味を持たない。
    let mut compact = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_quote: Option<char> = None;
    for (i, &c) in bytes.iter().enumerate() {
        if let Some(q) = in_quote {
            compact.push(c);
            if c == q {
                in_quote = None;
            }
            continue;
        }
        if matches!(c, '\'' | '"' | '`') {
            in_quote = Some(c);
            compact.push(c);
            continue;
        }
        if c == ' ' {
            let prev = compact.chars().last();
            let next = bytes.get(i + 1).copied();
            let tight = |ch: Option<char>| {
                ch.is_some_and(|x| {
                    matches!(
                        x,
                        '(' | ')'
                            | ','
                            | '='
                            | '<'
                            | '>'
                            | '!'
                            | '+'
                            | '-'
                            | '*'
                            | '/'
                            | '%'
                            | '|'
                            | '&'
                    )
                })
            };
            if tight(prev) || tight(next) {
                continue;
            }
        }
        compact.push(c);
    }
    strip_redundant_outer_parens(&compact)
}

/// `CHECK (...)` 句を比較用に正規化する。`CHECK ((x))` と `CHECK (x)`、空白・大小の違いは
/// 同じ扱い。`NOT ENFORCED` などの末尾はそのまま (正規化して) 残す。
pub fn normalize_check(def: &str) -> String {
    let t = def.trim();
    let rest = match t.get(..5) {
        Some(h) if h.eq_ignore_ascii_case("CHECK") => t.get(5..).unwrap_or("").trim_start(),
        _ => return normalize_expr(t),
    };
    let chars: Vec<char> = rest.chars().collect();
    if chars.first() == Some(&'(') {
        if let Some(end) = matching_paren(&chars, 0) {
            let inner: String = chars[1..end].iter().collect();
            let suffix: String = chars[end + 1..].iter().collect();
            return format!(
                "check({}) {}",
                normalize_expr(&inner),
                normalize_expr(&suffix)
            )
            .trim()
            .to_string();
        }
    }
    normalize_expr(t)
}

fn push_space(out: &mut String) {
    if !out.is_empty() {
        out.push(' ');
    }
}

/// `((x))` -> `x`。`(a) and (b)` のように外側の括弧が対でないものは外さない。
/// 先頭が `check` の句 (`check(...)`) はその括弧の内側だけ整える。
fn strip_redundant_outer_parens(s: &str) -> String {
    let mut cur = s.to_string();
    loop {
        let inner = strip_outer_parens(&cur);
        if inner.len() == cur.len() {
            return cur;
        }
        cur = inner.to_string();
    }
}

/// 全体を包む 1 組の括弧を外す (外側の `(` と最後の `)` が対のときだけ)。
pub fn strip_outer_parens(s: &str) -> &str {
    let t = s.trim();
    if !(t.starts_with('(') && t.ends_with(')')) {
        return t;
    }
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    for (i, c) in t.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => quote = Some(c),
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 && i + c.len_utf8() < t.len() {
                    // 最後の `)` より前で閉じる = 外側は 1 つの括弧で包まれていない。
                    return t;
                }
            }
            _ => {}
        }
    }
    t.get(1..t.len() - 1).map(str::trim).unwrap_or(t)
}

// ───────────────────────── SQLite ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Word(String),
    /// 引用符付きの語 (識別子・文字列)。中身は引用符を外した値。
    Quoted(String),
    /// 括弧 1 組の内側 (原文のまま)。
    Group(String),
    Punct(char),
}

/// コメントを空白に置き換える (引用符の中は触らない)。
fn strip_comments(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                out.push(c);
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == c {
                        if chars.get(i + 1) == Some(&c) {
                            i += 1;
                            out.push(c);
                        } else {
                            break;
                        }
                    }
                    i += 1;
                }
                i += 1;
            }
            '[' => {
                out.push(c);
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == ']' {
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                out.push(' ');
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
                out.push(' ');
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// `chars[start]` が開き括弧のとき、対応する閉じ括弧の位置を返す (引用符の中は無視)。
fn matching_paren(chars: &[char], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == c {
                        if chars.get(i + 1) == Some(&c) {
                            i += 1;
                        } else {
                            break;
                        }
                    }
                    i += 1;
                }
            }
            '[' => {
                while i < chars.len() && chars[i] != ']' {
                    i += 1;
                }
            }
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn tokenize(s: &str) -> Vec<Tok> {
    let chars: Vec<char> = s.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '(' {
            match matching_paren(&chars, i) {
                Some(end) => {
                    toks.push(Tok::Group(chars[i + 1..end].iter().collect()));
                    i = end + 1;
                }
                None => break, // 対応しない括弧: 以降は読まない
            }
        } else if matches!(c, '\'' | '"' | '`') {
            let mut val = String::new();
            i += 1;
            while i < chars.len() {
                if chars[i] == c {
                    if chars.get(i + 1) == Some(&c) {
                        val.push(c);
                        i += 2;
                        continue;
                    }
                    break;
                }
                val.push(chars[i]);
                i += 1;
            }
            i += 1;
            toks.push(Tok::Quoted(val));
        } else if c == '[' {
            let mut val = String::new();
            i += 1;
            while i < chars.len() && chars[i] != ']' {
                val.push(chars[i]);
                i += 1;
            }
            i += 1;
            toks.push(Tok::Quoted(val));
        } else if c.is_alphanumeric() || c == '_' || c == '$' {
            let mut w = String::new();
            while i < chars.len()
                && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$')
            {
                w.push(chars[i]);
                i += 1;
            }
            toks.push(Tok::Word(w));
        } else {
            toks.push(Tok::Punct(c));
            i += 1;
        }
    }
    toks
}

/// `CREATE TABLE ... ( body ) ...` の body をトップレベルのカンマで区切る。
fn split_table_body(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    // 最初の `(` (テーブル名の後)。引用符付きの表名の中の `(` は読み飛ばす。
    let mut i = 0;
    let mut open = None;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                i += 1;
                while i < chars.len() && chars[i] != c {
                    i += 1;
                }
            }
            '[' => {
                while i < chars.len() && chars[i] != ']' {
                    i += 1;
                }
            }
            '(' => {
                open = Some(i);
                break;
            }
            _ => {}
        }
        i += 1;
    }
    let Some(open) = open else { return Vec::new() };
    let Some(close) = matching_paren(&chars, open) else {
        return Vec::new();
    };
    let body = &chars[open + 1..close];
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut j = 0;
    while j < body.len() {
        let c = body[j];
        match c {
            '\'' | '"' | '`' => {
                cur.push(c);
                j += 1;
                while j < body.len() {
                    cur.push(body[j]);
                    if body[j] == c {
                        if body.get(j + 1) == Some(&c) {
                            j += 1;
                            cur.push(c);
                        } else {
                            break;
                        }
                    }
                    j += 1;
                }
            }
            '[' => {
                // `[識別子]` 内のカンマ・括弧は区切りにしない。
                cur.push(c);
                j += 1;
                while j < body.len() {
                    cur.push(body[j]);
                    if body[j] == ']' {
                        break;
                    }
                    j += 1;
                }
            }
            '(' => {
                depth += 1;
                cur.push(c);
            }
            ')' => {
                depth -= 1;
                cur.push(c);
            }
            ',' if depth == 0 => {
                items.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
        j += 1;
    }
    if !cur.trim().is_empty() {
        items.push(cur);
    }
    items
}

fn tok_is(t: Option<&Tok>, kw: &str) -> bool {
    matches!(t, Some(Tok::Word(w)) if w.eq_ignore_ascii_case(kw))
}

fn tok_name(t: Option<&Tok>) -> Option<String> {
    match t {
        Some(Tok::Word(w)) | Some(Tok::Quoted(w)) => Some(w.clone()),
        _ => None,
    }
}

fn check_clause(inner: &str) -> String {
    format!("CHECK ({})", inner.trim())
}

/// SQLite の `CREATE TABLE` 文から CHECK 制約 (列レベル・テーブルレベル) と生成列の式を取り出す。
/// `CREATE TABLE` 以外 (`CREATE VIRTUAL TABLE` など) や読めない文は空を返す。無名の CHECK は
/// 名前を空文字にする。
pub fn parse_sqlite_extras(create_sql: &str) -> TableDdlExtras {
    let mut extras = TableDdlExtras::default();
    let sql = strip_comments(create_sql);
    let head: Vec<Tok> = tokenize(&sql).into_iter().take(4).collect();
    let is_create_table = tok_is(head.first(), "CREATE")
        && (tok_is(head.get(1), "TABLE")
            || (matches!(head.get(1), Some(Tok::Word(w)) if w.eq_ignore_ascii_case("TEMP") || w.eq_ignore_ascii_case("TEMPORARY"))
                && tok_is(head.get(2), "TABLE")));
    if !is_create_table {
        return extras;
    }
    for item in split_table_body(&sql) {
        let toks = tokenize(&item);
        if toks.is_empty() {
            continue;
        }
        // テーブル制約: [CONSTRAINT name] CHECK (...)
        let (name, rest) = if tok_is(toks.first(), "CONSTRAINT") {
            (tok_name(toks.get(1)), toks.get(2..).unwrap_or(&[]))
        } else {
            (None, &toks[..])
        };
        if tok_is(rest.first(), "CHECK") {
            if let Some(Tok::Group(inner)) = rest.get(1) {
                extras
                    .checks
                    .push((name.unwrap_or_default(), check_clause(inner)));
            }
            continue;
        }
        if tok_is(toks.first(), "CONSTRAINT")
            || ["PRIMARY", "UNIQUE", "FOREIGN"]
                .iter()
                .any(|k| tok_is(toks.first(), k))
        {
            continue; // CHECK 以外のテーブル制約
        }
        // 列定義: 先頭が列名。以降の制約を走査する。
        let Some(column) = tok_name(toks.first()) else {
            continue;
        };
        let mut pending_name: Option<String> = None;
        let mut i = 1;
        while i < toks.len() {
            if tok_is(toks.get(i), "CONSTRAINT") {
                pending_name = tok_name(toks.get(i + 1));
                i += 2;
                continue;
            }
            if tok_is(toks.get(i), "CHECK") {
                if let Some(Tok::Group(inner)) = toks.get(i + 1) {
                    extras
                        .checks
                        .push((pending_name.take().unwrap_or_default(), check_clause(inner)));
                    i += 2;
                    continue;
                }
            }
            let as_at = if tok_is(toks.get(i), "GENERATED") && tok_is(toks.get(i + 1), "ALWAYS") {
                i + 2
            } else {
                i
            };
            if tok_is(toks.get(as_at), "AS") {
                if let Some(Tok::Group(inner)) = toks.get(as_at + 1) {
                    let mut is_virtual = true; // SQLite の既定は VIRTUAL
                    let mut next = as_at + 2;
                    if tok_is(toks.get(next), "STORED") {
                        is_virtual = false;
                        next += 1;
                    } else if tok_is(toks.get(next), "VIRTUAL") {
                        next += 1;
                    }
                    extras.generated.push(GeneratedColumnInfo::new(
                        column.clone(),
                        inner.trim(),
                        is_virtual,
                    ));
                    i = next;
                    continue;
                }
            }
            pending_name = None;
            i += 1;
        }
    }
    extras
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_check_clause_becomes_check_definition() {
        assert_eq!(
            mysql_check_definition("(`price` > 0)", true),
            "CHECK (`price` > 0)"
        );
        assert_eq!(
            mysql_check_definition("(`a` > 0) and (`b` < 5)", true),
            "CHECK ((`a` > 0) and (`b` < 5))"
        );
        assert_eq!(
            mysql_check_definition("(`a` > 0)", false),
            "CHECK (`a` > 0) NOT ENFORCED"
        );
    }

    #[test]
    fn mysql_generation_expression_unescapes_quotes() {
        assert_eq!(
            mysql_generation_expression("concat(`a`,_utf8mb4\\' \\',`b`)"),
            "concat(`a`,_utf8mb4' ',`b`)"
        );
    }

    #[test]
    fn mysql_check_keeps_doubled_quotes_and_unescapes_backslashes() {
        assert_eq!(
            mysql_check_definition("(`n` <> 'it''s')", true),
            "CHECK (`n` <> 'it''s')"
        );
        assert_eq!(
            mysql_check_definition("(`n` <> _utf8mb4\\'a\\\\b\\')", true),
            "CHECK (`n` <> _utf8mb4'a\\b')"
        );
    }

    #[test]
    fn sqlite_bracket_identifiers_with_commas_do_not_split_items() {
        let sql = "CREATE TABLE t ([a,b] INT CHECK ([a,b] > 0), [c)] INT AS ([a,b] + 1) STORED)";
        let e = parse_sqlite_extras(sql);
        assert_eq!(e.checks.len(), 1, "{e:?}");
        assert_eq!(e.generated.len(), 1, "{e:?}");
        assert_eq!(e.generated[0].column, "c)");
    }

    #[test]
    fn mysql_extra_virtual_detection() {
        assert!(mysql_extra_is_virtual("VIRTUAL GENERATED"));
        assert!(!mysql_extra_is_virtual("STORED GENERATED"));
        assert!(!mysql_extra_is_virtual("auto_increment"));
    }

    #[test]
    fn normalize_check_ignores_redundant_parens_and_keeps_enforcement() {
        assert_eq!(
            normalize_check("CHECK ((price > 0))"),
            normalize_check("check(price>0)")
        );
        assert_ne!(
            normalize_check("CHECK (price > 0)"),
            normalize_check("CHECK (price > 0) NOT ENFORCED")
        );
        assert_ne!(
            normalize_check("CHECK (price > 0)"),
            normalize_check("CHECK (price >= 0)")
        );
    }

    #[test]
    fn strip_outer_parens_only_when_paired() {
        assert_eq!(strip_outer_parens("(a + b)"), "a + b");
        assert_eq!(strip_outer_parens("(a) and (b)"), "(a) and (b)");
        assert_eq!(strip_outer_parens("((a))"), "(a)");
        assert_eq!(strip_outer_parens("('a)' || b)"), "'a)' || b");
    }

    #[test]
    fn normalize_ignores_whitespace_case_and_outer_parens() {
        assert_eq!(
            normalize_expr("CHECK ( price  >  0 )"),
            normalize_expr("check (price>0)")
        );
        assert_eq!(normalize_expr("((a + b))"), normalize_expr("a+b"));
        assert_ne!(normalize_expr("a > 0"), normalize_expr("a > 1"));
        // 文字列リテラルの中は大小も空白も区別する。
        assert_ne!(normalize_expr("a = 'X'"), normalize_expr("a = 'x'"));
        assert_ne!(normalize_expr("a = 'x  y'"), normalize_expr("a = 'x y'"));
    }

    #[test]
    fn sqlite_parses_column_and_table_checks() {
        let sql = "CREATE TABLE p (\n  id INTEGER PRIMARY KEY,\n  price REAL CHECK (price > 0),\n  qty INTEGER CONSTRAINT qty_pos CHECK (qty >= 0) NOT NULL,\n  note TEXT, -- CHECK (ignored)\n  CONSTRAINT price_qty CHECK (price * qty < 1000000),\n  CHECK (length(note) < 'a,b'||'(')\n)";
        let e = parse_sqlite_extras(sql);
        assert_eq!(
            e.checks,
            vec![
                ("".to_string(), "CHECK (price > 0)".to_string()),
                ("qty_pos".to_string(), "CHECK (qty >= 0)".to_string()),
                (
                    "price_qty".to_string(),
                    "CHECK (price * qty < 1000000)".to_string()
                ),
                (
                    "".to_string(),
                    "CHECK (length(note) < 'a,b'||'(')".to_string()
                ),
            ]
        );
        assert!(e.generated.is_empty());
    }

    #[test]
    fn sqlite_parses_generated_columns() {
        let sql = "CREATE TABLE g (a INT, b INT, c INT GENERATED ALWAYS AS (a + b) STORED, \"d e\" TEXT AS (a || '-' || b), f INT AS (a*2) VIRTUAL)";
        let e = parse_sqlite_extras(sql);
        assert_eq!(
            e.generated,
            vec![
                GeneratedColumnInfo::new("c", "a + b", false),
                GeneratedColumnInfo::new("d e", "a || '-' || b", true),
                GeneratedColumnInfo::new("f", "a*2", true),
            ]
        );
        assert!(e.checks.is_empty());
    }

    #[test]
    fn sqlite_default_expression_is_not_a_check_or_generated() {
        let sql = "CREATE TABLE t (a INT DEFAULT (1+2), b TEXT DEFAULT 'CHECK (x)', PRIMARY KEY (a), UNIQUE (b), FOREIGN KEY (a) REFERENCES u(id))";
        assert!(parse_sqlite_extras(sql).is_empty());
    }

    #[test]
    fn sqlite_non_create_table_statements_are_ignored() {
        assert!(parse_sqlite_extras("CREATE INDEX i ON t (a) WHERE a > 0").is_empty());
        assert!(parse_sqlite_extras("CREATE VIRTUAL TABLE v USING fts5(a, b)").is_empty());
        assert!(parse_sqlite_extras("").is_empty());
        assert!(parse_sqlite_extras("CREATE TABLE broken (a INT CHECK (a > ").is_empty());
    }

    #[test]
    fn sqlite_quoted_table_name_with_paren_and_temp() {
        let sql = "CREATE TEMP TABLE \"we(ird\" (a INT CHECK (a > 0))";
        assert_eq!(
            parse_sqlite_extras(sql).checks,
            vec![("".to_string(), "CHECK (a > 0)".to_string())]
        );
    }
}
