use std::time::Instant;

use sqlx::mysql::{MySqlColumn, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::{Column as _, Row, TypeInfo, ValueRef};

use super::types::{Column, PreviewResult, QueryResult, TableColumnInfo, Value};
use super::DbConnectOptions;
use crate::error::{AppError, Result};

/// Snapshot row cap for preview before/after captures. Higher values give
/// better visibility for large tables but cost more bandwidth.
const PREVIEW_ROW_LIMIT: usize = 100;

pub struct MySqlConn {
    pool: MySqlPool,
}

impl MySqlConn {
    pub async fn connect(opts: &DbConnectOptions) -> Result<Self> {
        let mut connect = MySqlConnectOptions::new()
            .host(&opts.host)
            .port(opts.port)
            .username(&opts.user)
            .password(&opts.password);
        if let Some(db) = &opts.database {
            if !db.is_empty() {
                connect = connect.database(db);
            }
        }
        let pool = MySqlPoolOptions::new()
            .min_connections(0)
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(15))
            .connect_with(connect)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn execute(&self, sql: &str) -> Result<QueryResult> {
        let started = Instant::now();
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_query = trimmed.starts_with("select")
            || trimmed.starts_with("show")
            || trimmed.starts_with("describe")
            || trimmed.starts_with("desc ")
            || trimmed.starts_with("explain")
            || trimmed.starts_with("with");

        if is_query {
            let rows: Vec<MySqlRow> = sqlx::query(sql).fetch_all(&self.pool).await?;
            let columns = columns_of(&rows);
            let rows_out = rows.iter().map(row_to_values).collect();
            Ok(QueryResult {
                columns,
                rows: rows_out,
                rows_affected: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        } else {
            let result = sqlx::query(sql).execute(&self.pool).await?;
            Ok(QueryResult::empty(
                result.rows_affected(),
                started.elapsed().as_millis() as u64,
            ))
        }
    }

    /// Runs `sql` inside a transaction that is always rolled back. Captures
    /// the before/after state of the mutation's target table so the caller
    /// can see what the statement would do without persisting it.
    ///
    /// Only INSERT / UPDATE / DELETE / REPLACE are accepted — DDL like
    /// CREATE/DROP/ALTER/TRUNCATE causes an implicit commit on MySQL and so
    /// cannot be safely previewed via rollback.
    pub async fn preview_execute(&self, sql: &str) -> Result<PreviewResult> {
        let trimmed = sql.trim_start().to_ascii_lowercase();
        let is_mutation = trimmed.starts_with("insert")
            || trimmed.starts_with("update")
            || trimmed.starts_with("delete")
            || trimmed.starts_with("replace");
        if !is_mutation {
            return Err(AppError::InvalidInput(
                "preview only supports INSERT/UPDATE/DELETE/REPLACE statements".into(),
            ));
        }

        let target = extract_target_table(sql);
        let limit_sql = target
            .as_ref()
            .map(|t| format!("SELECT * FROM {} LIMIT {}", t, PREVIEW_ROW_LIMIT + 1));

        let mut tx = self.pool.begin().await?;
        let started = Instant::now();

        let before_raw: Vec<MySqlRow> = match &limit_sql {
            Some(q) => sqlx::query(q).fetch_all(&mut *tx).await?,
            None => Vec::new(),
        };

        let result = sqlx::query(sql).execute(&mut *tx).await?;
        let rows_affected = result.rows_affected();

        let after_raw: Vec<MySqlRow> = match &limit_sql {
            Some(q) => sqlx::query(q).fetch_all(&mut *tx).await?,
            None => Vec::new(),
        };

        let elapsed_ms = started.elapsed().as_millis() as u64;
        tx.rollback().await?;

        let truncated =
            before_raw.len() > PREVIEW_ROW_LIMIT || after_raw.len() > PREVIEW_ROW_LIMIT;
        let columns = if let Some(first) = after_raw.first().or_else(|| before_raw.first()) {
            columns_of(std::slice::from_ref(first))
        } else {
            Vec::new()
        };
        let before_rows: Vec<Vec<Value>> = before_raw
            .iter()
            .take(PREVIEW_ROW_LIMIT)
            .map(row_to_values)
            .collect();
        let after_rows: Vec<Vec<Value>> = after_raw
            .iter()
            .take(PREVIEW_ROW_LIMIT)
            .map(row_to_values)
            .collect();

        Ok(PreviewResult {
            target_table: target,
            columns,
            before_rows,
            after_rows,
            rows_affected,
            elapsed_ms,
            truncated,
        })
    }

    pub async fn databases(&self) -> Result<Vec<String>> {
        let rows: Vec<MySqlRow> = sqlx::query("SHOW DATABASES").fetch_all(&self.pool).await?;
        rows.iter().map(|r| decode_text_col(r, 0)).collect()
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<String>> {
        if db.contains('`') {
            return Err(AppError::InvalidInput("invalid database name".into()));
        }
        let sql = format!("SHOW TABLES IN `{}`", db);
        let rows: Vec<MySqlRow> = sqlx::query(&sql).fetch_all(&self.pool).await?;
        rows.iter().map(|r| decode_text_col(r, 0)).collect()
    }

    pub async fn columns(&self, db: &str, table: &str) -> Result<Vec<TableColumnInfo>> {
        let rows: Vec<MySqlRow> = sqlx::query(
            r#"SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA
               FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
               ORDER BY ORDINAL_POSITION"#,
        )
        .bind(db)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| TableColumnInfo {
                name: r.try_get::<String, _>(0).unwrap_or_default(),
                data_type: r.try_get::<String, _>(1).unwrap_or_default(),
                nullable: r
                    .try_get::<String, _>(2)
                    .map(|s| s.eq_ignore_ascii_case("YES"))
                    .unwrap_or(false),
                key: r.try_get::<String, _>(3).unwrap_or_default(),
                default: r.try_get::<Option<String>, _>(4).ok().flatten(),
                extra: r.try_get::<String, _>(5).unwrap_or_default(),
            })
            .collect())
    }
}

// MySQL 8 marks the `Database` column of `SHOW DATABASES` (and `Tables_in_*`
// from `SHOW TABLES`) with the BINARY flag, which makes sqlx's `String`
// decoder refuse the column. Read raw bytes and convert manually so the same
// code works across MySQL 8 and MariaDB.
fn decode_text_col(row: &MySqlRow, i: usize) -> Result<String> {
    let bytes: Vec<u8> = row.try_get(i)?;
    String::from_utf8(bytes).map_err(|e| AppError::Other(e.to_string()))
}

fn columns_of(rows: &[MySqlRow]) -> Vec<Column> {
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    first
        .columns()
        .iter()
        .map(|c: &MySqlColumn| Column {
            name: c.name().to_string(),
            type_name: c.type_info().name().to_string(),
        })
        .collect()
}

fn row_to_values(row: &MySqlRow) -> Vec<Value> {
    (0..row.columns().len())
        .map(|i| decode_cell(row, i))
        .collect()
}

fn decode_cell(row: &MySqlRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();

    // Try common scalar decodings first based on declared type, then fall back to string.
    if matches!(
        type_name.as_str(),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR"
    ) {
        if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            return v.map(Value::Int).unwrap_or(Value::Null);
        }
    }
    if matches!(
        type_name.as_str(),
        "TINYINT UNSIGNED"
            | "SMALLINT UNSIGNED"
            | "MEDIUMINT UNSIGNED"
            | "INT UNSIGNED"
            | "BIGINT UNSIGNED"
    ) {
        if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
            return v.map(Value::UInt).unwrap_or(Value::Null);
        }
    }
    if matches!(type_name.as_str(), "FLOAT" | "DOUBLE") {
        if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
            return v.map(Value::Float).unwrap_or(Value::Null);
        }
    }
    if type_name == "BOOLEAN" {
        if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            return v.map(Value::Bool).unwrap_or(Value::Null);
        }
    }
    if type_name == "DECIMAL" || type_name == "NEWDECIMAL" {
        if let Ok(v) = row.try_get::<Option<rust_decimal::Decimal>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if matches!(
        type_name.as_str(),
        "DATE" | "TIME" | "DATETIME" | "TIMESTAMP"
    ) {
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDateTime>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
        if let Ok(v) = row.try_get::<Option<chrono::NaiveDate>, _>(i) {
            return v
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if matches!(type_name.as_str(), "JSON") {
        if let Ok(v) = row.try_get::<Option<serde_json::Value>, _>(i) {
            return v
                .map(|j| Value::String(j.to_string()))
                .unwrap_or(Value::Null);
        }
    }
    if matches!(
        type_name.as_str(),
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY"
    ) {
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            return v
                .map(|b| Value::Bytes(data_encoding::HEXLOWER.encode(&b)))
                .unwrap_or(Value::Null);
        }
    }

    // Default: string (covers VARCHAR/TEXT/ENUM/SET/CHAR and unknown types)
    match row.try_get::<Option<String>, _>(i) {
        Ok(Some(s)) => Value::String(s),
        Ok(None) => Value::Null,
        Err(_) => match row.try_get::<Option<Vec<u8>>, _>(i) {
            Ok(Some(b)) => Value::Bytes(data_encoding::HEXLOWER.encode(&b)),
            _ => Value::Null,
        },
    }
}

/// Best-effort extraction of the target table from a mutation statement.
/// Returns `None` for shapes we don't confidently recognise (multi-table
/// UPDATE/DELETE, embedded subqueries, etc.) — callers fall back to a
/// snapshot-less preview in that case. The returned string is taken verbatim
/// from the user's SQL so quoting/qualification is preserved.
fn extract_target_table(sql: &str) -> Option<String> {
    let tokens = tokenize_sql(sql);
    let mut iter = tokens.into_iter().peekable();
    let first = iter.next()?;
    match first.to_ascii_lowercase().as_str() {
        "update" => {
            skip_modifiers(&mut iter, &["low_priority", "ignore"]);
            let table = iter.next()?;
            // Reject multi-table UPDATE (next token is `,` swallowed → next is another identifier
            // before `set`). If we see anything other than `set` next, give up.
            if !iter.peek().is_some_and(|t| t.eq_ignore_ascii_case("set")) {
                return None;
            }
            Some(table)
        }
        "delete" => {
            skip_modifiers(&mut iter, &["low_priority", "quick", "ignore"]);
            // Single-table DELETE form: `DELETE FROM tbl ...`. Multi-table
            // (`DELETE t1 FROM t1 JOIN t2 ...`) doesn't begin with FROM.
            let next = iter.next()?;
            if !next.eq_ignore_ascii_case("from") {
                return None;
            }
            iter.next()
        }
        "insert" | "replace" => {
            skip_modifiers(
                &mut iter,
                &["low_priority", "delayed", "high_priority", "ignore"],
            );
            let mut next = iter.next()?;
            if next.eq_ignore_ascii_case("into") {
                next = iter.next()?;
            }
            Some(next)
        }
        _ => None,
    }
}

fn skip_modifiers<I: Iterator<Item = String>>(
    iter: &mut std::iter::Peekable<I>,
    modifiers: &[&str],
) {
    while let Some(t) = iter.peek() {
        let lc = t.to_ascii_lowercase();
        if modifiers.iter().any(|m| *m == lc) {
            iter.next();
        } else {
            break;
        }
    }
}

/// Split SQL into whitespace/punctuation-delimited tokens while keeping
/// backtick-quoted identifiers intact, including dotted forms like
/// `` `db`.`table` ``. Comments are stripped first.
fn tokenize_sql(sql: &str) -> Vec<String> {
    let cleaned = strip_sql_comments(sql);
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_backtick = false;
    for c in cleaned.chars() {
        if in_backtick {
            cur.push(c);
            if c == '`' {
                in_backtick = false;
            }
        } else if c == '`' {
            cur.push(c);
            in_backtick = true;
        } else if c.is_whitespace() || c == '(' || c == ')' || c == ',' || c == ';' {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

fn strip_sql_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '-' if matches!(chars.peek(), Some('-')) => {
                chars.next();
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '#' => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if matches!(chars.peek(), Some('*')) => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_update() {
        assert_eq!(
            extract_target_table("UPDATE users SET name = 'a' WHERE id = 1"),
            Some("users".into())
        );
    }

    #[test]
    fn parses_qualified_update() {
        assert_eq!(
            extract_target_table("update `mydb`.`users` set name = 'a'"),
            Some("`mydb`.`users`".into())
        );
    }

    #[test]
    fn parses_delete() {
        assert_eq!(
            extract_target_table("DELETE FROM orders WHERE id > 10"),
            Some("orders".into())
        );
        assert_eq!(
            extract_target_table("DELETE LOW_PRIORITY IGNORE FROM orders"),
            Some("orders".into())
        );
    }

    #[test]
    fn parses_insert_and_replace() {
        assert_eq!(
            extract_target_table("INSERT INTO products (name) VALUES ('x')"),
            Some("products".into())
        );
        assert_eq!(
            extract_target_table("REPLACE INTO products (id, name) VALUES (1, 'x')"),
            Some("products".into())
        );
        assert_eq!(
            extract_target_table("insert ignore into `t` set a = 1"),
            Some("`t`".into())
        );
    }

    #[test]
    fn rejects_multi_table_update() {
        assert!(extract_target_table("UPDATE a JOIN b ON a.id=b.id SET a.x=1").is_none());
        assert!(extract_target_table("UPDATE a, b SET a.x = b.x WHERE a.id = b.id").is_none());
    }

    #[test]
    fn rejects_non_mutation() {
        assert!(extract_target_table("SELECT * FROM users").is_none());
        assert!(extract_target_table("CREATE TABLE t (id INT)").is_none());
    }

    #[test]
    fn strips_comments_before_parsing() {
        let sql = "/* comment */ -- line\n# hash\nUPDATE users SET x = 1";
        assert_eq!(extract_target_table(sql), Some("users".into()));
    }
}
