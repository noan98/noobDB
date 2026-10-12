//! DDL 文が影響するテーブルの特定 (#1539)。
//!
//! Schema Cache の無効化は従来「DDL 相当なら接続全体を丸ごと」だった。`ALTER TABLE` や
//! `CREATE INDEX` のように対象が 1 つのテーブルと分かる文だけは、そのテーブルの
//! エントリだけを捨てれば足りる (他のテーブルの列・インデックス情報の再取得が要らない)。
//!
//! ここは**認識できた単純な形だけ** `Some` を返し、少しでも怪しければ `None`
//! (= 呼び出し側は従来どおり丸ごと無効化) に倒す fail-closed な判定:
//! - `ALTER TABLE [IF EXISTS] [ONLY] <tbl> ...` — ただし `RENAME` / `SET SCHEMA` /
//!   パーティションの付け外し / 継承の変更など、他のテーブルや名前そのものに効くものは除く。
//! - `CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX [CONCURRENTLY] [IF NOT EXISTS] [<name>] ON [ONLY] <tbl> ...`
//! - `DROP INDEX <name> ON <tbl>` (MySQL 形式。対象テーブルが書かれていない形は `None`)
//!
//! 文は 1 つだけ (末尾の `;` は可)。MySQL の実行可能コメント (`/*! ... */`) や PostgreSQL の
//! ドル引用符は解析せず `None` にする。

use super::DriverKind;

/// 影響するテーブル: `(スキーマ / DB 修飾, テーブル名)`。修飾が無ければ `None`。
pub type SchemaChangeTable = (Option<String>, String);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    /// 引用符なしの語 (キーワード・素の識別子)。
    Word(String),
    /// 引用符つき識別子。
    Ident(String),
    /// 文字列リテラル (中身は使わない)。
    Str,
    Punct(char),
}

impl Tok {
    fn is_kw(&self, kw: &str) -> bool {
        matches!(self, Tok::Word(w) if w.eq_ignore_ascii_case(kw))
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// 字句に分ける。解析できない構文 (実行可能コメント・ドル引用符・閉じていない引用) は `None`。
fn lex(driver: DriverKind, sql: &str) -> Option<Vec<Tok>> {
    let chars: Vec<char> = sql.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && chars.get(i + 1) == Some(&'-') {
            // MySQL の `--` は直後が空白・制御文字のときだけコメント。
            let comment = driver != DriverKind::Mysql
                || chars
                    .get(i + 2)
                    .is_none_or(|n| n.is_whitespace() || n.is_control());
            if !comment {
                toks.push(Tok::Punct('-'));
                i += 1;
                continue;
            }
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '#' && driver == DriverKind::Mysql {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            if chars.get(i + 2) == Some(&'!') {
                return None;
            }
            i += 2;
            loop {
                if i + 1 >= chars.len() {
                    return None;
                }
                if chars[i] == '*' && chars[i + 1] == '/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if c == '$'
            && driver == DriverKind::Postgres
            && chars
                .get(i + 1)
                .is_some_and(|n| *n == '$' || n.is_alphabetic())
        {
            return None;
        } else if c == '\'' || (c == '"' && driver == DriverKind::Mysql) {
            let quote = c;
            i += 1;
            loop {
                let ch = *chars.get(i)?;
                if driver == DriverKind::Mysql && ch == '\\' {
                    i += 2;
                    continue;
                }
                if ch == quote {
                    if chars.get(i + 1) == Some(&quote) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            toks.push(Tok::Str);
        } else if c == '`' || c == '"' || (c == '[' && driver == DriverKind::Sqlite) {
            let close = if c == '[' { ']' } else { c };
            i += 1;
            let mut name = String::new();
            loop {
                let ch = *chars.get(i)?;
                if ch == close {
                    if close != ']' && chars.get(i + 1) == Some(&close) {
                        name.push(close);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                name.push(ch);
                i += 1;
            }
            toks.push(Tok::Ident(name));
        } else if is_word_char(c) {
            let start = i;
            while i < chars.len() && is_word_char(chars[i]) {
                i += 1;
            }
            toks.push(Tok::Word(chars[start..i].iter().collect()));
        } else {
            toks.push(Tok::Punct(c));
            i += 1;
        }
    }
    Some(toks)
}

/// `tok[pos..]` から `a`・`a.b` の形の名前を読む。`(修飾, 名前, 次の位置)`。3 部名は `None`。
fn parse_qualified(toks: &[Tok], pos: usize) -> Option<(Option<String>, String, usize)> {
    let name_of = |t: &Tok| match t {
        Tok::Word(w) | Tok::Ident(w) => Some(w.clone()),
        _ => None,
    };
    let first = name_of(toks.get(pos)?)?;
    if toks.get(pos + 1) == Some(&Tok::Punct('.')) {
        let second = name_of(toks.get(pos + 2)?)?;
        if toks.get(pos + 3) == Some(&Tok::Punct('.')) {
            return None;
        }
        Some((Some(first), second, pos + 3))
    } else {
        Some((None, first, pos + 1))
    }
}

/// 他のテーブルや名前そのものに効くため、単一テーブル扱いにできない語。
const UNSCOPED_WORDS: &[&str] = &[
    "rename",
    "schema",
    "partition",
    "partitions",
    "inherit",
    "attach",
    "detach",
    "exchange",
    "swap",
];

/// `sql` が単一テーブルだけに効く単純な DDL なら、そのテーブルを返す。それ以外は `None`。
pub fn sql_schema_change_table(driver: DriverKind, sql: &str) -> Option<SchemaChangeTable> {
    let mut toks = lex(driver, sql)?;
    // 末尾の `;` は許す。途中の `;` (複数文) は対象外。
    if toks.last() == Some(&Tok::Punct(';')) {
        toks.pop();
    }
    if toks.iter().any(|t| *t == Tok::Punct(';')) {
        return None;
    }
    let first = toks.first()?;
    if first.is_kw("alter") && toks.get(1)?.is_kw("table") {
        let mut pos = 2;
        if toks.get(pos)?.is_kw("if") && toks.get(pos + 1)?.is_kw("exists") {
            pos += 2;
        }
        if toks.get(pos)?.is_kw("only") {
            pos += 1;
        }
        let (schema, table, next) = parse_qualified(&toks, pos)?;
        let unscoped = toks[next..].iter().any(|t| match t {
            Tok::Word(w) => UNSCOPED_WORDS.iter().any(|u| w.eq_ignore_ascii_case(u)),
            _ => false,
        });
        return (!unscoped).then_some((schema, table));
    }
    if first.is_kw("create") || first.is_kw("drop") {
        let is_create = first.is_kw("create");
        let idx_pos = toks.iter().position(|t| t.is_kw("index"))?;
        // `CREATE` / `DROP` と `INDEX` の間に来てよいのは修飾語だけ (`CREATE TABLE ... INDEX` を除く)。
        let allowed = ["unique", "fulltext", "spatial", "clustered", "nonclustered"];
        let prefix_ok = toks[1..idx_pos].iter().all(
            |t| matches!(t, Tok::Word(w) if allowed.iter().any(|a| w.eq_ignore_ascii_case(a))),
        );
        if !prefix_ok {
            return None;
        }
        // `ON` の次が対象テーブル。CREATE はインデックス名の後、DROP は MySQL 形式のみ。
        let on_pos = (idx_pos + 1..toks.len()).find(|&p| toks[p].is_kw("on"))?;
        if is_create {
            // 最初の `(` より前の `ON` だけを採る (式インデックス内の語に釣られない)。
            let paren = toks.iter().position(|t| *t == Tok::Punct('('));
            if paren.is_some_and(|p| p < on_pos) {
                return None;
            }
        }
        let mut pos = on_pos + 1;
        if toks.get(pos)?.is_kw("only") {
            pos += 1;
        }
        let (schema, table, next) = parse_qualified(&toks, pos)?;
        let unscoped = toks[next..].iter().any(|t| match t {
            Tok::Word(w) => UNSCOPED_WORDS.iter().any(|u| w.eq_ignore_ascii_case(u)),
            _ => false,
        });
        return (!unscoped).then_some((schema, table));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use DriverKind::{Mysql, Postgres, Sqlite};

    fn t(driver: DriverKind, sql: &str) -> Option<(Option<&'static str>, &'static str)> {
        // テスト用に 'static へ漏らして比較しやすくする。
        sql_schema_change_table(driver, sql).map(|(s, n)| {
            (
                s.map(|x| &*Box::leak(x.into_boxed_str())),
                &*Box::leak(n.into_boxed_str()),
            )
        })
    }

    #[test]
    fn alter_table_resolves_the_single_table() {
        assert_eq!(
            t(Mysql, "ALTER TABLE `users` ADD COLUMN age INT"),
            Some((None, "users"))
        );
        assert_eq!(
            t(
                Postgres,
                "alter table if exists only \"public\".\"Orders\" drop column x;"
            ),
            Some((Some("public"), "Orders"))
        );
        assert_eq!(
            t(Sqlite, "-- メモ\nALTER TABLE [t 1] ADD c TEXT"),
            Some((None, "t 1"))
        );
        assert_eq!(
            t(
                Mysql,
                "/* c */ ALTER TABLE db1.t MODIFY COLUMN a BIGINT NOT NULL"
            ),
            Some((Some("db1"), "t"))
        );
    }

    #[test]
    fn alter_table_that_touches_other_names_is_not_scoped() {
        for sql in [
            "ALTER TABLE a RENAME TO b",
            "ALTER TABLE a RENAME COLUMN x TO y",
            "ALTER TABLE a SET SCHEMA other",
            "ALTER TABLE a ATTACH PARTITION p FOR VALUES IN (1)",
            "ALTER TABLE a DETACH PARTITION p",
            "ALTER TABLE a INHERIT parent",
            "ALTER TABLE a EXCHANGE PARTITION p WITH TABLE b",
        ] {
            assert_eq!(sql_schema_change_table(Postgres, sql), None, "{sql}");
        }
        // 3 部名・複数文・実行可能コメント・ドル引用符は解析しない。
        assert_eq!(
            sql_schema_change_table(Postgres, "ALTER TABLE c.s.t ADD x INT"),
            None
        );
        assert_eq!(
            sql_schema_change_table(Mysql, "ALTER TABLE a ADD x INT; ALTER TABLE b ADD y INT"),
            None
        );
        assert_eq!(
            sql_schema_change_table(Mysql, "/*! ALTER TABLE a ADD x INT */"),
            None
        );
        assert_eq!(
            sql_schema_change_table(Postgres, "ALTER TABLE a ADD x TEXT DEFAULT $$a$$"),
            None
        );
        // コメントや文字列に隠れた語には反応しない。
        assert_eq!(
            t(Mysql, "ALTER TABLE a COMMENT 'rename schema' -- partition"),
            Some((None, "a"))
        );
    }

    #[test]
    fn create_and_drop_index_resolve_the_table() {
        assert_eq!(
            t(Mysql, "CREATE UNIQUE INDEX `idx_u` ON `users` (`email`)"),
            Some((None, "users"))
        );
        assert_eq!(
            t(
                Postgres,
                "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON public.orders USING btree (a)"
            ),
            Some((Some("public"), "orders"))
        );
        assert_eq!(t(Postgres, "CREATE INDEX ON ONLY t (a)"), Some((None, "t")));
        assert_eq!(t(Sqlite, "CREATE INDEX i ON t(a, b)"), Some((None, "t")));
        // MySQL の DROP INDEX は ON <tbl> がある形だけ。
        assert_eq!(t(Mysql, "DROP INDEX idx ON db.t"), Some((Some("db"), "t")));
        assert_eq!(sql_schema_change_table(Postgres, "DROP INDEX idx"), None);
        assert_eq!(sql_schema_change_table(Sqlite, "DROP INDEX idx"), None);
    }

    #[test]
    fn other_statements_are_not_scoped() {
        for sql in [
            "SELECT 1",
            "CREATE TABLE t (id INT, INDEX i (id))",
            "DROP TABLE t",
            "TRUNCATE t",
            "CREATE VIEW v AS SELECT * FROM t",
            "COMMENT ON TABLE t IS 'x'",
            "ALTER INDEX i RENAME TO j",
            "",
        ] {
            assert_eq!(sql_schema_change_table(Postgres, sql), None, "{sql}");
        }
    }
}
