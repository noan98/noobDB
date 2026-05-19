use std::time::Instant;

use sqlx::mysql::{MySqlColumn, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::{Column as _, Row, TypeInfo, ValueRef};

use super::types::{Column, QueryResult, TableColumnInfo, Value};
use super::DbConnectOptions;
use crate::error::{AppError, Result};

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

    pub async fn databases(&self) -> Result<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    pub async fn tables(&self, db: &str) -> Result<Vec<String>> {
        if db.contains('`') {
            return Err(AppError::InvalidInput("invalid database name".into()));
        }
        let sql = format!("SHOW TABLES IN `{}`", db);
        let rows: Vec<(String,)> = sqlx::query_as(&sql).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
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
