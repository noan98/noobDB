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
//! - SQLite / MySQL: hex 文字列のまま bind し、INSERT の値式側で `unhex(?)` /
//!   `UNHEX(?)` に包んでバイト列にする ([`hex_binary_columns`] が対象列を決め、
//!   `Connection::import_rows_with_binary` が式を組む)。以前は全件投入後に
//!   `UPDATE ... SET c = unhex(c)` を全行へ流していたため、BLOB 列が 1 つあるだけで
//!   書き込みがほぼ倍になっていた (#1530)。既存テーブルへの追記でも安全。

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
    /// 既存テーブルへ upsert する (#1539)。DDL は発行せず、キー列が既存行と衝突した
    /// 行はインポートの UPSERT と同じ方針で読み飛ばす (`skip`) か更新する (`update`)。
    Upsert,
}

impl TransferMode {
    /// この転送がテーブルを作成するか (= 失敗/キャンセル時に後始末で DROP してよいか)。
    pub fn creates_table(self) -> bool {
        matches!(self, TransferMode::Create | TransferMode::Replace)
    }

    /// 既存テーブルへ書き込む (DDL を発行しない) モードか。
    pub fn writes_existing_table(self) -> bool {
        matches!(self, TransferMode::Append | TransferMode::Upsert)
    }
}

/// 転送先列の論理型の指定 (列ごとの型上書き, #1623)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverrideKind {
    Boolean,
    Integer,
    Float,
    Decimal,
    Text,
    Date,
    Time,
    Timestamp,
    Timestamptz,
    Binary,
    Json,
    Uuid,
}

/// 型上書き。`decimal` のときだけ `precision` / `scale` を使う。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeOverride {
    pub kind: OverrideKind,
    #[serde(default)]
    pub precision: Option<u32>,
    #[serde(default)]
    pub scale: Option<u32>,
}

impl TypeOverride {
    pub fn to_type(&self) -> TransferType {
        match self.kind {
            OverrideKind::Boolean => TransferType::Boolean,
            OverrideKind::Integer => TransferType::Integer,
            OverrideKind::Float => TransferType::Float,
            OverrideKind::Decimal => TransferType::Decimal {
                precision: self.precision,
                scale: self.scale,
            },
            OverrideKind::Text => TransferType::Text,
            OverrideKind::Date => TransferType::Date,
            OverrideKind::Time => TransferType::Time,
            OverrideKind::Timestamp => TransferType::Timestamp,
            OverrideKind::Timestamptz => TransferType::TimestampTz,
            OverrideKind::Binary => TransferType::Binary,
            OverrideKind::Json => TransferType::Json,
            OverrideKind::Uuid => TransferType::Uuid,
        }
    }
}

/// 転送する列 1 つに対する指定 (#1623)。`source` はソースが返した列名 (完全一致)。
/// 指定のない列は従来どおりそのまま転送する。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub source: String,
    /// 転送先での列名 (別名)。省略 / 空白のみは元の名前。
    #[serde(default)]
    pub name: Option<String>,
    /// true なら転送しない。
    #[serde(default)]
    pub exclude: bool,
    /// 転送先の論理型を自動判定ではなくこれにする。
    #[serde(default, rename = "type")]
    pub type_override: Option<TypeOverride>,
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

/// [`plan_columns`] に列の除外・改名・型上書き ([`ColumnSpec`]) を適用した版 (#1623)。
/// 戻り値は (転送先の列計画, 残すソース列の位置)。位置は除外が無ければ `None`
/// (= 全列そのまま。行の複製を避けるため)。改名は重複除去の前に適用するので、
/// 改名先が他の列と衝突すれば `_2` のように連番で一意化される。
pub fn plan_columns_mapped(
    columns: &[Column],
    sample: &[Vec<Value>],
    specs: &[ColumnSpec],
) -> Result<(Vec<TransferColumn>, Option<Vec<usize>>)> {
    if specs.is_empty() {
        return Ok((plan_columns(columns, sample), None));
    }
    let spec_for = |name: &str| specs.iter().find(|s| s.source == name);
    let keep: Vec<usize> = (0..columns.len())
        .filter(|i| !spec_for(&columns[*i].name).is_some_and(|s| s.exclude))
        .collect();
    if keep.is_empty() {
        return Err(AppError::InvalidInput(
            "every column is excluded from the transfer".into(),
        ));
    }
    let kept_columns: Vec<Column> = keep
        .iter()
        .map(|&i| {
            let c = &columns[i];
            let renamed = spec_for(&c.name)
                .and_then(|s| s.name.as_deref())
                .map(str::trim)
                .filter(|n| !n.is_empty());
            Column {
                name: renamed.map(str::to_string).unwrap_or_else(|| c.name.clone()),
                type_name: c.type_name.clone(),
            }
        })
        .collect();
    let identity = keep.len() == columns.len();
    let kept_sample: Vec<Vec<Value>> = if identity {
        sample.to_vec()
    } else {
        sample.iter().map(|r| select_cells(r, &keep)).collect()
    };
    let mut plan = plan_columns(&kept_columns, &kept_sample);
    for (j, &i) in keep.iter().enumerate() {
        if let Some(over) = spec_for(&columns[i].name).and_then(|s| s.type_override.as_ref()) {
            plan[j].ty = over.to_type();
        }
    }
    Ok((plan, if identity { None } else { Some(keep) }))
}

/// 行から `keep` の位置のセルだけを取り出す (欠けた位置は NULL)。
pub fn select_cells(row: &[Value], keep: &[usize]) -> Vec<Value> {
    keep.iter()
        .map(|&i| row.get(i).cloned().unwrap_or(Value::Null))
        .collect()
}

/// 論理型 → ターゲット方言の DDL 型名。
pub fn target_type_sql(driver: DriverKind, ty: &TransferType) -> String {
    use DriverKind as D;
    use TransferType as T;
    let s: &str = match (ty, driver) {
        (T::Boolean, _) => "BOOLEAN",

        (T::Integer, D::Sqlite) => "INTEGER",
        (T::Integer, _) => "BIGINT",

        (T::UnsignedBigInt, D::Mysql) => "BIGINT UNSIGNED",
        // SQLite の INTEGER は 64bit 符号付き。i64 を超える値は REAL に化けて精度を失うので、
        // 書き込み前に [`check_sqlite_unsigned_range`] で行エラーにする (黙って丸めない)。
        (T::UnsignedBigInt, D::Sqlite) => "INTEGER",
        (T::UnsignedBigInt, D::Postgres) => "NUMERIC(20,0)",

        (T::Float, D::Postgres) => "DOUBLE PRECISION",
        (T::Float, D::Sqlite) => "REAL",
        (T::Float, _) => "DOUBLE",

        (T::Decimal { precision, scale }, _) => return decimal_sql(driver, *precision, *scale),

        (T::Text, D::Mysql) => "LONGTEXT",
        (T::Text, _) => "TEXT",

        (T::Date, _) => "DATE",

        (T::Time, D::Mysql) => "TIME(6)",
        (T::Time, _) => "TIME",

        (T::Timestamp, D::Mysql) => "DATETIME(6)",
        (T::Timestamp, D::Sqlite) => "DATETIME",
        (T::Timestamp, _) => "TIMESTAMP",

        // MySQL にはタイムゾーン付きの型が無い。オフセット付き文字列を DATETIME へ
        // 入れると失敗/丸めが起きるため、文字列のまま無損失で保持する。
        (T::TimestampTz, D::Mysql) => "VARCHAR(64)",
        (T::TimestampTz, D::Sqlite) => "DATETIME",
        (T::TimestampTz, _) => "TIMESTAMPTZ",

        (T::Binary, D::Postgres) => "BYTEA",
        (T::Binary, D::Mysql) => "LONGBLOB",
        (T::Binary, _) => "BLOB",

        (T::Json, D::Postgres) => "JSONB",
        (T::Json, D::Mysql) => "JSON",
        (T::Json, D::Sqlite) => "TEXT",

        (T::Uuid, D::Postgres) => "UUID",
        (T::Uuid, D::Mysql) => "CHAR(36)",
        (T::Uuid, D::Sqlite) => "TEXT",
    };
    s.to_string()
}

fn decimal_sql(driver: DriverKind, precision: Option<u32>, scale: Option<u32>) -> String {
    // 各方言の上限へ丸める (MySQL 65)。PostgreSQL・SQLite は精度不明なら素の
    // NUMERIC で無制限/動的に受ける。
    let max_p = match driver {
        DriverKind::Mysql => 65,
        DriverKind::Postgres => 1000,
        DriverKind::Sqlite => 0,
    };
    if driver == DriverKind::Sqlite {
        return "NUMERIC".into();
    }
    match (precision, scale) {
        (Some(p), s) if p > 0 => {
            let p = p.min(max_p);
            // MySQL のスケール上限は 30 で、s <= p が必須。PostgreSQL は NUMERIC(3,5) の
            // ように s > p も正当な定義 (上限 1000) なので p に丸めない (#1598)。
            let s = match driver {
                DriverKind::Mysql => s.unwrap_or(0).min(p).min(30),
                _ => s.unwrap_or(0).min(1000),
            };
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

/// `DROP TABLE IF EXISTS <table>` (3 方言すべてが IF EXISTS をサポート)。
pub fn drop_table_sql(driver: DriverKind, table: &str) -> String {
    format!("DROP TABLE IF EXISTS {}", quote_ident(driver, table))
}

/// テーブル全件を読むソース SQL。
pub fn source_select_sql(driver: DriverKind, table: &str) -> String {
    format!("SELECT * FROM {}", quote_ident(driver, table))
}

/// 列の絞り込み・WHERE・LIMIT 付きのテーブル元 SQL (#1623)。`columns` が `None` なら `*`。
/// WHERE は利用者が書いた式をそのまま括弧で包んで入れる (読み取り専用ガードは呼び出し側が
/// 完成した SQL 全体に掛ける)。
pub fn source_select_sql_ext(
    driver: DriverKind,
    table: &str,
    columns: Option<&[String]>,
    where_clause: Option<&str>,
    limit: Option<u64>,
) -> String {
    let list = match columns {
        Some(cols) if !cols.is_empty() => cols
            .iter()
            .map(|c| quote_ident(driver, c))
            .collect::<Vec<_>>()
            .join(", "),
        _ => "*".to_string(),
    };
    let mut sql = format!("SELECT {list} FROM {}", quote_ident(driver, table));
    if let Some(w) = where_clause.map(str::trim).filter(|w| !w.is_empty()) {
        // 末尾の行コメント (`-- ...`) が閉じ括弧を巻き込まないよう、改行を挟む。
        sql.push_str(&format!(" WHERE ({w}\n)"));
    }
    if let Some(n) = limit {
        sql.push_str(&format!(" LIMIT {n}"));
    }
    sql
}

/// テーブル元の件数を数える SQL (#1623)。転送後の件数照合に使う。
pub fn source_count_sql(driver: DriverKind, table: &str, where_clause: Option<&str>) -> String {
    let mut sql = format!("SELECT COUNT(*) FROM {}", quote_ident(driver, table));
    if let Some(w) = where_clause.map(str::trim).filter(|w| !w.is_empty()) {
        sql.push_str(&format!(" WHERE ({w}\n)"));
    }
    sql
}

/// 列ごとに「hex 文字列で bind し、INSERT の値式で `unhex` するか」。テキストでしか
/// 渡せないインポート経路で、SQLite / MySQL のバイナリ列だけが対象 (PostgreSQL は
/// `\x<hex>` を bytea へ暗黙変換できるので不要)。
pub fn hex_binary_columns(driver: DriverKind, columns: &[TransferColumn]) -> Vec<bool> {
    let applies = matches!(driver, DriverKind::Sqlite | DriverKind::Mysql);
    columns
        .iter()
        .map(|c| applies && c.ty == TransferType::Binary)
        .collect()
}

/// SQLite ターゲットの `UnsignedBigInt` 列に i64 の範囲を超える値があれば、列名付きの
/// エラーにする。INTEGER 列へ入れると REAL に変換されて値が黙って失われるため。
pub fn check_sqlite_unsigned_range(
    driver: DriverKind,
    columns: &[TransferColumn],
    rows: &[Vec<Value>],
) -> Result<()> {
    if driver != DriverKind::Sqlite {
        return Ok(());
    }
    for (i, c) in columns.iter().enumerate() {
        if c.ty != TransferType::UnsignedBigInt {
            continue;
        }
        // MySQL の BIGINT UNSIGNED は `Value::from_u64_lossless` で 2^53 を超えると
        // `Value::String` (十進文字列) になるので、文字列も数値として読んで判定する。
        let above_i64 = |v: Option<&Value>| match v {
            Some(Value::UInt(n)) => *n > i64::MAX as u64,
            Some(Value::String(s)) => s.parse::<u64>().is_ok_and(|n| n > i64::MAX as u64),
            _ => false,
        };
        if rows.iter().any(|r| above_i64(r.get(i))) {
            return Err(AppError::InvalidInput(format!(
                "column \"{}\" has a value above 9223372036854775807, which SQLite INTEGER cannot hold without losing precision",
                c.name
            )));
        }
    }
    Ok(())
}

/// 1 セルをインポート経路へ渡すテキストへ変換する。`None` は SQL NULL。
pub fn value_to_cell(driver: DriverKind, ty: &TransferType, value: &Value) -> Option<String> {
    // SQLite / MySQL は Binary 列を `UNHEX(?)` に包んで渡す ([`hex_binary_columns`])。
    // SQLite は型を強制しないので BLOB 列に文字列・数値が入っていることがあり、その
    // テキストをそのまま渡すと UNHEX が NULL を返して値が消える。バイト列以外は
    // テキストのバイト列を hex にして渡す (値を保つ)。
    if *ty == TransferType::Binary
        && matches!(driver, DriverKind::Sqlite | DriverKind::Mysql)
        && !matches!(value, Value::Bytes(_) | Value::Null)
    {
        let text = value_to_cell_inner(driver, ty, value)?;
        return Some(text.bytes().map(|b| format!("{b:02x}")).collect());
    }
    // PostgreSQL の bytea は文字列をエスケープ形式 (`\\` や `\x41`) として解釈してしまう
    // ので、バイト列以外は同じく `\x` + hex で渡して値を保つ (#1598)。
    if *ty == TransferType::Binary
        && driver == DriverKind::Postgres
        && !matches!(value, Value::Bytes(_) | Value::Null)
    {
        let text = value_to_cell_inner(driver, ty, value)?;
        let hex: String = text.bytes().map(|b| format!("{b:02x}")).collect();
        return Some(format!("\\x{hex}"));
    }
    value_to_cell_inner(driver, ty, value)
}

fn value_to_cell_inner(driver: DriverKind, ty: &TransferType, value: &Value) -> Option<String> {
    let bool_text = |b: bool| -> String {
        match driver {
            DriverKind::Postgres => {
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
        // 真偽値列へ 0 / 1 以外の整数 (SQLite は型を強制しない。BIT(n) も該当) が来ても
        // `true` へ黙って丸めない。そのままの数値テキストで渡し、ターゲットが保持できれば
        // 値を保ち (MySQL / SQLite)、できなければ (PostgreSQL の BOOLEAN) 行エラーにする。
        // MySQL の BIT(n) は 16 進文字列 (`Bytes`)、PostgreSQL の bit(n) は `'10101010'` の
        // ビット列で届く。そのまま渡すと MySQL では `'0a'` が 0 になり、PostgreSQL の
        // BOOLEAN は構文エラーになるので、整数値に直して渡す (#1598)。
        // BIT(n) の 16 進文字列を整数列へ転送するとき (型上書き, #1623) は、`'0a'` のような
        // 16 進のまま渡さず整数値に直す。
        Value::Bytes(hex) if *ty == TransferType::Integer => Some(
            u64::from_str_radix(hex, 16)
                .map(|n| n.to_string())
                .unwrap_or_else(|_| hex.clone()),
        ),
        Value::Bytes(hex) if *ty == TransferType::Boolean => {
            Some(match u64::from_str_radix(hex, 16) {
                Ok(n) if n <= 1 => bool_text(n == 1),
                Ok(n) => n.to_string(),
                Err(_) => hex.clone(),
            })
        }
        Value::String(s)
            if *ty == TransferType::Boolean
                && s.len() > 1
                && s.len() <= 64
                && s.bytes().all(|b| b == b'0' || b == b'1') =>
        {
            Some(match u64::from_str_radix(s, 2) {
                Ok(n) if n <= 1 => bool_text(n == 1),
                Ok(n) => n.to_string(),
                Err(_) => s.clone(),
            })
        }
        Value::Int(n) if *ty == TransferType::Boolean && (*n == 0 || *n == 1) => {
            Some(bool_text(*n == 1))
        }
        Value::UInt(n) if *ty == TransferType::Boolean && *n <= 1 => Some(bool_text(*n == 1)),
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
                DriverKind::Sqlite | DriverKind::Mysql => hex.clone(),
            })
        }
    }
}

/// 転送で実際に値や型が変わる列変換の種別 (#1532)。ターゲット方言の DDL 型へ
/// 落とすときに精度・型の情報が縮退する組み合わせだけを検出する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LossyKind {
    /// 精度/小数桁がターゲット方言の上限を超え、DDL 型で丸められる (MySQL: 65 桁 / 小数 30 桁、
    /// PostgreSQL: 1000 桁)。
    DecimalClamped,
    /// SQLite は NUMERIC を INTEGER / REAL に寄せるため、有効桁 15 桁超の小数は桁落ちしうる。
    DecimalFloat,
    /// タイムゾーン付き時刻が時刻型ではなく文字列 (MySQL: VARCHAR) / 型アフィニティ頼み
    /// (SQLite) に縮退し、時刻としての比較・演算ができなくなる。
    TimestampTzDegraded,
}

/// 1 列ぶんの縮退する変換。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LossyConversion {
    pub column: String,
    pub kind: LossyKind,
    pub source_type: String,
    pub target_type: String,
}

/// 列ごとの精度・型の縮退を検出する (純関数。ドライバは転送先)。
pub fn lossy_conversions(driver: DriverKind, columns: &[TransferColumn]) -> Vec<LossyConversion> {
    let mut out = Vec::new();
    for c in columns {
        let kind = match &c.ty {
            TransferType::Decimal { precision, scale } => {
                let (max_p, max_s) = match driver {
                    DriverKind::Mysql => (65, 30),
                    DriverKind::Postgres => (1000, 1000),
                    DriverKind::Sqlite => (0, 0),
                };
                if driver == DriverKind::Sqlite {
                    // 精度が分かっていて 15 桁を超えるときだけ。精度不明 (無制限 NUMERIC など)
                    // は実際の値が分からず誤検知が多いので警告しない。
                    // 小数桁の無い整数 decimal は 18 桁まで INTEGER (64bit) で正確に持てる。
                    let exact_integer =
                        scale.unwrap_or(0) == 0 && precision.is_some_and(|p| p <= 18);
                    if !exact_integer && precision.is_some_and(|p| p > 15) {
                        Some(LossyKind::DecimalFloat)
                    } else {
                        None
                    }
                } else if precision.is_some_and(|p| p > max_p)
                    || scale.is_some_and(|s| s > max_s)
                    // MySQL の DECIMAL は s <= p が必須なので、PostgreSQL の NUMERIC(3,5) の
                    // ような定義は p に丸められる (#1598)。
                    || (driver == DriverKind::Mysql
                        && matches!((precision, scale), (Some(p), Some(s)) if s > p))
                {
                    Some(LossyKind::DecimalClamped)
                } else {
                    None
                }
            }
            TransferType::TimestampTz if driver != DriverKind::Postgres => {
                Some(LossyKind::TimestampTzDegraded)
            }
            _ => None,
        };
        if let Some(kind) = kind {
            out.push(LossyConversion {
                column: c.name.clone(),
                kind,
                source_type: c.source_type.clone(),
                target_type: target_type_sql(driver, &c.ty),
            });
        }
    }
    out
}

impl LossyConversion {
    /// ログ・完了通知向けの英語メッセージ (UI の転送前プレビューは `kind` から翻訳する)。
    pub fn message(&self) -> String {
        let (c, s, t) = (&self.column, &self.source_type, &self.target_type);
        match self.kind {
            LossyKind::DecimalClamped => format!(
                "column \"{c}\" ({s}) exceeds the target's decimal limits and is rounded to {t}"
            ),
            LossyKind::DecimalFloat => format!(
                "column \"{c}\" ({s}) is stored as {t} on SQLite and may lose digits beyond 15 significant digits"
            ),
            LossyKind::TimestampTzDegraded => format!(
                "column \"{c}\" ({s}) has no timezone-aware type on this target and is stored as {t} (offset kept as text)"
            ),
        }
    }
}

/// 転送結果のユーザ向け注意書き (損失のあるマッピング等)。
pub fn plan_warnings(driver: DriverKind, columns: &[TransferColumn]) -> Vec<String> {
    // バイナリは INSERT の値式で忠実に書けるので警告対象ではない (#1530)。
    lossy_conversions(driver, columns)
        .iter()
        .map(LossyConversion::message)
        .collect()
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
        for driver in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
            for ty in &all_types {
                let sql = target_type_sql(driver, ty);
                assert!(!sql.is_empty(), "{driver:?} {ty:?}");
                // 再分類しても論理型の「系統」が崩れないこと (往復の安定性)。
                // MySQL の TimestampTz (VARCHAR) は意図的な縮退なので除外する。
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
            drop_table_sql(DriverKind::Postgres, "t"),
            "DROP TABLE IF EXISTS \"t\""
        );
        assert_eq!(
            source_select_sql(DriverKind::Mysql, "a`b"),
            "SELECT * FROM `a``b`"
        );
    }

    #[test]
    fn boolean_column_keeps_integers_other_than_zero_and_one() {
        let b = TransferType::Boolean;
        for driver in [DriverKind::Mysql, DriverKind::Sqlite, DriverKind::Postgres] {
            // 0 / 1 だけが真偽値へ変換される。
            let t = if driver == DriverKind::Postgres {
                "true"
            } else {
                "1"
            };
            let f = if driver == DriverKind::Postgres {
                "false"
            } else {
                "0"
            };
            assert_eq!(
                value_to_cell(driver, &b, &Value::Int(1)).as_deref(),
                Some(t)
            );
            assert_eq!(
                value_to_cell(driver, &b, &Value::Int(0)).as_deref(),
                Some(f)
            );
            assert_eq!(
                value_to_cell(driver, &b, &Value::UInt(1)).as_deref(),
                Some(t)
            );
            // それ以外は true へ黙って丸めず、数値のまま渡す。
            assert_eq!(
                value_to_cell(driver, &b, &Value::Int(2)).as_deref(),
                Some("2")
            );
            assert_eq!(
                value_to_cell(driver, &b, &Value::Int(-1)).as_deref(),
                Some("-1")
            );
            assert_eq!(
                value_to_cell(driver, &b, &Value::UInt(255)).as_deref(),
                Some("255")
            );
        }
    }

    #[test]
    fn unsigned_bigint_on_sqlite_is_integer_with_range_check() {
        assert_eq!(
            target_type_sql(DriverKind::Sqlite, &TransferType::UnsignedBigInt),
            "INTEGER"
        );
        let cols = vec![TransferColumn {
            name: "n".into(),
            source_type: "BIGINT UNSIGNED".into(),
            ty: TransferType::UnsignedBigInt,
        }];
        // 実際のデコード結果 (from_u64_lossless) で確かめる。2^53 超は String になる。
        let ok = vec![vec![Value::from_u64_lossless(i64::MAX as u64)]];
        let big = vec![vec![Value::from_u64_lossless(i64::MAX as u64 + 1)]];
        let max = vec![vec![Value::from_u64_lossless(u64::MAX)]];
        assert!(check_sqlite_unsigned_range(DriverKind::Sqlite, &cols, &ok).is_ok());
        assert!(check_sqlite_unsigned_range(DriverKind::Sqlite, &cols, &big).is_err());
        assert!(check_sqlite_unsigned_range(DriverKind::Sqlite, &cols, &max).is_err());
        // 他ドライバは対象外。
        assert!(check_sqlite_unsigned_range(DriverKind::Mysql, &cols, &big).is_ok());
    }

    #[test]
    fn value_to_cell_encodes_per_target() {
        let b = TransferType::Boolean;
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &b, &Value::Bool(true)).as_deref(),
            Some("true")
        );
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &b, &Value::Bool(true)).as_deref(),
            Some("1")
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
            value_to_cell(DriverKind::Sqlite, &bin, &v).as_deref(),
            Some("00ff")
        );
        assert_eq!(
            value_to_cell(DriverKind::Mysql, &bin, &v).as_deref(),
            Some("00ff")
        );
        // Binary 列に入った文字列・数値はテキストのバイト列を hex にする (UNHEX で消えない)
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &bin, &Value::String("AB".into())).as_deref(),
            Some("4142")
        );
        assert_eq!(
            value_to_cell(DriverKind::Mysql, &bin, &Value::Int(12)).as_deref(),
            Some("3132")
        );
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &bin, &Value::String("AB".into())).as_deref(),
            // bytea のエスケープ形式として解釈されないよう `\x` + hex で渡す (#1598)
            Some("\\x4142")
        );
        // バイナリでない列に入るバイト列は hex テキストのまま
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &TransferType::Text, &v).as_deref(),
            Some("00ff")
        );
    }

    #[test]
    fn hex_unwrap_only_for_text_only_binary_targets() {
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
            hex_binary_columns(DriverKind::Sqlite, &cols),
            vec![true, false]
        );
        assert_eq!(
            hex_binary_columns(DriverKind::Mysql, &cols),
            vec![true, false]
        );
        assert_eq!(
            hex_binary_columns(DriverKind::Postgres, &cols),
            vec![false, false]
        );
        assert!(plan_warnings(DriverKind::Postgres, &cols).is_empty());
    }

    #[test]
    fn detects_lossy_conversions_per_target() {
        let col = |name: &str, ty: TransferType| TransferColumn {
            name: name.into(),
            source_type: "src".into(),
            ty,
        };
        let dec = |p, s| TransferType::Decimal {
            precision: p,
            scale: s,
        };
        let cols = vec![
            col("a", dec(Some(70), Some(2))),
            col("b", dec(Some(40), Some(35))),
            col("c", dec(Some(10), Some(2))),
            col("e", dec(Some(18), Some(0))),
            col("d", dec(None, None)),
            col("t", TransferType::TimestampTz),
            col("i", TransferType::Integer),
        ];
        let kinds = |d| {
            lossy_conversions(d, &cols)
                .into_iter()
                .map(|l| (l.column, l.kind))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            kinds(DriverKind::Mysql),
            vec![
                ("a".to_string(), LossyKind::DecimalClamped),
                ("b".to_string(), LossyKind::DecimalClamped),
                ("t".to_string(), LossyKind::TimestampTzDegraded),
            ]
        );
        // PostgreSQL は 1000 桁まで。タイムゾーン付きもそのまま持てる。
        assert!(kinds(DriverKind::Postgres).is_empty());
        assert_eq!(
            kinds(DriverKind::Sqlite),
            vec![
                ("a".to_string(), LossyKind::DecimalFloat),
                ("b".to_string(), LossyKind::DecimalFloat),
                ("t".to_string(), LossyKind::TimestampTzDegraded),
            ]
        );
        let w = plan_warnings(DriverKind::Mysql, &cols);
        assert_eq!(w.len(), 3);
        assert!(w[0].contains("\"a\""));
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
        assert!(!TransferMode::Upsert.creates_table());
        assert!(TransferMode::Upsert.writes_existing_table());
        assert!(TransferMode::Append.writes_existing_table());
        assert!(!TransferMode::Replace.writes_existing_table());
    }

    #[test]
    fn postgres_numeric_scale_above_precision_is_kept_1598() {
        let d = |driver, p, s| decimal_sql(driver, Some(p), Some(s));
        assert_eq!(d(DriverKind::Postgres, 3, 5), "NUMERIC(3,5)");
        // MySQL は s <= p が必須なので p に丸め、警告する。
        assert_eq!(d(DriverKind::Mysql, 3, 5), "DECIMAL(3,3)");
        let cols = vec![TransferColumn {
            name: "a".into(),
            ty: TransferType::Decimal {
                precision: Some(3),
                scale: Some(5),
            },
            source_type: "NUMERIC(3,5)".into(),
        }];
        assert!(lossy_conversions(DriverKind::Postgres, &cols).is_empty());
        assert_eq!(lossy_conversions(DriverKind::Mysql, &cols).len(), 1);
    }

    #[test]
    fn bit_values_become_integers_for_boolean_columns_1598() {
        let b = TransferType::Boolean;
        let bytes = |h: &str| Value::Bytes(h.into());
        assert_eq!(
            value_to_cell(DriverKind::Mysql, &b, &bytes("0a")).as_deref(),
            Some("10")
        );
        assert_eq!(
            value_to_cell(DriverKind::Sqlite, &b, &bytes("01")).as_deref(),
            Some("1")
        );
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &b, &bytes("01")).as_deref(),
            Some("true")
        );
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &b, &bytes("00")).as_deref(),
            Some("false")
        );
        let s = |t: &str| Value::String(t.into());
        assert_eq!(
            value_to_cell(DriverKind::Mysql, &b, &s("10101010")).as_deref(),
            Some("170")
        );
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &b, &s("1")).as_deref(),
            Some("1")
        );
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &b, &s("true")).as_deref(),
            Some("true")
        );
    }

    #[test]
    fn postgres_bytea_gets_hex_for_non_bytes_1598() {
        let bin = TransferType::Binary;
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &bin, &Value::String("a\\\\b".into())).as_deref(),
            Some("\\x615c5c62")
        );
        assert_eq!(
            value_to_cell(DriverKind::Postgres, &bin, &Value::Bytes("41".into())).as_deref(),
            Some("\\x41")
        );
    }
}
