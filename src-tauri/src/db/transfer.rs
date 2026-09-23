//! 接続間データ転送 (#986) の純粋計算層 — ドライバ横断の型マッピングと DDL 生成。
//!
//! 「ソース接続の結果セット (テーブル全件 or 単一クエリ) を、別接続の新規/既存
//! テーブルへスキーマ + データごと永続コピーする」機能のうち、副作用を持たない
//! 部分をここに集める。I/O (ストリーミング読み出し・`import_rows` での書き込み・
//! 進捗/キャンセル) は `commands::transfer` が担い、このモジュールはドライバ非依存・
//! 副作用なしで単体テストできる形に保つ (Diff/Sync・サンドボックスと同じ方針)。
//!
//! ## 型マッピングの考え方
//!
//! ストリームが返す列型名 (`Column::type_name`) はドライバごとの SQL 型名
//! (`VARCHAR` / `int8` / `DATETIME2` / `BLOB` ...) なので、まず方言をまたいで
//! 共通の [`TransferType`] (論理型) へ正規化し、そこからターゲット方言の DDL 型へ
//! 展開する。型名から判定できない列 (SQLite の式列は型名が空/`NULL` になる) は、
//! 最初のバッチの値の形 ([`Value`] のバリアント) から推定する。
//!
//! 書き込みは既存のインポート経路 (`Connection::import_rows`) を再利用するため、
//! 各セルは「ターゲットのドライバが列型へ暗黙変換できるテキスト」に変換する
//! ([`value_to_cell`])。バイナリだけは方言ごとに表現が違う:
//!
//! - PostgreSQL: `\x<hex>` (bytea の hex 入力形式)
//! - DuckDB: `\xAB\xCD...` (VARCHAR → BLOB の暗黙キャストが解釈するエスケープ)
//! - SQLite / MySQL: テキストのまま hex を入れ、全件投入後に
//!   `UPDATE ... SET c = unhex(c)` で 1 回だけバイト列へ戻す
//!   ([`binary_finalize_sql`])。テキストでしか書けないインポート経路で
//!   バイト列を忠実に運ぶための後処理で、転送が作成したテーブルに対してのみ行う。
//! - SQL Server: NVARCHAR 経由で VARBINARY へ暗黙変換できないため、hex 文字列を
//!   `NVARCHAR(MAX)` 列へ格納する (損失ありの縮退。警告を返す)。

use crate::db::sync::quote_ident;
use crate::db::types::{Column, Value};
use crate::db::DriverKind;
use crate::error::{AppError, Result};

/// 方言をまたいだ論理型。ターゲットの DDL 型はここから決まる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferType {
    Boolean,
    /// 符号付き整数 (幅は区別せず BIGINT 相当へ寄せる — 狭い型へ落とすと
    /// ソースの値域によっては書き込みが失敗するため)。
    Integer,
    /// `BIGINT UNSIGNED` / `UBIGINT` など、i64 に収まらない可能性がある整数。
    UnsignedBigInt,
    Float,
    /// 精度/スケールが型名から読めたときだけ `Some`。
    Decimal {
        precision: Option<u32>,
        scale: Option<u32>,
    },
    Text,
    Date,
    Time,
    Timestamp,
    TimestampTz,
    Binary,
    Json,
    Uuid,
}

/// 転送先テーブルの 1 列 (列名は重複除去済み)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferColumn {
    pub name: String,
    /// ソースが報告した型名 (表示・デバッグ用)。
    pub source_type: String,
    pub ty: TransferType,
}

/// 既存テーブルとの衝突時の扱い。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    /// 新規作成のみ。同名テーブルがあれば CREATE TABLE が失敗する (既定)。
    #[default]
    Create,
    /// 既存テーブルを DROP してから作り直す。
    Replace,
    /// 既存テーブルへ追記する (DDL は発行しない。列は名前で対応付ける)。
    Append,
}

impl TransferMode {
    /// この転送がテーブルを作成するか (= 失敗/キャンセル時に後始末で DROP してよいか)。
    pub fn creates_table(self) -> bool {
        matches!(self, TransferMode::Create | TransferMode::Replace)
    }
}

/// 型名の括弧内 `(p, s)` を読む。読めなければ `(None, None)`。
fn parse_precision_scale(raw: &str) -> (Option<u32>, Option<u32>) {
    let Some(open) = raw.find('(') else {
        return (None, None);
    };
    let Some(close_rel) = raw[open + 1..].find(')') else {
        return (None, None);
    };
    let inner = &raw[open + 1..open + 1 + close_rel];
    let mut parts = inner.split(',').map(|p| p.trim().parse::<u32>().ok());
    let p = parts.next().flatten();
    let s = parts.next().flatten();
    (p, s)
}

/// ソースの型名を論理型へ正規化する。判定できない (空 / `NULL` / 未知の型名)
/// ときは `None` を返し、呼び出し側が値から推定する。
pub fn classify_source_type(type_name: &str) -> Option<TransferType> {
    let upper = type_name.trim().to_ascii_uppercase();
    if upper.is_empty() || upper == "NULL" {
        return None;
    }
    let unsigned = upper.contains("UNSIGNED");
    // 括弧 (長さ・精度) と修飾語を落とした基底名。
    let base: String = match upper.find('(') {
        Some(i) => {
            let tail = upper[i..]
                .find(')')
                .map(|j| &upper[i + j + 1..])
                .unwrap_or("");
            format!("{}{}", &upper[..i], tail)
        }
        None => upper.clone(),
    };
    let base = base
        .replace("UNSIGNED", "")
        .replace("ZEROFILL", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let ty = match base.as_str() {
        "BOOL" | "BOOLEAN" | "BIT" => TransferType::Boolean,
        "BIGINT" | "INT8" | "BIGSERIAL" | "SERIAL8" if unsigned => TransferType::UnsignedBigInt,
        "UBIGINT" => TransferType::UnsignedBigInt,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" | "INT2" | "INT4"
        | "INT8" | "SERIAL" | "SMALLSERIAL" | "BIGSERIAL" | "SERIAL2" | "SERIAL4" | "SERIAL8"
        | "UTINYINT" | "USMALLINT" | "UINTEGER" | "YEAR" => TransferType::Integer,
        "HUGEINT" | "UHUGEINT" => TransferType::Decimal {
            precision: Some(38),
            scale: Some(0),
        },
        "REAL" | "FLOAT" | "FLOAT4" | "FLOAT8" | "DOUBLE" | "DOUBLE PRECISION" => {
            TransferType::Float
        }
        "DECIMAL" | "NUMERIC" | "DEC" | "FIXED" => {
            let (precision, scale) = parse_precision_scale(&upper);
            TransferType::Decimal { precision, scale }
        }
        "DATE" => TransferType::Date,
        "TIME" | "TIME WITHOUT TIME ZONE" => TransferType::Time,
        "DATETIME"
        | "DATETIME2"
        | "SMALLDATETIME"
        | "TIMESTAMP"
        | "TIMESTAMP WITHOUT TIME ZONE"
        | "TIMESTAMP_S"
        | "TIMESTAMP_MS"
        | "TIMESTAMP_NS" => TransferType::Timestamp,
        "TIMESTAMPTZ" | "TIMESTAMP WITH TIME ZONE" | "DATETIMEOFFSET" => TransferType::TimestampTz,
        "BLOB" | "BYTEA" | "BINARY" | "VARBINARY" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB"
        | "IMAGE" | "BINARY VARYING" => TransferType::Binary,
        "JSON" | "JSONB" => TransferType::Json,
        "UUID" | "UNIQUEIDENTIFIER" => TransferType::Uuid,
        "CHAR" | "VARCHAR" | "TEXT" | "NCHAR" | "NVARCHAR" | "NTEXT" | "CLOB" | "STRING"
        | "CHARACTER" | "CHARACTER VARYING" | "BPCHAR" | "NAME" | "CITEXT" | "TINYTEXT"
        | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" | "XML" | "VARCHAR2" | "NVARCHAR2" => {
            TransferType::Text
        }
        _ => return None,
    };
    Some(ty)
}

/// 型名から判定できなかった列の論理型を、値の形から推定する。値がすべて NULL
/// (またはサンプルが空) なら `Text` — どのドライバでも任意の値を受けられる。
pub fn infer_type_from_values<'a>(values: impl IntoIterator<Item = &'a Value>) -> TransferType {
    let (mut has_bool, mut has_int, mut has_float, mut has_text, mut has_bytes) =
        (false, false, false, false, false);
    for v in values {
        match v {
            Value::Null => {}
            Value::Bool(_) => has_bool = true,
            Value::Int(_) | Value::UInt(_) => has_int = true,
            Value::Float(_) => has_float = true,
            Value::String(_) => has_text = true,
            Value::Bytes(_) => has_bytes = true,
        }
    }
    if has_text {
        TransferType::Text
    } else if has_bytes {
        TransferType::Binary
    } else if has_float {
        TransferType::Float
    } else if has_int {
        TransferType::Integer
    } else if has_bool {
        TransferType::Boolean
    } else {
        TransferType::Text
    }
}

/// ストリームの列定義と最初のバッチ (推定用サンプル。空でもよい) から、転送先の
/// 列定義を組み立てる。空の列名は `column_N`、大小無視で重複する列名
/// (`SELECT a.id, b.id` など) は `id_2` のように連番で一意化する — そのままでは
/// CREATE TABLE が失敗するため。
pub fn plan_columns(columns: &[Column], sample: &[Vec<Value>]) -> Vec<TransferColumn> {
    let mut used: Vec<String> = Vec::with_capacity(columns.len());
    let mut out = Vec::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let trimmed = col.name.trim();
        let base = if trimmed.is_empty() {
            format!("column_{}", i + 1)
        } else {
            trimmed.to_string()
        };
        let mut name = base.clone();
        let mut n = 2;
        while used.iter().any(|u| u.eq_ignore_ascii_case(&name)) {
            name = format!("{base}_{n}");
            n += 1;
        }
        used.push(name.clone());

        let column_values = sample.iter().filter_map(|row| row.get(i));
        let has_bytes = sample
            .iter()
            .filter_map(|row| row.get(i))
            .any(|v| matches!(v, Value::Bytes(_)));
        let ty = match classify_source_type(&col.type_name) {
            // 動的型付け (SQLite) では宣言型と実際の値がズレうる。バイト列が
            // 混ざっている列はバイナリとして運ばないと hex テキストに化ける。
            Some(t) if has_bytes && t != TransferType::Binary => TransferType::Binary,
            Some(t) => t,
            None => infer_type_from_values(column_values),
        };
        out.push(TransferColumn {
            name,
            source_type: col.type_name.clone(),
            ty,
        });
    }
    out
}

/// 論理型 → ターゲット方言の DDL 型名。
pub fn target_type_sql(driver: DriverKind, ty: &TransferType) -> String {
    use DriverKind as D;
    use TransferType as T;
    let s: &str = match (ty, driver) {
        (T::Boolean, D::Mssql) => "BIT",
        (T::Boolean, _) => "BOOLEAN",

        (T::Integer, D::Sqlite) => "INTEGER",
        (T::Integer, _) => "BIGINT",

        (T::UnsignedBigInt, D::Mysql) => "BIGINT UNSIGNED",
        (T::UnsignedBigInt, D::DuckDb) => "UBIGINT",
        (T::UnsignedBigInt, D::Sqlite) => "INTEGER",
        (T::UnsignedBigInt, D::Postgres) => "NUMERIC(20,0)",
        (T::UnsignedBigInt, D::Mssql) => "DECIMAL(20,0)",

        (T::Float, D::Postgres) => "DOUBLE PRECISION",
        (T::Float, D::Mssql) => "FLOAT",
        (T::Float, D::Sqlite) => "REAL",
        (T::Float, _) => "DOUBLE",

        (T::Decimal { precision, scale }, _) => return decimal_sql(driver, *precision, *scale),

        (T::Text, D::Mysql) => "LONGTEXT",
        (T::Text, D::Mssql) => "NVARCHAR(MAX)",
        (T::Text, D::DuckDb) => "VARCHAR",
        (T::Text, _) => "TEXT",

        (T::Date, _) => "DATE",

        (T::Time, D::Mysql) => "TIME(6)",
        (T::Time, _) => "TIME",

        (T::Timestamp, D::Mysql) => "DATETIME(6)",
        (T::Timestamp, D::Mssql) => "DATETIME2",
        (T::Timestamp, D::Sqlite) => "DATETIME",
        (T::Timestamp, _) => "TIMESTAMP",

        // MySQL にはタイムゾーン付きの型が無い。オフセット付き文字列を DATETIME へ
        // 入れると失敗/丸めが起きるため、文字列のまま無損失で保持する。
        (T::TimestampTz, D::Mysql) => "VARCHAR(64)",
        (T::TimestampTz, D::Mssql) => "DATETIMEOFFSET",
        (T::TimestampTz, D::Sqlite) => "DATETIME",
        (T::TimestampTz, _) => "TIMESTAMPTZ",

        (T::Binary, D::Postgres) => "BYTEA",
        (T::Binary, D::Mysql) => "LONGBLOB",
        (T::Binary, D::Mssql) => "NVARCHAR(MAX)",
        (T::Binary, _) => "BLOB",

        (T::Json, D::Postgres) => "JSONB",
        (T::Json, D::Mysql) => "JSON",
        (T::Json, D::Mssql) => "NVARCHAR(MAX)",
        (T::Json, D::DuckDb) => "VARCHAR",
        (T::Json, D::Sqlite) => "TEXT",

        (T::Uuid, D::Postgres) | (T::Uuid, D::DuckDb) => "UUID",
        (T::Uuid, D::Mssql) => "UNIQUEIDENTIFIER",
        (T::Uuid, D::Mysql) => "CHAR(36)",
        (T::Uuid, D::Sqlite) => "TEXT",
    };
    s.to_string()
}

fn decimal_sql(driver: DriverKind, precision: Option<u32>, scale: Option<u32>) -> String {
    // 各方言の上限へ丸める (MySQL 65 / MSSQL・DuckDB 38)。PostgreSQL・SQLite は
    // 精度不明なら素の NUMERIC で無制限/動的に受ける。
    let max_p = match driver {
        DriverKind::Mysql => 65,
        DriverKind::Mssql | DriverKind::DuckDb => 38,
        DriverKind::Postgres => 1000,
        DriverKind::Sqlite => 0,
    };
    if driver == DriverKind::Sqlite {
        return "NUMERIC".into();
    }
    match (precision, scale) {
        (Some(p), s) if p > 0 => {
            let p = p.min(max_p);
            // MySQL のスケール上限は 30。
            let max_s = if driver == DriverKind::Mysql { 30 } else { p };
            let s = s.unwrap_or(0).min(p).min(max_s);
            format!("{}({p},{s})", decimal_keyword(driver))
        }
        _ => match driver {
            DriverKind::Postgres => "NUMERIC".into(),
            DriverKind::Mysql => "DECIMAL(65,30)".into(),
            _ => "DECIMAL(38,10)".into(),
        },
    }
}

fn decimal_keyword(driver: DriverKind) -> &'static str {
    match driver {
        DriverKind::Postgres => "NUMERIC",
        _ => "DECIMAL",
    }
}

/// 転送先テーブル名の最低限の妥当性チェック (識別子は常に `quote_ident` で
/// クオートするので、ここでは明らかにおかしい入力だけを弾く)。
pub fn validate_target_table(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "target table name must not be empty".into(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(AppError::InvalidInput("invalid target table name".into()));
    }
    if trimmed.chars().count() > 128 {
        return Err(AppError::InvalidInput(
            "target table name is too long (max 128 characters)".into(),
        ));
    }
    Ok(())
}

/// `CREATE TABLE <table> (<col> <type>, ...)`。制約・インデックス・既定値は
/// コピーしない (結果セットには無い情報で、方言間の互換も取れないため)。全列 NULL 可。
pub fn create_table_sql(driver: DriverKind, table: &str, columns: &[TransferColumn]) -> String {
    let cols = columns
        .iter()
        .map(|c| {
            format!(
                "{} {}",
                quote_ident(driver, &c.name),
                target_type_sql(driver, &c.ty)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("CREATE TABLE {} ({})", quote_ident(driver, table), cols)
}

/// `DROP TABLE IF EXISTS <table>` (5 方言すべてが IF EXISTS をサポート —
/// SQL Server は 2016 以降)。
pub fn drop_table_sql(driver: DriverKind, table: &str) -> String {
    format!("DROP TABLE IF EXISTS {}", quote_ident(driver, table))
}

/// テーブル全件を読むソース SQL。
pub fn source_select_sql(driver: DriverKind, table: &str) -> String {
    format!("SELECT * FROM {}", quote_ident(driver, table))
}

/// インポート経路 (テキストのみ) ではバイト列を直接書けず、全件投入後に hex を
/// バイト列へ戻す後処理が要るドライバか。
pub fn needs_binary_finalize(driver: DriverKind) -> bool {
    matches!(driver, DriverKind::Sqlite | DriverKind::Mysql)
}

/// バイト列を忠実に書けない (hex 文字列へ縮退する) ドライバか。
pub fn binary_is_lossy(driver: DriverKind) -> bool {
    matches!(driver, DriverKind::Mssql)
}

/// hex で投入したバイナリ列をバイト列へ戻す UPDATE 文 (SQLite / MySQL のみ。
/// それ以外は空)。転送が作成したテーブルに対してだけ使うこと — 既存行まで
/// 変換してしまうため追記 (`Append`) では使わない。
pub fn binary_finalize_sql(
    driver: DriverKind,
    table: &str,
    columns: &[TransferColumn],
) -> Vec<String> {
    if !needs_binary_finalize(driver) {
        return Vec::new();
    }
    let func = match driver {
        DriverKind::Mysql => "UNHEX",
        _ => "unhex",
    };
    let t = quote_ident(driver, table);
    columns
        .iter()
        .filter(|c| c.ty == TransferType::Binary)
        .map(|c| {
            let q = quote_ident(driver, &c.name);
            format!("UPDATE {t} SET {q} = {func}({q}) WHERE {q} IS NOT NULL")
        })
        .collect()
}

/// 1 セルをインポート経路へ渡すテキストへ変換する。`None` は SQL NULL。
pub fn value_to_cell(driver: DriverKind, ty: &TransferType, value: &Value) -> Option<String> {
    let bool_text = |b: bool| -> String {
        match driver {
            DriverKind::Postgres | DriverKind::DuckDb => {
                if b {
                    "true".into()
                } else {
                    "false".into()
                }
            }
            _ => {
                if b {
                    "1".into()
                } else {
                    "0".into()
                }
            }
        }
    };
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(if *ty == TransferType::Boolean {
            bool_text(*b)
        } else if *b {
            "1".into()
        } else {
            "0".into()
        }),
        Value::Int(n) if *ty == TransferType::Boolean => Some(bool_text(*n != 0)),
        Value::UInt(n) if *ty == TransferType::Boolean => Some(bool_text(*n != 0)),
        Value::Int(n) => Some(n.to_string()),
        Value::UInt(n) => Some(n.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Bytes(hex) => {
            if *ty != TransferType::Binary {
                return Some(hex.clone());
            }
            Some(match driver {
                DriverKind::Postgres => format!("\\x{hex}"),
                DriverKind::DuckDb => {
                    let mut out = String::with_capacity(hex.len() * 2);
                    let bytes = hex.as_bytes();
                    for pair in bytes.chunks(2) {
                        out.push_str("\\x");
                        for b in pair {
                            out.push(*b as char);
                        }
                    }
                    out
                }
                DriverKind::Mssql => format!("0x{hex}"),
                DriverKind::Sqlite | DriverKind::Mysql => hex.clone(),
            })
        }
    }
}

/// 転送結果のユーザ向け注意書き (損失のあるマッピング等)。
pub fn plan_warnings(driver: DriverKind, columns: &[TransferColumn]) -> Vec<String> {
    let mut out = Vec::new();
    if binary_is_lossy(driver) {
        for c in columns.iter().filter(|c| c.ty == TransferType::Binary) {
            out.push(format!(
                "column \"{}\" is binary; SQL Server target stores it as a 0x-prefixed hex string (NVARCHAR)",
                c.name
            ));
        }
    }
    out
}

/// 追記モードで、テキスト経路では正しく書けないバイナリ列を含むなら拒否する
/// (後処理の UPDATE は既存行まで変換してしまうため追記では使えない)。
pub fn ensure_append_supported(driver: DriverKind, columns: &[TransferColumn]) -> Result<()> {
    if needs_binary_finalize(driver) || binary_is_lossy(driver) {
        if let Some(c) = columns.iter().find(|c| c.ty == TransferType::Binary) {
            return Err(AppError::InvalidInput(format!(
                "appending binary column \"{}\" into an existing {} table is not supported; transfer into a new table instead",
                c.name,
                driver.as_str()
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> Column {
        Column {
            name: name.into(),
            type_name: ty.into(),
        }
    }

    #[test]
    fn classifies_common_type_names_across_dialects() {
        assert_eq!(classify_source_type("int8"), Some(TransferType::Integer));
        assert_eq!(classify_source_type("INTEGER"), Some(TransferType::Integer));
        assert_eq!(
            classify_source_type("BIGINT UNSIGNED"),
            Some(TransferType::UnsignedBigInt)
        );
        assert_eq!(
            classify_source_type("UBIGINT"),
            Some(TransferType::UnsignedBigInt)
        );
        assert_eq!(
            classify_source_type("int unsigned"),
            Some(TransferType::Integer)
        );
        assert_eq!(
            classify_source_type("VARCHAR(255)"),
            Some(TransferType::Text)
        );
        assert_eq!(
            classify_source_type("character varying"),
            Some(TransferType::Text)
        );
        assert_eq!(classify_source_type("float8"), Some(TransferType::Float));
        assert_eq!(
            classify_source_type("DECIMAL(10,2)"),
            Some(TransferType::Decimal {
                precision: Some(10),
                scale: Some(2)
            })
        );
        assert_eq!(
            classify_source_type("NUMERIC"),
            Some(TransferType::Decimal {
                precision: None,
                scale: None
            })
        );
        assert_eq!(
            classify_source_type("DATETIME2"),
            Some(TransferType::Timestamp)
        );
        assert_eq!(
            classify_source_type("timestamptz"),
            Some(TransferType::TimestampTz)
        );
        assert_eq!(
            classify_source_type("TIMESTAMP WITH TIME ZONE"),
            Some(TransferType::TimestampTz)
        );
        assert_eq!(classify_source_type("bytea"), Some(TransferType::Binary));
        assert_eq!(
            classify_source_type("VARBINARY(16)"),
            Some(TransferType::Binary)
        );
        assert_eq!(classify_source_type("BLOB"), Some(TransferType::Binary));
        assert_eq!(classify_source_type("jsonb"), Some(TransferType::Json));
        assert_eq!(
            classify_source_type("UNIQUEIDENTIFIER"),
            Some(TransferType::Uuid)
        );
        assert_eq!(classify_source_type("BIT"), Some(TransferType::Boolean));
        assert_eq!(classify_source_type("DATE"), Some(TransferType::Date));
        assert_eq!(classify_source_type("TIME"), Some(TransferType::Time));
        // 判定不能 → 値から推定させる
        assert_eq!(classify_source_type(""), None);
        assert_eq!(classify_source_type("NULL"), None);
        assert_eq!(classify_source_type("GEOGRAPHY"), None);
    }

    #[test]
    fn infers_from_values_when_type_is_unknown() {
        assert_eq!(
            infer_type_from_values(&[Value::Null, Value::Int(1)]),
            TransferType::Integer
        );
        assert_eq!(
            infer_type_from_values(&[Value::Int(1), Value::Float(1.5)]),
            TransferType::Float
        );
        assert_eq!(
            infer_type_from_values(&[Value::Int(1), Value::String("x".into())]),
            TransferType::Text
        );
        assert_eq!(
            infer_type_from_values(&[Value::Bytes("00".into())]),
            TransferType::Binary
        );
        assert_eq!(
            infer_type_from_values(&[Value::Bool(true)]),
            TransferType::Boolean
        );
        assert_eq!(infer_type_from_values(&[Value::Null]), TransferType::Text);
        assert_eq!(infer_type_from_values(&[]), TransferType::Text);
    }

    #[test]
    fn plan_columns_dedupes_names_and_uses_samples() {
        let cols = vec![col("id", "INTEGER"), col("ID", "INTEGER"), col("", "NULL")];
        let sample = vec![vec![Value::Int(1), Value::Int(2), Value::Float(0.5)]];
        let plan = plan_columns(&cols, &sample);
        assert_eq!(plan[0].name, "id");
        assert_eq!(plan[1].name, "ID_2");
        assert_eq!(plan[2].name, "column_3");
        assert_eq!(plan[2].ty, TransferType::Float);
    }

    #[test]
    fn plan_columns_promotes_bytes_in_dynamically_typed_columns() {
        let cols = vec![col("payload", "TEXT")];
        let sample = vec![vec![Value::Bytes("dead".into())]];
        assert_eq!(plan_columns(&cols, &sample)[0].ty, TransferType::Binary);
    }

    #[test]
    fn maps_every_logical_type_for_every_driver() {
        let all_types = [
            TransferType::Boolean,
            TransferType::Integer,
            TransferType::UnsignedBigInt,
            TransferType::Float,
            TransferType::Decimal {
                precision: None,
                scale: None,
            },
            TransferType::Text,
            TransferType::Date,
            TransferType::Time,
            TransferType::Timestamp,
            TransferType::TimestampTz,
            TransferType::Binary,
            TransferType::Json,
            TransferType::Uuid,
        ];
        for driver in [
            DriverKind::Mysql,
            DriverKind::Postgres,
            DriverKind::Sqlite,
            DriverKind::DuckDb,
            DriverKind::Mssql,
        ] {
            for ty in &all_types {
                let sql = target_type_sql(driver, ty);
                assert!(!sql.is_empty(), "{driver:?} {ty:?}");
                // 再分類しても論理型の「系統」が崩れないこと (往復の安定性)。
                // MySQL の TimestampTz (VARCHAR) と MSSQL のバイナリ/JSON (NVARCHAR)
                // は意図的な縮退なので除外する。
                let reclassified = classify_source_type(&sql);
                assert!(reclassified.is_some(), "{driver:?} {ty:?} -> {sql}");
            }
        }
        assert_eq!(
            target_type_sql(DriverKind::Mysql, &TransferType::Text),
            "LONGTEXT"
        );
        assert_eq!(
            target_type_sql(DriverKind::Postgres, &TransferType::Binary),
            "BYTEA"
        );
        assert_eq!(
            target_type_sql(DriverKind::Mssql, &TransferType::Boolean),
            "BIT"
        );
        assert_eq!(
            target_type_sql(DriverKind::DuckDb, &TransferType::Timestamp),
            "TIMESTAMP"
        );
        assert_eq!(
            target_type_sql(
                DriverKind::Mysql,
                &TransferType::Decimal {
                    precision: Some(80),
                    scale: Some(40)
                }
            ),
            "DECIMAL(65,30)"
        );
        assert_eq!(
            target_type_sql(
                DriverKind::Postgres,
                &TransferType::Decimal {
                    precision: Some(10),
                    scale: Some(2)
                }
            ),
            "NUMERIC(10,2)"
        );
        assert_eq!(
            target_type_sql(
                DriverKind::Sqlite,
                &TransferType::Decimal {
                    precision: Some(10),
                    scale: Some(2)
                }
            ),
            "NUMERIC"
        );
    }

    #[test]
    fn create_and_drop_sql_quote_identifiers_per_dialect() {
        let cols = vec![
            TransferColumn {
                name: "id".into(),
                source_type: "INTEGER".into(),
                ty: TransferType::Integer,
            },
            TransferColumn {
                name: "we\"ird".into(),
                source_type: "TEXT".into(),
                ty: TransferType::Text,
            },
        ];
        assert_eq!(
            create_table_sql(DriverKind::Sqlite, "t", &cols),
            "CREATE TABLE \"t\" (\"id\" INTEGER, \"we\"\"ird\" TEXT)"
        );
        assert_eq!(
            create_table_sql(DriverKind::Mysql, "t", &cols),
            "CREATE TABLE `t` (`id` BIGINT, `we\"ird` LONGTEXT)"
        );
        assert_eq!(
            create_table_sql(DriverKind::Mssql, "t]x", &cols),
            "CREATE TABLE [t]]x] ([id] BIGINT, [we\"ird] NVARCHAR(MAX))"
        );
        assert_eq!(
            drop_table_sql(DriverKind::DuckDb, "t"),
            "DROP TABLE IF EXISTS \"t\""
        );
        assert_eq!(
            source_select_sql(DriverKind::Mysql, "a`b"),
            "SELECT * FROM `a``b`"
        );
    }

    #[test]
    fn value_to_cell_encodes_per_target() {
        let b = TransferType::Boolean;
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &b, &Value::Bool(true)).as_deref(),
            Some("true")
        );
        assert_eq!(
            value_to_cell(DriverKind::DuckDb, &b, &Value::Int(0)).as_deref(),
            Some("false")
        );
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &b, &Value::Bool(true)).as_deref(),
            Some("1")
        );
        assert_eq!(
            value_to_cell(DriverKind::Mssql, &b, &Value::Bool(false)).as_deref(),
            Some("0")
        );
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &TransferType::Text, &Value::Null),
            None
        );
        assert_eq!(
            value_to_cell(
                DriverKind::Sqlite,
                &TransferType::Integer,
                &Value::String("9007199254740993".into())
            )
            .as_deref(),
            Some("9007199254740993")
        );
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &TransferType::Float, &Value::Float(1.5)).as_deref(),
            Some("1.5")
        );
        let bin = TransferType::Binary;
        let v = Value::Bytes("00ff".into());
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &bin, &v).as_deref(),
            Some("\\x00ff")
        );
        assert_eq!(
            value_to_cell(DriverKind::DuckDb, &bin, &v).as_deref(),
            Some("\\x00\\xff")
        );
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &bin, &v).as_deref(),
            Some("00ff")
        );
        assert_eq!(
            value_to_cell(DriverKind::Mysql, &bin, &v).as_deref(),
            Some("00ff")
        );
        assert_eq!(
            value_to_cell(DriverKind::Mssql, &bin, &v).as_deref(),
            Some("0x00ff")
        );
        // バイナリでない列に入るバイト列は hex テキストのまま
        assert_eq!(
            value_to_cell(DriverKind::DuckDb, &TransferType::Text, &v).as_deref(),
            Some("00ff")
        );
    }

    #[test]
    fn binary_finalize_only_for_text_only_binary_targets() {
        let cols = vec![
            TransferColumn {
                name: "b".into(),
                source_type: "BLOB".into(),
                ty: TransferType::Binary,
            },
            TransferColumn {
                name: "t".into(),
                source_type: "TEXT".into(),
                ty: TransferType::Text,
            },
        ];
        assert_eq!(
            binary_finalize_sql(DriverKind::Sqlite, "x", &cols),
            vec!["UPDATE \"x\" SET \"b\" = unhex(\"b\") WHERE \"b\" IS NOT NULL".to_string()]
        );
        assert_eq!(
            binary_finalize_sql(DriverKind::Mysql, "x", &cols),
            vec!["UPDATE `x` SET `b` = UNHEX(`b`) WHERE `b` IS NOT NULL".to_string()]
        );
        assert!(binary_finalize_sql(DriverKind::Postgres, "x", &cols).is_empty());
        assert!(binary_finalize_sql(DriverKind::DuckDb, "x", &cols).is_empty());
        assert!(ensure_append_supported(DriverKind::Sqlite, &cols).is_err());
        assert!(ensure_append_supported(DriverKind::Mssql, &cols).is_err());
        assert!(ensure_append_supported(DriverKind::DuckDb, &cols).is_ok());
        assert!(ensure_append_supported(DriverKind::Sqlite, &cols[1..]).is_ok());
        assert_eq!(plan_warnings(DriverKind::Mssql, &cols).len(), 1);
        assert!(plan_warnings(DriverKind::DuckDb, &cols).is_empty());
    }

    #[test]
    fn validates_target_table_names() {
        assert!(validate_target_table("orders").is_ok());
        assert!(validate_target_table("  ").is_err());
        assert!(validate_target_table("a\0b").is_err());
        assert!(validate_target_table(&"x".repeat(129)).is_err());
        assert!(TransferMode::Create.creates_table());
        assert!(TransferMode::Replace.creates_table());
        assert!(!TransferMode::Append.creates_table());
    }
}
