//! ファイルから新規テーブルを作成するための DDL 生成 (#985)。
//!
//! インポート (`commands::import`) は従来「既存テーブル必須」だった。手元の
//! CSV / JSON をそのまま新しいテーブルとして取り込めるよう、フロントが推論した
//! (ユーザが上書きできる) **抽象列型** から方言別の `CREATE TABLE` を組み立てる。
//!
//! - 列型は任意文字列ではなく [`NewColumnType`] の列挙に限定する。フロントから
//!   型名の文字列を受け取らないので、型名経由の SQL 注入の余地が無い。
//! - 識別子は [`quote_ident`] で必ずクォートする (予約語・空白・引用符を含む
//!   名前も安全に通る)。
//! - DB が表現できない型は方言ごとに**グレースフルに縮退**する (SQLite には
//!   DATE / TIMESTAMP が無いので TEXT へ、など)。
//! - 生成した DDL はプレビュー (`preview_create_table_ddl`) と実行
//!   (`import_csv` の `create_table`) で**同じ関数**を通るため、画面に出た DDL と
//!   実際に流れる DDL がズレない。
//!
//! 取り込みそのものは既存の `import_rows` / `import_rows_skipping` 経路へ合流
//! させ、新しい書き込み経路は増やさない。

use std::collections::HashSet;

use serde::Deserialize;

use super::sync::quote_ident;
use super::DriverKind;
use crate::error::{AppError, Result};

/// 新規テーブルの列に付けられる抽象型。フロントの `newTableInference.ts` の
/// `NewColumnType` と 1:1 に対応する (serde 名は小文字)。
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NewColumnType {
    /// 32bit 符号付き整数に収まる整数。
    Integer,
    /// 64bit 符号付き整数に収まる整数。
    Bigint,
    /// 固定小数点 (整数部 28 桁 + 小数部 10 桁まで)。
    Decimal,
    /// 倍精度浮動小数点。
    Double,
    /// 真偽値。
    Boolean,
    /// 日付 (`YYYY-MM-DD`)。
    Date,
    /// 日時 (`YYYY-MM-DD HH:MM:SS[.ffffff]`、タイムゾーンなし)。
    Datetime,
    /// 文字列 (長さ無制限)。
    Text,
}

/// 新規テーブルの 1 列。`name` は作成するテーブルの列名 (= インポートの
/// マッピング先列名)。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: NewColumnType,
}

/// 抽象型 → 方言の型名。DB が表現できない型はここで縮退させる。
pub fn column_type_sql(driver: DriverKind, ty: NewColumnType) -> &'static str {
    use DriverKind as D;
    use NewColumnType as T;
    match (driver, ty) {
        (D::Mysql, T::Integer) => "INT",
        (D::Mysql, T::Bigint) => "BIGINT",
        (D::Mysql, T::Decimal) => "DECIMAL(38, 10)",
        (D::Mysql, T::Double) => "DOUBLE",
        // MySQL の BOOLEAN は TINYINT(1) の別名。インポートは値を文字列リテラルで
        // 流すため 'true' は変換エラーになる — フロントは MySQL で boolean を推論も
        // 選択肢にも出さないが、0/1 のデータを明示指定された場合に備えて型は保つ。
        (D::Mysql, T::Boolean) => "BOOLEAN",
        (D::Mysql, T::Date) => "DATE",
        // 秒未満 6 桁を保持する (DATETIME の既定精度 0 だと丸められる)。
        (D::Mysql, T::Datetime) => "DATETIME(6)",
        // TEXT は 64KiB 上限。JSON のネスト値などの長いセルで落ちないよう LONGTEXT。
        (D::Mysql, T::Text) => "LONGTEXT",

        (D::Postgres, T::Integer) => "INTEGER",
        (D::Postgres, T::Bigint) => "BIGINT",
        (D::Postgres, T::Decimal) => "NUMERIC",
        (D::Postgres, T::Double) => "DOUBLE PRECISION",
        (D::Postgres, T::Boolean) => "BOOLEAN",
        (D::Postgres, T::Date) => "DATE",
        (D::Postgres, T::Datetime) => "TIMESTAMP",
        (D::Postgres, T::Text) => "TEXT",

        // SQLite は型アフィニティのみ。INTEGER は 64bit まで保持する。日付・日時は
        // 専用型が無いので値をそのまま残せる TEXT へ縮退する (BOOLEAN は宣言型として
        // 残すだけで NUMERIC アフィニティ扱い)。
        (D::Sqlite, T::Integer | T::Bigint) => "INTEGER",
        (D::Sqlite, T::Decimal) => "NUMERIC",
        (D::Sqlite, T::Double) => "REAL",
        (D::Sqlite, T::Boolean) => "BOOLEAN",
        (D::Sqlite, T::Date | T::Datetime | T::Text) => "TEXT",

        (D::DuckDb, T::Integer) => "INTEGER",
        (D::DuckDb, T::Bigint) => "BIGINT",
        (D::DuckDb, T::Decimal) => "DECIMAL(38, 10)",
        (D::DuckDb, T::Double) => "DOUBLE",
        (D::DuckDb, T::Boolean) => "BOOLEAN",
        (D::DuckDb, T::Date) => "DATE",
        (D::DuckDb, T::Datetime) => "TIMESTAMP",
        (D::DuckDb, T::Text) => "VARCHAR",

        (D::Mssql, T::Integer) => "INT",
        (D::Mssql, T::Bigint) => "BIGINT",
        (D::Mssql, T::Decimal) => "DECIMAL(38, 10)",
        (D::Mssql, T::Double) => "FLOAT",
        (D::Mssql, T::Boolean) => "BIT",
        (D::Mssql, T::Date) => "DATE",
        (D::Mssql, T::Datetime) => "DATETIME2",
        (D::Mssql, T::Text) => "NVARCHAR(MAX)",
    }
}

/// 識別子の長さ上限 (`None` = 実用上無制限)。PostgreSQL は超過分を**黙って
/// 切り詰める**ため、作成した名前とインポート時の名前が食い違って「テーブルが
/// 無い」エラーになる。作成前に弾いて分かりやすいエラーにする。
fn max_ident_len(driver: DriverKind) -> Option<(usize, bool)> {
    // (上限, true = バイト数 / false = 文字数)
    match driver {
        DriverKind::Mysql => Some((64, false)),
        DriverKind::Postgres => Some((63, true)),
        DriverKind::Mssql => Some((128, false)),
        DriverKind::Sqlite | DriverKind::DuckDb => None,
    }
}

fn validate_ident(driver: DriverKind, what: &str, name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput(format!("{what} name is empty")));
    }
    if name.contains('\0') {
        return Err(AppError::InvalidInput(format!(
            "{what} name must not contain a NUL character"
        )));
    }
    if name != name.trim() {
        // MySQL は末尾空白の識別子を拒否し、他 DB でも取り違えの元になる。
        return Err(AppError::InvalidInput(format!(
            "{what} name must not start or end with whitespace: {name:?}"
        )));
    }
    if let Some((limit, bytes)) = max_ident_len(driver) {
        let len = if bytes {
            name.len()
        } else {
            name.chars().count()
        };
        if len > limit {
            return Err(AppError::InvalidInput(format!(
                "{what} name is too long ({len} > {limit}): {name}"
            )));
        }
    }
    Ok(())
}

/// 新規テーブル定義を検証する。テーブル名・列名が空でない / 前後空白なし /
/// 方言の長さ上限内であること、列が 1 つ以上あり、列名が**大文字小文字を
/// 無視して**重複しないこと (MySQL / SQL Server / SQLite / DuckDB は列名の
/// 大文字小文字を区別しないため、保守的に全方言で同じ規則にする)。
pub fn validate_new_table(driver: DriverKind, table: &str, columns: &[NewColumn]) -> Result<()> {
    validate_ident(driver, "table", table)?;
    if columns.is_empty() {
        return Err(AppError::InvalidInput(
            "a new table needs at least one column".into(),
        ));
    }
    let mut seen: HashSet<String> = HashSet::new();
    for col in columns {
        validate_ident(driver, "column", &col.name)?;
        if !seen.insert(col.name.to_lowercase()) {
            return Err(AppError::InvalidInput(format!(
                "duplicate column name: {}",
                col.name
            )));
        }
    }
    Ok(())
}

/// 方言別の `CREATE TABLE` を生成する。列はすべて NULL 許容 (NULL トークンや
/// JSON の欠損キーが NULL として入るため)。主キー・制約は付けない — 取り込み後に
/// 通常の ALTER / インデックス作成で付ける想定。
pub fn render_create_table(
    driver: DriverKind,
    table: &str,
    columns: &[NewColumn],
) -> Result<String> {
    validate_new_table(driver, table, columns)?;
    let body = columns
        .iter()
        .map(|c| {
            format!(
                "  {} {}",
                quote_ident(driver, &c.name),
                column_type_sql(driver, c.column_type)
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");
    Ok(format!(
        "CREATE TABLE {} (\n{}\n)",
        quote_ident(driver, table),
        body
    ))
}

/// 取り込み失敗時 (abort モード) に、直前に自分で作ったテーブルを片付ける DDL。
pub fn render_drop_table(driver: DriverKind, table: &str) -> String {
    format!("DROP TABLE {}", quote_ident(driver, table))
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

    fn col(name: &str, ty: NewColumnType) -> NewColumn {
        NewColumn {
            name: name.to_string(),
            column_type: ty,
        }
    }

    #[test]
    fn renders_each_dialect_with_quoting() {
        let cols = vec![
            col("id", NewColumnType::Bigint),
            col("name", NewColumnType::Text),
        ];
        assert_eq!(
            render_create_table(DriverKind::Mysql, "users", &cols).unwrap(),
            "CREATE TABLE `users` (\n  `id` BIGINT,\n  `name` LONGTEXT\n)"
        );
        assert_eq!(
            render_create_table(DriverKind::Postgres, "users", &cols).unwrap(),
            "CREATE TABLE \"users\" (\n  \"id\" BIGINT,\n  \"name\" TEXT\n)"
        );
        assert_eq!(
            render_create_table(DriverKind::Sqlite, "users", &cols).unwrap(),
            "CREATE TABLE \"users\" (\n  \"id\" INTEGER,\n  \"name\" TEXT\n)"
        );
        assert_eq!(
            render_create_table(DriverKind::DuckDb, "users", &cols).unwrap(),
            "CREATE TABLE \"users\" (\n  \"id\" BIGINT,\n  \"name\" VARCHAR\n)"
        );
        assert_eq!(
            render_create_table(DriverKind::Mssql, "users", &cols).unwrap(),
            "CREATE TABLE [users] (\n  [id] BIGINT,\n  [name] NVARCHAR(MAX)\n)"
        );
    }

    #[test]
    fn reserved_words_and_embedded_quotes_are_quoted() {
        let cols = vec![
            col("select", NewColumnType::Integer),
            col("a\"b`c]d", NewColumnType::Text),
            col("order date", NewColumnType::Date),
        ];
        let my = render_create_table(DriverKind::Mysql, "from", &cols).unwrap();
        assert!(my.starts_with("CREATE TABLE `from` ("));
        assert!(my.contains("`select` INT"));
        assert!(my.contains("`a\"b``c]d` LONGTEXT"));
        assert!(my.contains("`order date` DATE"));

        let pg = render_create_table(DriverKind::Postgres, "from", &cols).unwrap();
        assert!(pg.contains("\"select\" INTEGER"));
        assert!(pg.contains("\"a\"\"b`c]d\" TEXT"));

        let ms = render_create_table(DriverKind::Mssql, "from", &cols).unwrap();
        assert!(ms.contains("[a\"b`c]]d] NVARCHAR(MAX)"));
    }

    #[test]
    fn rejects_empty_names_and_no_columns() {
        for d in ALL {
            assert!(render_create_table(d, "", &[col("a", NewColumnType::Text)]).is_err());
            assert!(render_create_table(d, "   ", &[col("a", NewColumnType::Text)]).is_err());
            assert!(render_create_table(d, "t", &[]).is_err());
            assert!(render_create_table(d, "t", &[col("", NewColumnType::Text)]).is_err());
            assert!(render_create_table(d, "t", &[col(" a", NewColumnType::Text)]).is_err());
            assert!(render_create_table(d, "t\0x", &[col("a", NewColumnType::Text)]).is_err());
        }
    }

    #[test]
    fn rejects_case_insensitive_duplicate_columns() {
        for d in ALL {
            let err = render_create_table(
                d,
                "t",
                &[
                    col("Name", NewColumnType::Text),
                    col("name", NewColumnType::Text),
                ],
            )
            .unwrap_err();
            assert!(err.to_string().contains("duplicate column name"));
        }
    }

    #[test]
    fn enforces_dialect_identifier_length() {
        let long63 = "a".repeat(63);
        let long64 = "a".repeat(64);
        let cols = [col("a", NewColumnType::Text)];
        assert!(render_create_table(DriverKind::Postgres, &long63, &cols).is_ok());
        assert!(render_create_table(DriverKind::Postgres, &long64, &cols).is_err());
        // PostgreSQL の上限はバイト数 (マルチバイト 22 文字 = 66 バイト)。
        assert!(render_create_table(DriverKind::Postgres, &"あ".repeat(22), &cols).is_err());
        // MySQL は文字数。
        assert!(render_create_table(DriverKind::Mysql, &"あ".repeat(64), &cols).is_ok());
        assert!(render_create_table(DriverKind::Mysql, &"あ".repeat(65), &cols).is_err());
        assert!(render_create_table(DriverKind::Sqlite, &"a".repeat(500), &cols).is_ok());
    }

    #[test]
    fn sqlite_degrades_temporal_types_to_text_and_keeps_64bit_integers() {
        assert_eq!(
            column_type_sql(DriverKind::Sqlite, NewColumnType::Date),
            "TEXT"
        );
        assert_eq!(
            column_type_sql(DriverKind::Sqlite, NewColumnType::Datetime),
            "TEXT"
        );
        // SQLite の INTEGER は 8 バイトまで保持するので BIGINT 相当。
        assert_eq!(
            column_type_sql(DriverKind::Sqlite, NewColumnType::Bigint),
            "INTEGER"
        );
        assert_eq!(
            column_type_sql(DriverKind::Mysql, NewColumnType::Bigint),
            "BIGINT"
        );
        assert_eq!(
            column_type_sql(DriverKind::Mssql, NewColumnType::Boolean),
            "BIT"
        );
        assert_eq!(
            column_type_sql(DriverKind::Mysql, NewColumnType::Datetime),
            "DATETIME(6)"
        );
    }

    #[test]
    fn deserializes_wire_shape() {
        let cols: Vec<NewColumn> = serde_json::from_str(
            r#"[{"name":"id","type":"bigint"},{"name":"at","type":"datetime"}]"#,
        )
        .unwrap();
        assert_eq!(cols[0], col("id", NewColumnType::Bigint));
        assert_eq!(cols[1], col("at", NewColumnType::Datetime));
        assert!(serde_json::from_str::<NewColumn>(r#"{"name":"x","type":"varchar(10)"}"#).is_err());
    }

    #[test]
    fn drop_table_is_quoted() {
        assert_eq!(
            render_drop_table(DriverKind::Mysql, "a`b"),
            "DROP TABLE `a``b`"
        );
        assert_eq!(render_drop_table(DriverKind::Mssql, "t"), "DROP TABLE [t]");
    }
}
