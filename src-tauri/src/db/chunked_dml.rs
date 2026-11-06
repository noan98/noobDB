//! 大規模 DML のチャンク分割実行 (#2020) の SQL 生成。副作用のない純関数。
//!
//! 利用者が指定するのは「テーブル・操作 (DELETE / UPDATE の SET 句)・WHERE 条件・バッチサイズ」
//! だけで、任意の 1 文を書き換えることはしない。1 バッチ分の文を次の形で組み立てる。
//!
//! - MySQL: `DELETE FROM t WHERE (cond) LIMIT n` / `UPDATE t SET ... WHERE (cond) LIMIT n`
//! - PostgreSQL: `... WHERE (tableoid, ctid) IN (SELECT tableoid, ctid FROM t WHERE (cond) LIMIT n)`
//!   (ctid は子表ごとに独立なので、パーティション表・継承表では tableoid と組にする)
//! - SQLite: `... WHERE rowid IN (SELECT rowid FROM t WHERE (cond) LIMIT n)`
//!
//! WHERE / SET は利用者が書いた SQL 断片なので、文を抜けたりコメントで閉じ括弧を食わせたり
//! できないよう [`validate_fragment`] で弾く (ベストエフォートの fail-closed)。
//! フロントの `components/chunkedDml.ts` が同じ生成をミラーし、両者を
//! `src/__tests__/fixtures/chunkedDmlVectors.json` の共有ゴールデンベクタで固定する。

use super::data_search::qualified_table;
use super::DriverKind;

/// 1 バッチの行数の上限。
pub const MAX_BATCH_SIZE: u32 = 100_000;

/// 操作の種類。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkedOp {
    Delete,
    /// `SET` の右辺 (`status = 'x', n = n + 1` など。`SET` 自体は含めない)。
    Update {
        set_clause: String,
    },
}

/// 生成の拒否理由。`code()` はフロントと共有するゴールデンの識別子。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkedDmlError {
    EmptyTable,
    EmptyWhere,
    EmptySet,
    BadBatchSize,
    /// 引用符の外に `;` がある (文の追加を防ぐ)。
    StackedStatement,
    /// 引用符の外にコメント開始がある (閉じ括弧や LIMIT を食わせない)。
    Comment,
    /// 引用符や括弧が閉じていない・閉じ括弧が多い。
    Unbalanced,
    /// 安全に解釈できない記法 (PostgreSQL のドル引用・E 文字列)。
    Unsupported,
}

impl ChunkedDmlError {
    pub fn code(self) -> &'static str {
        match self {
            Self::EmptyTable => "emptyTable",
            Self::EmptyWhere => "emptyWhere",
            Self::EmptySet => "emptySet",
            Self::BadBatchSize => "badBatchSize",
            Self::StackedStatement => "stackedStatement",
            Self::Comment => "comment",
            Self::Unbalanced => "unbalanced",
            Self::Unsupported => "unsupported",
        }
    }
}

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// WHERE / SET の断片が「1 つの式として安全に括弧へ入れられる」ことを確かめる。
pub fn validate_fragment(driver: DriverKind, frag: &str) -> Result<(), ChunkedDmlError> {
    let chars: Vec<char> = frag.chars().collect();
    let mysql = driver == DriverKind::Mysql;
    let mut depth: i32 = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' | '[' if c != '[' || driver == DriverKind::Sqlite => {
                // PostgreSQL の E'..' は `\'` で閉じない解釈が要るので扱わない。
                if c == '\'' && driver == DriverKind::Postgres && i > 0 {
                    let prev = chars[i - 1];
                    let before_ok = i < 2 || !is_ident_char(chars[i - 2]);
                    if (prev == 'e' || prev == 'E') && before_ok {
                        return Err(ChunkedDmlError::Unsupported);
                    }
                }
                let mut j = i + 1;
                let mut closed = false;
                // SQLite の `[ident]` は `]` で閉じる (二重化なし)。
                if c == '[' {
                    while j < chars.len() && chars[j] != ']' {
                        j += 1;
                    }
                    if j >= chars.len() {
                        return Err(ChunkedDmlError::Unbalanced);
                    }
                    // `]` 自身は次の周回で通常文字として読み飛ばされる (`j + 1` と書くと
                    // `j * 1` が同値変異になるので加算を避ける)。
                    i = j;
                    continue;
                }
                while j < chars.len() {
                    if mysql && chars[j] == '\\' && c != '`' {
                        j += 2;
                        continue;
                    }
                    if chars[j] == c {
                        if chars.get(j + 1) == Some(&c) {
                            j += 2;
                            continue;
                        }
                        closed = true;
                        break;
                    }
                    j += 1;
                }
                if !closed {
                    return Err(ChunkedDmlError::Unbalanced);
                }
                i = j + 1;
                continue;
            }
            ';' => return Err(ChunkedDmlError::StackedStatement),
            '-' if chars.get(i + 1) == Some(&'-') => return Err(ChunkedDmlError::Comment),
            '/' if chars.get(i + 1) == Some(&'*') => return Err(ChunkedDmlError::Comment),
            '#' if mysql => return Err(ChunkedDmlError::Comment),
            '$' if driver == DriverKind::Postgres => return Err(ChunkedDmlError::Unsupported),
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err(ChunkedDmlError::Unbalanced);
                }
            }
            _ => {}
        }
        i += 1;
    }
    if depth != 0 {
        return Err(ChunkedDmlError::Unbalanced);
    }
    Ok(())
}

fn check_common(
    driver: DriverKind,
    table: &str,
    where_clause: &str,
    batch_size: u32,
) -> Result<(), ChunkedDmlError> {
    if table.trim().is_empty() {
        return Err(ChunkedDmlError::EmptyTable);
    }
    if where_clause.trim().is_empty() {
        return Err(ChunkedDmlError::EmptyWhere);
    }
    if batch_size == 0 || batch_size > MAX_BATCH_SIZE {
        return Err(ChunkedDmlError::BadBatchSize);
    }
    validate_fragment(driver, where_clause)
}

/// 1 バッチ分の DML を組み立てる (末尾のセミコロンなし)。`row_key` は SQLite のときだけ使う
/// (`rowid` / `_rowid_` / `oid` のうち実列に隠されていないもの。普通は `rowid`)。
pub fn build_chunk_sql(
    driver: DriverKind,
    database: Option<&str>,
    table: &str,
    op: &ChunkedOp,
    where_clause: &str,
    batch_size: u32,
    row_key: &str,
) -> Result<String, ChunkedDmlError> {
    check_common(driver, table, where_clause, batch_size)?;
    let head = match op {
        ChunkedOp::Delete => "DELETE FROM ".to_string(),
        ChunkedOp::Update { set_clause } => {
            if set_clause.trim().is_empty() {
                return Err(ChunkedDmlError::EmptySet);
            }
            validate_fragment(driver, set_clause)?;
            "UPDATE ".to_string()
        }
    };
    let name = qualified_table(driver, database, table);
    let cond = where_clause.trim();
    let set = match op {
        ChunkedOp::Delete => String::new(),
        ChunkedOp::Update { set_clause } => format!(" SET {}", set_clause.trim()),
    };
    Ok(match driver {
        DriverKind::Mysql => format!("{head}{name}{set} WHERE ({cond}) LIMIT {batch_size}"),
        DriverKind::Postgres => format!(
            "{head}{name}{set} WHERE (tableoid, ctid) IN (SELECT tableoid, ctid FROM {name} WHERE ({cond}) LIMIT {batch_size})"
        ),
        DriverKind::Sqlite => format!(
            "{head}{name}{set} WHERE {row_key} IN (SELECT {row_key} FROM {name} WHERE ({cond}) LIMIT {batch_size})"
        ),
    })
}

/// 対象件数を数える SELECT (事前確認と最大バッチ数の算出に使う)。
pub fn build_count_sql(
    driver: DriverKind,
    database: Option<&str>,
    table: &str,
    where_clause: &str,
) -> Result<String, ChunkedDmlError> {
    check_common(driver, table, where_clause, 1)?;
    Ok(format!(
        "SELECT COUNT(*) FROM {} WHERE ({})",
        qualified_table(driver, database, table),
        where_clause.trim()
    ))
}

/// SQLite で行を指す別名を選ぶ。`rowid` / `_rowid_` / `oid` のうち、同名の実列が無い最初のもの。
/// 3 つとも実列に使われていれば `None` (行を指せないので拒否する)。
pub fn pick_sqlite_row_key(column_names: &[String]) -> Option<&'static str> {
    ["rowid", "_rowid_", "oid"]
        .into_iter()
        .find(|k| !column_names.iter().any(|c| c.eq_ignore_ascii_case(k)))
}

/// MySQL の `sql_mode` が断片の解釈をずらすか。`NO_BACKSLASH_ESCAPES` は `\` の扱い、
/// `ANSI_QUOTES` は `"` の意味 (識別子)、が変わり、検査 (`validate_fragment`) の前提と食い違う。
pub fn mysql_sql_mode_is_unsafe(sql_mode: &str) -> bool {
    sql_mode.split(',').map(str::trim).any(|m| {
        m.eq_ignore_ascii_case("NO_BACKSLASH_ESCAPES") || m.eq_ignore_ascii_case("ANSI_QUOTES")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_key_falls_back_when_shadowed() {
        let cols = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(pick_sqlite_row_key(&cols(&["id"])), Some("rowid"));
        assert_eq!(pick_sqlite_row_key(&cols(&["RowId"])), Some("_rowid_"));
        assert_eq!(
            pick_sqlite_row_key(&cols(&["rowid", "_rowid_"])),
            Some("oid")
        );
        assert_eq!(
            pick_sqlite_row_key(&cols(&["rowid", "_rowid_", "OID"])),
            None
        );
    }

    #[test]
    fn sql_mode_detection() {
        assert!(mysql_sql_mode_is_unsafe(
            "STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES"
        ));
        assert!(mysql_sql_mode_is_unsafe("ansi_quotes"));
        assert!(!mysql_sql_mode_is_unsafe("STRICT_TRANS_TABLES,ANSI"));
        assert!(!mysql_sql_mode_is_unsafe(""));
    }
}
