//! MySQL / PostgreSQL のネイティブ SQL ダンプ (#2033)。
//!
//! 外部バイナリ (`mysqldump` / `pg_dump`) に頼らず、接続経由で SQL ダンプを生成する。
//! SQLite の `dump_sqlite` と同じ構造で、
//!
//! - DDL は `Connection::object_definition` (表・ビュー・ルーチン・トリガー) を再利用し、
//! - 行データは `Connection::execute_stream` で 1 バッチずつ `INSERT` に変換して書き出す
//!   (全行をメモリへ載せない)。
//! - リテラル / 識別子クォートは SQL エクスポートと共通の `db::data_diff::sql_literal` /
//!   `db::sync::quote_ident` を使う (64bit 整数・バイナリ・NULL・特殊文字の扱いを共有)。
//!
//! 書き込み先 (一時ファイル → rename・gzip・整形・チェックサム) は `dump::run_dump` が
//! 面倒を見るので、ここは開いたファイルへ書くだけ (新しい書き込み経路は増やさない)。
//!
//! 既知の制約 (外部ツール経路との差):
//! - `single_transaction` は効かない (接続プールの別接続で表ごとに読むため、表をまたぐ
//!   一貫したスナップショットにはならない)。
//! - PostgreSQL は 1 スキーマ単位 (`pg_schema`、無ければツリーのスキーマ、タスク経路では
//!   `public`)。所有者・権限・コメント・identity 列の `GENERATED` は出さない。
//! - MySQL のビュー定義は `SHOW CREATE VIEW` のままなので、元と別名の DB へ復元すると
//!   DB 名修飾が残る。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::commands::dump::{
    ensure_tables_exist, selected_tables, write_chunk, write_chunk_off_worker, DumpOptions,
    DUMP_PROGRESS_BYTES, DUMP_PROGRESS_INTERVAL, DUMP_STREAM_BATCH,
};
use crate::commands::export::load_mask_spec;
use crate::db::data_diff::sql_literal;
use crate::db::masking::MaskPlan;
use crate::db::sync::quote_ident;
use crate::db::types::{ForeignKey, SchemaObject, StreamBatch, Value};
use crate::db::{Connection, DriverKind};
use crate::error::{AppError, Result};

/// 複数行 `INSERT` 1 文の上限バイト数。巨大な 1 文はサーバの `max_allowed_packet` に
/// 当たるので、これを超える前に文を区切る (mysqldump の `--net-buffer-length` 相当)。
const MAX_EXTENDED_STMT_BYTES: usize = 1024 * 1024;

/// 進捗コールバック: (書き出しバイト数, 処理済みテーブル数, テーブル総数)。
pub type ProgressFn = Arc<dyn Fn(u64, u64, u64) + Send + Sync>;

// ---------------------------------------------------------------------------
// 純関数 (SQL 文字列の組み立て)。実サーバなしで単体テストできる。
// ---------------------------------------------------------------------------

/// 出力に使う表名。MySQL はダンプ先 DB を選べるよう非修飾、PostgreSQL は `schema.table`。
pub(crate) fn qualified_table(driver: DriverKind, schema: &str, table: &str) -> String {
    match driver {
        DriverKind::Postgres => format!(
            "{}.{}",
            quote_ident(driver, schema),
            quote_ident(driver, table)
        ),
        DriverKind::Mysql | DriverKind::Sqlite => quote_ident(driver, table),
    }
}

/// `INSERT INTO <表> (<列>, ...)` まで (`VALUES` は含めない)。
pub(crate) fn insert_prefix(
    driver: DriverKind,
    schema: &str,
    table: &str,
    columns: &[String],
) -> String {
    let cols: Vec<String> = columns.iter().map(|c| quote_ident(driver, c)).collect();
    format!(
        "INSERT INTO {} ({})",
        qualified_table(driver, schema, table),
        cols.join(", ")
    )
}

/// 1 行を `(v1, v2, ...)` にする。
pub(crate) fn row_tuple(driver: DriverKind, row: &[Value]) -> String {
    let vals: Vec<String> = row.iter().map(|v| sql_literal(driver, v)).collect();
    format!("({})", vals.join(", "))
}

/// 行バッチを `INSERT` 文にする。`extended` なら複数行を 1 文にまとめる (1 文が
/// [`MAX_EXTENDED_STMT_BYTES`] を超える前に区切る)。そうでなければ 1 行 1 文。
pub(crate) fn render_row_batch(
    driver: DriverKind,
    prefix: &str,
    rows: &[Vec<Value>],
    extended: bool,
) -> String {
    let mut out = String::new();
    // 現在開いている複数行文の長さ (0 = 文が開いていない)。
    let mut open_len = 0usize;
    for row in rows {
        let tuple = row_tuple(driver, row);
        if !extended {
            out.push_str(prefix);
            out.push_str(" VALUES ");
            out.push_str(&tuple);
            out.push_str(";\n");
            continue;
        }
        if open_len > 0 && open_len + tuple.len() + 2 > MAX_EXTENDED_STMT_BYTES {
            out.push_str(";\n");
            open_len = 0;
        }
        if open_len == 0 {
            out.push_str(prefix);
            out.push_str(" VALUES ");
            open_len = prefix.len() + 8;
        } else {
            out.push(',');
            open_len += 1;
        }
        out.push_str(&tuple);
        open_len += tuple.len();
    }
    if open_len > 0 {
        out.push_str(";\n");
    }
    out
}

/// 外部キーの親→子の順にテーブルを並べる (PostgreSQL の `CREATE TABLE` は FK を
/// インライン制約として持つため、参照先が先に存在しないと復元できない)。
/// 同順位は名前順。自己参照は無視し、循環があれば残りを名前順で末尾に付けて `true` を返す。
pub(crate) fn order_tables_by_fk(tables: &[String], fks: &[ForeignKey]) -> (Vec<String>, bool) {
    let mut sorted: Vec<String> = tables.to_vec();
    sorted.sort();
    sorted.dedup();
    let names: std::collections::HashSet<String> = sorted.iter().cloned().collect();
    let in_set = |t: &str| names.contains(t);
    // 子 -> 親(集合)
    let deps_of = |t: &str| -> Vec<&str> {
        let mut d: Vec<&str> = fks
            .iter()
            .filter(|f| f.table == t && f.referenced_table != t && in_set(&f.referenced_table))
            .map(|f| f.referenced_table.as_str())
            .collect();
        d.sort_unstable();
        d.dedup();
        d
    };
    let mut out: Vec<String> = Vec::with_capacity(sorted.len());
    let mut remaining = sorted;
    loop {
        let ready: Vec<usize> = remaining
            .iter()
            .enumerate()
            .filter(|(_, t)| deps_of(t).iter().all(|d| out.iter().any(|o| o == d)))
            .map(|(i, _)| i)
            .collect();
        if ready.is_empty() {
            break;
        }
        // 1 巡で準備できた分を名前順のまま移す (後ろの添字から抜く)。
        let moved: Vec<String> = ready.iter().map(|&i| remaining[i].clone()).collect();
        for &i in ready.iter().rev() {
            remaining.remove(i);
        }
        out.extend(moved);
        if remaining.is_empty() {
            break;
        }
    }
    let cyclic = !remaining.is_empty();
    out.extend(remaining);
    (out, cyclic)
}

/// MySQL の先頭/末尾。文字コード・チェック類を一時的に緩め、`AUTO_INCREMENT` の 0 を保ち、
/// バックスラッシュエスケープが効く SQL モードに固定する (リテラルは `\` を倍にして出す)。
pub(crate) fn mysql_header() -> &'static str {
    "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n\
     /*!40101 SET NAMES utf8mb4 */;\n\
     /*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n\
     /*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n\
     /*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\n"
}

pub(crate) fn mysql_footer() -> &'static str {
    "\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n\
     /*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n\
     /*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n\
     /*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n"
}

/// PostgreSQL の先頭。`standard_conforming_strings = on` は `'\x..'` (bytea) と
/// バックスラッシュ非エスケープのリテラルが正しく読まれるための前提。
pub(crate) fn postgres_header(schema: &str) -> String {
    let q = quote_ident(DriverKind::Postgres, schema);
    let mut out =
        String::from("SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n");
    if schema != "public" {
        out.push_str(&format!("CREATE SCHEMA IF NOT EXISTS {q};\n"));
    }
    out.push_str(&format!("SET search_path TO {q}, public;\n\n"));
    out
}

/// `DELIMITER` で包んだ定義文 (ルーチン / トリガー / イベントは本文に `;` を含むため。
/// mysqldump と同じ書式)。
pub(crate) fn mysql_delimited(def: &str) -> String {
    format!(
        "DELIMITER ;;\n{} ;;\nDELIMITER ;\n",
        def.trim_end_matches(';').trim_end()
    )
}

/// 末尾に `;` を足して改行で終える (既にあれば足さない)。
pub(crate) fn terminated(def: &str) -> String {
    let t = def.trim_end();
    if t.ends_with(';') {
        format!("{t}\n")
    } else {
        format!("{t};\n")
    }
}

/// PostgreSQL のシーケンス一覧を引く SQL。列は
/// (CREATE 文, 所有テーブル名 or NULL, `ALTER SEQUENCE ... OWNED BY` or NULL, `setval` or NULL)。
/// 生成列 (identity) が所有するシーケンスは `CREATE TABLE` 側で扱えないので除く。
pub(crate) fn pg_sequences_sql(schema: &str) -> String {
    let lit = sql_literal(DriverKind::Postgres, &Value::String(schema.to_string()));
    format!(
        "SELECT \
           format('CREATE SEQUENCE IF NOT EXISTS %I.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;', \
                  s.schemaname, s.sequencename, s.data_type::text, s.increment_by, s.min_value, s.max_value, \
                  s.start_value, s.cache_size, CASE WHEN s.cycle THEN ' CYCLE' ELSE '' END) AS create_stmt, \
           o.table_name AS owner_table, \
           CASE WHEN o.table_name IS NULL THEN NULL \
                ELSE format('ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I;', s.schemaname, s.sequencename, \
                            s.schemaname, o.table_name, o.column_name) END AS owned_stmt, \
           CASE WHEN s.last_value IS NULL THEN NULL \
                ELSE format('SELECT pg_catalog.setval(%L, %s, true);', \
                            quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename), s.last_value) END AS setval_stmt \
         FROM pg_sequences s \
         LEFT JOIN LATERAL ( \
              SELECT t.relname::text AS table_name, a.attname::text AS column_name, d.deptype \
                FROM pg_class c \
                JOIN pg_namespace n ON n.oid = c.relnamespace \
                JOIN pg_depend d ON d.objid = c.oid AND d.classid = 'pg_class'::regclass \
                                AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') \
                JOIN pg_class t ON t.oid = d.refobjid \
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
               WHERE c.relkind = 'S' AND c.relname = s.sequencename AND n.nspname = s.schemaname \
               LIMIT 1) o ON true \
         WHERE s.schemaname = {lit} AND COALESCE(o.deptype, 'a') <> 'i' \
         ORDER BY s.sequencename"
    )
}

/// PostgreSQL の列の型を `format_type` (`numeric(20,4)` / `text[]` / `timestamp with time zone` /
/// ユーザー定義型) で引く SQL。列は (列名, 型)。`information_schema` の `data_type` は配列を
/// `ARRAY`、ユーザー定義型を `USER-DEFINED` としか返さず、そのままでは `CREATE TABLE` に使えない。
pub(crate) fn pg_column_types_sql(schema: &str, table: &str) -> String {
    let s = sql_literal(DriverKind::Postgres, &Value::String(schema.to_string()));
    let t = sql_literal(DriverKind::Postgres, &Value::String(table.to_string()));
    format!(
        "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod) \
           FROM pg_attribute a \
           JOIN pg_class c ON c.oid = a.attrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = {s} AND c.relname = {t} AND a.attnum > 0 AND NOT a.attisdropped \
          ORDER BY a.attnum"
    )
}

/// PostgreSQL の `CREATE TABLE`。共有の再構成ロジック (`table_ddl`) に、`format_type` で
/// 引き直した正確な列の型を渡して作る。
async fn postgres_table_ddl(conn: &Connection, schema: &str, table: &str) -> Result<String> {
    let mut columns = conn.columns(schema, table).await?;
    if columns.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "no definition found for table '{table}'"
        )));
    }
    let types = conn
        .execute(&pg_column_types_sql(schema, table), None)
        .await?;
    for col in &mut columns {
        let exact = types
            .rows
            .iter()
            .find(|r| str_at(r, 0) == Some(col.name.as_str()))
            .and_then(|r| str_at(r, 1));
        if let Some(t) = exact {
            col.data_type = t.to_string();
        }
    }
    let indexes = conn.list_indexes(schema, table).await?;
    let fks = conn.foreign_keys_for_table(schema, table).await?;
    let extras = conn
        .table_ddl_extras(schema, table)
        .await
        .unwrap_or_default();
    Ok(crate::db::table_ddl::synthesize_create_table(
        DriverKind::Postgres,
        Some(schema),
        table,
        &columns,
        &indexes,
        &fks,
        &extras,
    ))
}

fn str_at(row: &[Value], i: usize) -> Option<&str> {
    match row.get(i) {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/// 対象スキーマ (MySQL は DB、PostgreSQL はスキーマ) を決める。PostgreSQL は `pg_schema`
/// → ツリーのスキーマ (`database`) → タスク経路では `public`。
pub(crate) fn resolve_schema<'a>(
    driver: DriverKind,
    database: &'a str,
    database_is_connection_db: bool,
    options: &'a DumpOptions,
) -> Result<&'a str> {
    let database = database.trim();
    let name = match driver {
        DriverKind::Postgres => {
            let pg_schema = options
                .pg_schema
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            match (pg_schema, database_is_connection_db) {
                (Some(s), _) => s,
                (None, false) => database,
                (None, true) => "public",
            }
        }
        _ => database,
    };
    if name.is_empty() {
        return Err(AppError::InvalidInput("database name is empty".into()));
    }
    if name.starts_with('-') || name.contains('\0') {
        return Err(AppError::InvalidInput(
            "database name must not start with '-'".into(),
        ));
    }
    Ok(name)
}

/// ネイティブダンプのコア。`file` へ SQL を書き、書いたバイト数を `counter` に積む。
#[allow(clippy::too_many_arguments)]
pub async fn dump_native_core(
    conn: &Connection,
    database: &str,
    database_is_connection_db: bool,
    file: std::fs::File,
    options: &DumpOptions,
    counter: &Arc<AtomicU64>,
    progress: ProgressFn,
) -> Result<u64> {
    let driver = conn.driver_kind();
    if driver == DriverKind::Sqlite {
        return Err(AppError::InvalidInput(
            "native dump is only for MySQL / PostgreSQL".into(),
        ));
    }
    let schema = resolve_schema(driver, database, database_is_connection_db, options)?.to_string();
    let selected = selected_tables(options)?;
    // マスキングはソルトの取得 (keyring) を伴うので、書き込み開始前に検証して fail closed。
    let mask_spec = load_mask_spec(options.masks.clone()).await?;

    let all_names = conn.tables(&schema).await?;
    let objects = conn.schema_objects(&schema).await?;
    let view_names: std::collections::HashSet<&str> = objects
        .iter()
        .filter(|o| o.kind == "view" || o.kind == "materialized_view")
        .map(|o| o.name.as_str())
        .collect();
    if let Some(sel) = &selected {
        ensure_tables_exist(sel, all_names.iter().map(String::as_str))?;
    }
    let in_scope = |n: &str| selected.as_ref().map_or(true, |s| s.iter().any(|x| x == n));
    let base_tables: Vec<String> = all_names
        .iter()
        .filter(|n| !view_names.contains(n.as_str()) && in_scope(n))
        .cloned()
        .collect();
    let views: Vec<&SchemaObject> = objects
        .iter()
        .filter(|o| (o.kind == "view" || o.kind == "materialized_view") && in_scope(&o.name))
        .collect();
    let whole_schema = selected.is_none();

    // PostgreSQL は FK 先行順。MySQL は FOREIGN_KEY_CHECKS=0 なので名前順 (SHOW TABLES 順)。
    let (ordered_tables, cyclic_fk) = if driver == DriverKind::Postgres {
        let fks = conn.foreign_keys(&schema).await.unwrap_or_default();
        order_tables_by_fk(&base_tables, &fks)
    } else {
        (base_tables.clone(), false)
    };

    let writer = Arc::new(std::sync::Mutex::new(std::io::BufWriter::new(file)));
    let schema_part = !options.no_create_info;
    let total_tables = ordered_tables.len() as u64;
    let report =
        |tables_done: u64| progress(counter.load(Ordering::SeqCst), tables_done, total_tables);

    // ---- 先頭 ----
    match driver {
        DriverKind::Mysql => write_chunk(&writer, counter, mysql_header())?,
        _ => write_chunk(&writer, counter, &postgres_header(&schema))?,
    }
    if cyclic_fk {
        write_chunk(
            &writer,
            counter,
            "-- WARNING: foreign keys form a cycle; CREATE TABLE order may need manual adjustment.\n\n",
        )?;
    }

    // ---- PostgreSQL のシーケンス (serial 列の DEFAULT nextval が参照する) ----
    let mut seq_owned_stmts: Vec<String> = Vec::new();
    let mut seq_setvals: Vec<String> = Vec::new();
    if driver == DriverKind::Postgres {
        let seqs = conn.execute(&pg_sequences_sql(&schema), None).await?;
        let mut create = String::new();
        for row in &seqs.rows {
            let owner = str_at(row, 1);
            // テーブル指定時は、指定テーブルが所有するか、誰も所有しないものだけ。
            if let Some(o) = owner {
                if !ordered_tables.iter().any(|t| t == o) {
                    continue;
                }
            } else if !whole_schema {
                continue;
            }
            if schema_part {
                if let Some(c) = str_at(row, 0) {
                    create.push_str(c);
                    create.push('\n');
                }
                if let Some(o) = str_at(row, 2) {
                    seq_owned_stmts.push(o.to_string());
                }
            }
            if !options.no_data {
                if let Some(s) = str_at(row, 3) {
                    seq_setvals.push(s.to_string());
                }
            }
        }
        if !create.is_empty() {
            create.push('\n');
            write_chunk(&writer, counter, &create)?;
        }
    }

    // ---- 表: DDL → 行データ ----
    let mut processed = 0u64;
    for name in &ordered_tables {
        let mut chunk = String::new();
        if schema_part {
            if options.add_drop_table {
                chunk.push_str(&format!(
                    "DROP TABLE IF EXISTS {}{};\n",
                    qualified_table(driver, &schema, name),
                    if driver == DriverKind::Postgres {
                        " CASCADE"
                    } else {
                        ""
                    }
                ));
            }
            let ddl = if driver == DriverKind::Postgres {
                postgres_table_ddl(conn, &schema, name).await?
            } else {
                conn.object_definition(&schema, "table", name, None).await?
            };
            chunk.push_str(&terminated(&ddl));
            chunk.push('\n');
        }
        write_chunk(&writer, counter, &chunk)?;

        if !options.no_data {
            // 生成列は INSERT できないので外し、列を明示して SELECT / INSERT の対応を固定する。
            let generated: std::collections::HashSet<String> = conn
                .generated_columns(Some(&schema), name)
                .await
                .unwrap_or_default()
                .into_iter()
                .collect();
            let columns: Vec<String> = conn
                .columns(&schema, name)
                .await?
                .into_iter()
                .map(|c| c.name)
                .filter(|c| !generated.contains(c))
                .collect();
            if !columns.is_empty() {
                stream_table_rows(
                    conn,
                    driver,
                    &schema,
                    name,
                    &columns,
                    options.extended_insert,
                    mask_spec.as_ref(),
                    &writer,
                    counter,
                    &progress,
                    processed,
                    total_tables,
                )
                .await?;
                write_chunk(&writer, counter, "\n")?;
            }
        }
        processed += 1;
        report(processed);
    }

    // ---- 表の後: オーナー付与・ビュー・ルーチン・トリガー・イベント ----
    if schema_part {
        let mut chunk = String::new();
        for s in &seq_owned_stmts {
            chunk.push_str(s);
            chunk.push('\n');
        }
        for v in &views {
            if options.add_drop_table {
                let kw = if v.kind == "materialized_view" {
                    "MATERIALIZED VIEW"
                } else {
                    "VIEW"
                };
                chunk.push_str(&format!(
                    "DROP {kw} IF EXISTS {};\n",
                    qualified_table(driver, &schema, &v.name)
                ));
            }
            let def = match driver {
                // PostgreSQL は表 DDL の入口がビューも振り分ける (完全な CREATE VIEW を返す)。
                DriverKind::Postgres => {
                    conn.object_definition(&schema, "table", &v.name, None)
                        .await?
                }
                _ => {
                    conn.object_definition(&schema, "view", &v.name, None)
                        .await?
                }
            };
            chunk.push_str(&terminated(&def));
            chunk.push('\n');
        }
        write_chunk(&writer, counter, &chunk)?;

        if whole_schema && options.routines {
            let mut chunk = String::new();
            for o in objects
                .iter()
                .filter(|o| o.kind == "function" || o.kind == "procedure")
            {
                let def = conn
                    .object_definition(&schema, &o.kind, &o.name, o.id.as_deref())
                    .await?;
                if driver == DriverKind::Mysql {
                    if options.add_drop_table {
                        chunk.push_str(&format!(
                            "DROP {} IF EXISTS {};\n",
                            o.kind.to_uppercase(),
                            quote_ident(driver, &o.name)
                        ));
                    }
                    chunk.push_str(&mysql_delimited(&def));
                } else {
                    chunk.push_str(&terminated(&def));
                }
                chunk.push('\n');
            }
            write_chunk(&writer, counter, &chunk)?;
        }

        if options.triggers {
            let mut chunk = String::new();
            for table in &ordered_tables {
                for trg in conn.list_table_triggers(&schema, table).await? {
                    if trg.definition.trim().is_empty() {
                        chunk.push_str(&format!(
                            "-- trigger {} on {} skipped: definition unavailable\n",
                            trg.name, table
                        ));
                        continue;
                    }
                    if driver == DriverKind::Mysql {
                        if options.add_drop_table {
                            chunk.push_str(&format!(
                                "DROP TRIGGER IF EXISTS {};\n",
                                quote_ident(driver, &trg.name)
                            ));
                        }
                        chunk.push_str(&mysql_delimited(&trg.definition));
                    } else {
                        if options.add_drop_table {
                            chunk.push_str(&format!(
                                "DROP TRIGGER IF EXISTS {} ON {};\n",
                                quote_ident(driver, &trg.name),
                                qualified_table(driver, &schema, table)
                            ));
                        }
                        chunk.push_str(&terminated(&trg.definition));
                        if !trg.enabled {
                            chunk.push_str(&format!(
                                "ALTER TABLE {} DISABLE TRIGGER {};\n",
                                qualified_table(driver, &schema, table),
                                quote_ident(driver, &trg.name)
                            ));
                        }
                    }
                    chunk.push('\n');
                }
            }
            write_chunk(&writer, counter, &chunk)?;
        }

        if driver == DriverKind::Mysql && whole_schema && options.events {
            let events = conn
                .execute(
                    &format!(
                        "SELECT EVENT_NAME FROM information_schema.EVENTS \
                         WHERE EVENT_SCHEMA = {} ORDER BY EVENT_NAME",
                        sql_literal(driver, &Value::String(schema.clone()))
                    ),
                    None,
                )
                .await?;
            let mut chunk = String::new();
            for row in &events.rows {
                let Some(ev) = str_at(row, 0) else { continue };
                let shown = conn
                    .execute(
                        &format!(
                            "SHOW CREATE EVENT {}.{}",
                            quote_ident(driver, &schema),
                            quote_ident(driver, ev)
                        ),
                        None,
                    )
                    .await?;
                let col = shown.columns.iter().position(|c| c.name == "Create Event");
                let def = col
                    .and_then(|i| shown.rows.first().and_then(|r| str_at(r, i)))
                    .unwrap_or("");
                if def.is_empty() {
                    chunk.push_str(&format!("-- event {ev} skipped: definition unavailable\n"));
                    continue;
                }
                if options.add_drop_table {
                    chunk.push_str(&format!(
                        "DROP EVENT IF EXISTS {};\n",
                        quote_ident(driver, ev)
                    ));
                }
                chunk.push_str(&mysql_delimited(def));
                chunk.push('\n');
            }
            write_chunk(&writer, counter, &chunk)?;
        }
    }

    // ---- 末尾 ----
    if !seq_setvals.is_empty() {
        let mut chunk = String::new();
        for s in &seq_setvals {
            chunk.push_str(s);
            chunk.push('\n');
        }
        write_chunk(&writer, counter, &chunk)?;
    }
    if driver == DriverKind::Mysql {
        write_chunk(&writer, counter, mysql_footer())?;
    }
    {
        use std::io::Write;
        let mut w = writer
            .lock()
            .map_err(|_| AppError::Other("dump writer lock poisoned".into()))?;
        w.flush()?;
    }
    Ok(counter.load(Ordering::SeqCst))
}

/// 1 表の行を `execute_stream` で読み、`INSERT` に変換しながら書き出す。
#[allow(clippy::too_many_arguments)]
async fn stream_table_rows(
    conn: &Connection,
    driver: DriverKind,
    schema: &str,
    table: &str,
    columns: &[String],
    extended: bool,
    mask_spec: Option<&crate::db::masking::MaskSpec>,
    writer: &Arc<std::sync::Mutex<std::io::BufWriter<std::fs::File>>>,
    counter: &Arc<AtomicU64>,
    progress: &ProgressFn,
    tables_done: u64,
    total_tables: u64,
) -> Result<()> {
    let select_list: Vec<String> = columns.iter().map(|c| quote_ident(driver, c)).collect();
    let select_sql = format!(
        "SELECT {} FROM {}",
        select_list.join(", "),
        match driver {
            // SELECT は常に修飾して、接続の既定 DB / search_path に依存しない。
            DriverKind::Mysql => format!(
                "{}.{}",
                quote_ident(driver, schema),
                quote_ident(driver, table)
            ),
            _ => qualified_table(driver, schema, table),
        }
    );
    let prefix = insert_prefix(driver, schema, table, columns);
    let writer_cb = writer.clone();
    let counter_cb = counter.clone();
    let progress_cb = progress.clone();
    let mask_spec = mask_spec.cloned();
    let mut plan: Option<MaskPlan> = None;
    let mut last_bytes = counter.load(Ordering::SeqCst);
    let mut last_at = std::time::Instant::now();
    conn.execute_stream(
        &select_sql,
        None,
        DUMP_STREAM_BATCH,
        DUMP_STREAM_BATCH,
        move |batch| {
            match batch {
                StreamBatch::Columns(cols) => {
                    plan = mask_spec.as_ref().map(|s| s.plan(&cols));
                }
                StreamBatch::Rows(rows) => {
                    let masked;
                    let rows_ref: &[Vec<Value>] = match &plan {
                        Some(p) => {
                            masked = p.apply_rows(&rows);
                            &masked
                        }
                        None => &rows,
                    };
                    let buf = render_row_batch(driver, &prefix, rows_ref, extended);
                    write_chunk_off_worker(&writer_cb, &counter_cb, &buf)?;
                    let bytes = counter_cb.load(Ordering::SeqCst);
                    if bytes.saturating_sub(last_bytes) >= DUMP_PROGRESS_BYTES
                        || last_at.elapsed() >= DUMP_PROGRESS_INTERVAL
                    {
                        last_bytes = bytes;
                        last_at = std::time::Instant::now();
                        progress_cb(bytes, tables_done, total_tables);
                    }
                }
            }
            Ok(())
        },
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fk(table: &str, to: &str) -> ForeignKey {
        ForeignKey {
            table: table.into(),
            column: "x".into(),
            referenced_table: to.into(),
            referenced_column: None,
            constraint_name: None,
            on_delete: None,
            on_update: None,
        }
    }

    fn s(v: &str) -> Value {
        Value::String(v.into())
    }

    #[test]
    fn qualified_table_follows_driver() {
        assert_eq!(qualified_table(DriverKind::Mysql, "d", "t`x"), "`t``x`");
        assert_eq!(
            qualified_table(DriverKind::Postgres, "s\"1", "T"),
            "\"s\"\"1\".\"T\""
        );
    }

    #[test]
    fn insert_prefix_quotes_columns() {
        let p = insert_prefix(DriverKind::Mysql, "d", "t", &["id".into(), "we`ird".into()]);
        assert_eq!(p, "INSERT INTO `t` (`id`, `we``ird`)");
        let p = insert_prefix(DriverKind::Postgres, "public", "t", &["Id".into()]);
        assert_eq!(p, "INSERT INTO \"public\".\"t\" (\"Id\")");
    }

    #[test]
    fn row_tuple_renders_every_value_kind_for_mysql() {
        let row = vec![
            Value::Null,
            Value::Int(i64::MIN),
            Value::UInt(u64::MAX),
            Value::Float(1.5),
            Value::Bool(true),
            s("it's a \\ back\nslash"),
            Value::Bytes("00ff".into()),
        ];
        assert_eq!(
            row_tuple(DriverKind::Mysql, &row),
            "(NULL, -9223372036854775808, 18446744073709551615, 1.5, 1, \
             'it''s a \\\\ back\nslash', X'00ff')"
        );
    }

    #[test]
    fn row_tuple_renders_postgres_dialect() {
        let row = vec![
            Value::Bool(false),
            s("a\\b'c"),
            Value::Bytes("dead".into()),
            Value::Float(f64::NAN),
        ];
        assert_eq!(
            row_tuple(DriverKind::Postgres, &row),
            "(FALSE, 'a\\b''c', '\\xdead', 'NaN')"
        );
    }

    #[test]
    fn render_non_extended_emits_one_statement_per_row() {
        let rows = vec![vec![Value::Int(1)], vec![Value::Int(2)]];
        let out = render_row_batch(DriverKind::Mysql, "INSERT INTO `t` (`a`)", &rows, false);
        assert_eq!(
            out,
            "INSERT INTO `t` (`a`) VALUES (1);\nINSERT INTO `t` (`a`) VALUES (2);\n"
        );
    }

    #[test]
    fn render_extended_groups_rows_into_one_statement() {
        let rows = vec![vec![Value::Int(1)], vec![Value::Int(2)]];
        let out = render_row_batch(DriverKind::Mysql, "INSERT INTO `t` (`a`)", &rows, true);
        assert_eq!(out, "INSERT INTO `t` (`a`) VALUES (1),(2);\n");
        assert_eq!(
            render_row_batch(DriverKind::Mysql, "INSERT INTO `t` (`a`)", &[], true),
            ""
        );
    }

    #[test]
    fn render_extended_splits_statements_at_size_limit() {
        let big = "x".repeat(MAX_EXTENDED_STMT_BYTES / 2 + 10);
        let rows = vec![vec![s(&big)], vec![s(&big)], vec![s(&big)]];
        let out = render_row_batch(DriverKind::Postgres, "INSERT INTO t (a)", &rows, true);
        // 1 文に 2 行は収まらない → 3 文に分かれ、各文は `;` で終わる。
        assert_eq!(out.matches("INSERT INTO t (a) VALUES ").count(), 3);
        assert_eq!(out.matches(";\n").count(), 3);
        assert!(out.ends_with(";\n"));
    }

    #[test]
    fn order_tables_puts_parents_first_and_ignores_self_reference() {
        let tables: Vec<String> = ["c", "a", "b"].iter().map(|s| s.to_string()).collect();
        let fks = vec![fk("a", "b"), fk("b", "c"), fk("c", "c")];
        let (ordered, cyclic) = order_tables_by_fk(&tables, &fks);
        assert_eq!(ordered, vec!["c", "b", "a"]);
        assert!(!cyclic);
    }

    #[test]
    fn order_tables_ignores_references_outside_the_set_and_sorts_ties() {
        let tables: Vec<String> = ["z", "m", "a"].iter().map(|s| s.to_string()).collect();
        let fks = vec![fk("m", "other_schema_table")];
        let (ordered, cyclic) = order_tables_by_fk(&tables, &fks);
        assert_eq!(ordered, vec!["a", "m", "z"]);
        assert!(!cyclic);
    }

    #[test]
    fn order_tables_reports_cycles_and_keeps_every_table() {
        let tables: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let fks = vec![fk("a", "b"), fk("b", "a")];
        let (ordered, cyclic) = order_tables_by_fk(&tables, &fks);
        assert!(cyclic);
        assert_eq!(ordered.len(), 3);
        assert_eq!(ordered[0], "c");
    }

    #[test]
    fn headers_match_dialect() {
        assert!(mysql_header().contains("FOREIGN_KEY_CHECKS=0"));
        assert!(mysql_header().contains("NO_AUTO_VALUE_ON_ZERO"));
        assert!(mysql_footer().contains("SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS"));
        let h = postgres_header("public");
        assert!(h.contains("standard_conforming_strings = on"));
        assert!(!h.contains("CREATE SCHEMA"));
        assert!(h.contains("SET search_path TO \"public\", public;"));
        let h = postgres_header("my\"s");
        assert!(h.contains("CREATE SCHEMA IF NOT EXISTS \"my\"\"s\";"));
    }

    #[test]
    fn delimited_and_terminated_statements() {
        assert_eq!(
            mysql_delimited("CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET a=1;"),
            "DELIMITER ;;\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET a=1 ;;\nDELIMITER ;\n"
        );
        assert_eq!(
            terminated("CREATE VIEW v AS SELECT 1"),
            "CREATE VIEW v AS SELECT 1;\n"
        );
        assert_eq!(
            terminated("CREATE VIEW v AS SELECT 1;\n"),
            "CREATE VIEW v AS SELECT 1;\n"
        );
    }

    #[test]
    fn pg_sequences_sql_escapes_schema_literal() {
        let sql = pg_sequences_sql("we'ird");
        assert!(sql.contains("s.schemaname = 'we''ird'"));
        assert!(sql.contains("<> 'i'"));
    }

    #[test]
    fn pg_column_types_sql_escapes_literals() {
        let sql = pg_column_types_sql("s'1", "t'x");
        assert!(sql.contains("n.nspname = 's''1'") && sql.contains("c.relname = 't''x'"));
    }

    #[test]
    fn resolve_schema_rules() {
        let mut o = DumpOptions::default();
        assert_eq!(
            resolve_schema(DriverKind::Mysql, " db ", false, &o).unwrap_or(""),
            "db"
        );
        assert_eq!(
            resolve_schema(DriverKind::Postgres, "tree", false, &o).unwrap_or(""),
            "tree"
        );
        assert_eq!(
            resolve_schema(DriverKind::Postgres, "conn_db", true, &o).unwrap_or(""),
            "public"
        );
        o.pg_schema = Some(" s2 ".into());
        assert_eq!(
            resolve_schema(DriverKind::Postgres, "conn_db", true, &o).unwrap_or(""),
            "s2"
        );
        assert!(resolve_schema(DriverKind::Mysql, "", false, &o).is_err());
        assert!(resolve_schema(DriverKind::Mysql, "-x", false, &o).is_err());
    }
}
