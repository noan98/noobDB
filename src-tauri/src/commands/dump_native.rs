//! MySQL / PostgreSQL のネイティブ SQL ダンプ (#2033)。
//!
//! 外部バイナリ (`mysqldump` / `pg_dump`) に頼らず、接続経由で SQL ダンプを生成する。
//! SQLite の `dump_sqlite` と同じ構造で、
//!
//! - DDL は `Connection::object_definition` (MySQL の表・ビュー・ルーチン・トリガー、PostgreSQL の
//!   ビュー・関数) と、PostgreSQL の表は共有の `table_ddl` 再構成を使い、
//! - 行データは `Connection::execute_stream` で 1 バッチずつ `INSERT` に変換して書き出す
//!   (全行をメモリへ載せない)。
//! - リテラル / 識別子クォートは SQL エクスポートと共通の `db::data_diff::sql_literal` /
//!   `db::sync::quote_ident` を使う (64bit 整数・バイナリ・NULL・特殊文字の扱いを共有)。
//!
//! 書き込み先 (一時ファイル → rename・gzip・整形・チェックサム) は `dump::run_dump` が
//! 面倒を見るので、ここは開いたファイルへ書くだけ (新しい書き込み経路は増やさない)。
//!
//! 出力の並び:
//! - MySQL: 表 (DDL → 行) → ルーチン → ビュー (依存順) → トリガー → イベント。
//!   `TIME_ZONE='+00:00'` に固定し、TIMESTAMP 列は読み出し時に UTC へ変換する (mysqldump と同じ)。
//! - PostgreSQL: 拡張 → enum / domain → (add_drop_table なら) 既存の DROP → シーケンス → 関数
//!   (`check_function_bodies = false`) → 表 (DDL → 行) → 外部キー (`ALTER TABLE ... ADD CONSTRAINT`)
//!   → ビュー (依存順) → トリガー → `setval`。外部キーを後付けにするので自己参照・循環も復元できる。
//!   行は `FROM ONLY` で読み、bytea・整数・浮動小数・真偽値・文字列以外は `::text` で取って
//!   文字列リテラルにする (range / point / tsvector / timetz / infinity など、クライアントの
//!   バイナリデコードが対応しない型でも壊れない)。
//!
//! 既知の制約 (外部ツール経路との差):
//! - `single_transaction` は効かない (接続プールの別接続で表ごとに読むため、表をまたぐ
//!   一貫したスナップショットにはならない)。
//! - PostgreSQL は 1 スキーマ単位 (`pg_schema`、無ければツリーのスキーマ、タスク経路では
//!   `public`)。所有者・権限・COMMENT は出さない。identity 列のシーケンスオプション(開始値・
//!   増分)は既定値に戻る(現在値は `setval` で引き継ぐ)。パーティション親は未対応で明示エラー、
//!   継承・パーティションの子は継承関係なしの通常表として書き (警告コメント付き)、複合型・range 型の
//!   定義は出さず警告コメントにする。
//! - MySQL のビュー定義は `SHOW CREATE VIEW` のままなので、元と別名の DB へ復元すると
//!   DB 名修飾が残る。ルーチン・トリガー・イベントは `DELIMITER ;;` 書式 (mysqldump と同じ) なので、
//!   復元は `mysql` クライアント前提 (アプリ内のスクリプトランナーは `DELIMITER` 非対応)。

use std::collections::HashSet;
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
use crate::db::types::{SchemaObject, StreamBatch, Value};
use crate::db::{Connection, DriverKind};
use crate::error::{AppError, Result};

/// 複数行 `INSERT` 1 文の上限バイト数。巨大な 1 文はサーバの `max_allowed_packet` に
/// 当たるので、これを超える前に文を区切る (mysqldump の `--net-buffer-length` 相当)。
const MAX_EXTENDED_STMT_BYTES: usize = 1024 * 1024;

/// 進捗コールバック: (書き出しバイト数, 処理済みテーブル数, テーブル総数)。
pub type ProgressFn = Arc<dyn Fn(u64, u64, u64) + Send + Sync>;

type Writer = Arc<std::sync::Mutex<std::io::BufWriter<std::fs::File>>>;

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

/// `INSERT INTO <表> (<列>, ...)` まで (`VALUES` は含めない)。`overriding` は PostgreSQL の
/// `GENERATED ALWAYS AS IDENTITY` 列へ値を入れるための `OVERRIDING SYSTEM VALUE`。
pub(crate) fn insert_prefix(
    driver: DriverKind,
    schema: &str,
    table: &str,
    columns: &[String],
    overriding: bool,
) -> String {
    let cols: Vec<String> = columns.iter().map(|c| quote_ident(driver, c)).collect();
    format!(
        "INSERT INTO {} ({}){}",
        qualified_table(driver, schema, table),
        cols.join(", "),
        if overriding {
            " OVERRIDING SYSTEM VALUE"
        } else {
            ""
        }
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

/// 依存 (`edges` = (依存する側, 依存される側)) の親→子の順に並べる。ビューの作成順に使う。
/// 同順位は名前順。自己参照・集合外への依存は無視し、循環があれば残りを名前順で末尾に付けて
/// `true` を返す。
pub(crate) fn order_by_deps(names: &[String], edges: &[(String, String)]) -> (Vec<String>, bool) {
    let mut remaining: Vec<String> = names.to_vec();
    remaining.sort();
    remaining.dedup();
    let set: HashSet<String> = remaining.iter().cloned().collect();
    let deps_of = |t: &str| -> Vec<&str> {
        edges
            .iter()
            .filter(|(c, p)| c == t && p != t && set.contains(p))
            .map(|(_, p)| p.as_str())
            .collect()
    };
    let mut out: Vec<String> = Vec::with_capacity(remaining.len());
    let mut done: HashSet<String> = HashSet::new();
    loop {
        let ready: Vec<usize> = remaining
            .iter()
            .enumerate()
            .filter(|(_, t)| deps_of(t).iter().all(|d| done.contains(*d)))
            .map(|(i, _)| i)
            .collect();
        if ready.is_empty() {
            break;
        }
        let moved: Vec<String> = ready.iter().map(|&i| remaining[i].clone()).collect();
        for &i in ready.iter().rev() {
            remaining.remove(i);
        }
        done.extend(moved.iter().cloned());
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
/// `TIME_ZONE` は mysqldump と同じ `+00:00` に固定する (TIMESTAMP は読み出し時に UTC へ
/// 変換して書くので、どのタイムゾーンのセッションで復元してもずれない)。
pub(crate) fn mysql_header() -> &'static str {
    "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n\
     /*!40101 SET NAMES utf8mb4 */;\n\
     /*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;\n\
     /*!40103 SET TIME_ZONE='+00:00' */;\n\
     /*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n\
     /*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n\
     /*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\n"
}

pub(crate) fn mysql_footer() -> &'static str {
    "\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n\
     /*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n\
     /*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n\
     /*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n\
     /*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n"
}

/// PostgreSQL の先頭。`standard_conforming_strings = on` は `'\x..'` (bytea) と
/// バックスラッシュ非エスケープのリテラルが正しく読まれるための前提。
/// `check_function_bodies = false` は、表より前に出す関数の本体検証を遅らせる。
pub(crate) fn postgres_header(schema: &str) -> String {
    let q = quote_ident(DriverKind::Postgres, schema);
    let mut out = String::from(
        "SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nSET check_function_bodies = false;\n",
    );
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

/// SELECT 式 (MySQL)。TIMESTAMP 列だけ、セッションのタイムゾーンから UTC へ変換して読む
/// (ヘッダの `TIME_ZONE='+00:00'` と組で、復元先のタイムゾーンに依らず同じ時刻になる)。
/// ゼロ日付はそのまま。
pub(crate) fn mysql_select_expr(col: &str, data_type: &str) -> String {
    let q = quote_ident(DriverKind::Mysql, col);
    if data_type
        .trim()
        .to_ascii_lowercase()
        .starts_with("timestamp")
    {
        format!(
            "IF(UNIX_TIMESTAMP({q}) = 0, {q}, CONVERT_TZ({q}, @@session.time_zone, '+00:00')) AS {q}"
        )
    } else {
        q
    }
}

/// SELECT 式 (PostgreSQL)。クライアントのバイナリデコードが確実な型 (整数・double・真偽値・
/// 文字列・bytea) 以外は `::text` で取る。range / point / tsvector / timetz / `infinity` の
/// 日時・numeric、enum、配列、複合型、拡張の型などをそのまま読むと壊れるため。
pub(crate) fn pg_select_expr(col: &str, format_type: &str) -> String {
    let q = quote_ident(DriverKind::Postgres, col);
    let t = format_type.trim().to_ascii_lowercase();
    let plain = matches!(
        t.as_str(),
        "smallint" | "integer" | "bigint" | "double precision" | "boolean" | "text" | "bytea"
    ) || t == "character"
        || t.starts_with("character(")
        || t.starts_with("character varying");
    if plain {
        q
    } else {
        format!("{q}::text AS {q}")
    }
}

fn pg_lit(s: &str) -> String {
    sql_literal(DriverKind::Postgres, &Value::String(s.to_string()))
}

/// PostgreSQL のシーケンス一覧を引く SQL。列は
/// (CREATE 文, 所有テーブル名 or NULL, `ALTER SEQUENCE ... OWNED BY` or NULL, `setval` or NULL, 名前)。
/// 生成列 (identity) が所有するシーケンスは `CREATE TABLE` 側で扱えないので除く。
pub(crate) fn pg_sequences_sql(schema: &str) -> String {
    let lit = pg_lit(schema);
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
                            quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename), s.last_value) END AS setval_stmt, \
           s.sequencename::text AS name \
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
    let (s, t) = (pg_lit(schema), pg_lit(table));
    format!(
        "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod) \
           FROM pg_attribute a \
           JOIN pg_class c ON c.oid = a.attrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = {s} AND c.relname = {t} AND a.attnum > 0 AND NOT a.attisdropped \
          ORDER BY a.attnum"
    )
}

/// identity 列 (`GENERATED ... AS IDENTITY`) を引く SQL。列は (列名, 'a' = ALWAYS / 'd' = BY DEFAULT,
/// 採番の現在値 or NULL)。
pub(crate) fn pg_identity_sql(schema: &str, table: &str) -> String {
    let (s, t) = (pg_lit(schema), pg_lit(table));
    format!(
        "SELECT a.attname::text, a.attidentity::text, \
                pg_catalog.pg_sequence_last_value(pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname)::regclass)::text \
           FROM pg_attribute a \
           JOIN pg_class c ON c.oid = a.attrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = {s} AND c.relname = {t} AND a.attnum > 0 AND NOT a.attisdropped \
            AND a.attidentity <> '' \
          ORDER BY a.attnum"
    )
}

/// 表の種別を引く SQL。列は (表名, relkind, パーティションの子か, 継承の子か)。
pub(crate) fn pg_table_kinds_sql(schema: &str) -> String {
    let s = pg_lit(schema);
    format!(
        "SELECT c.relname::text, c.relkind::text, c.relispartition::text, \
                EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)::text \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = {s} AND c.relkind IN ('r', 'p') ORDER BY c.relname"
    )
}

/// enum / domain の作成文と、出せない型の一覧を引く SQL。列は (種別, 文 or 型名)。
/// 種別は `enum` / `domain` / `unsupported`。重複しても失敗しないよう `DO` ブロックで包む。
/// 拡張が持つ型は除く (拡張の `CREATE EXTENSION` が作る)。
pub(crate) fn pg_types_sql(schema: &str) -> String {
    let s = pg_lit(schema);
    let not_ext =
        "NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')";
    format!(
        "SELECT kind, stmt FROM ( \
           SELECT 1 AS ord, t.oid AS oid, 'enum' AS kind, \
                  format('DO $$ BEGIN CREATE TYPE %I.%I AS ENUM (%s); EXCEPTION WHEN duplicate_object THEN NULL; END $$;', \
                         n.nspname, t.typname, \
                         (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) \
                            FROM pg_enum e WHERE e.enumtypid = t.oid)) AS stmt \
             FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
            WHERE n.nspname = {s} AND t.typtype = 'e' AND {not_ext} \
           UNION ALL \
           SELECT 2, t.oid, 'domain', \
                  format('DO $$ BEGIN CREATE DOMAIN %I.%I AS %s%s%s%s; EXCEPTION WHEN duplicate_object THEN NULL; END $$;', \
                         n.nspname, t.typname, pg_catalog.format_type(t.typbasetype, t.typtypmod), \
                         CASE WHEN t.typdefault IS NULL THEN '' ELSE ' DEFAULT ' || t.typdefault END, \
                         CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END, \
                         COALESCE((SELECT string_agg(' CONSTRAINT ' || quote_ident(k.conname) || ' ' || pg_get_constraintdef(k.oid), '' ORDER BY k.conname) \
                                     FROM pg_constraint k WHERE k.contypid = t.oid), '')) \
             FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
            WHERE n.nspname = {s} AND t.typtype = 'd' AND {not_ext} \
           UNION ALL \
           SELECT 3, t.oid, 'unsupported', \
                  quote_ident(n.nspname) || '.' || quote_ident(t.typname) || ' (' \
                  || CASE t.typtype WHEN 'r' THEN 'range' ELSE 'composite' END || ' type)' \
             FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
            WHERE n.nspname = {s} AND {not_ext} \
              AND (t.typtype = 'r' \
                   OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))) \
         ) x ORDER BY ord, oid"
    )
}

/// スキーマにある拡張 (plpgsql 以外) の名前を引く SQL。
pub(crate) fn pg_extensions_sql(schema: &str) -> String {
    let s = pg_lit(schema);
    format!(
        "SELECT e.extname::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace \
          WHERE n.nspname = {s} AND e.extname <> 'plpgsql' ORDER BY e.extname"
    )
}

/// ダンプしない関数の oid (拡張が持つもの・集約関数) を引く SQL。
pub(crate) fn pg_skip_functions_sql(schema: &str) -> String {
    let s = pg_lit(schema);
    format!(
        "SELECT p.oid::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
          WHERE n.nspname = {s} AND (p.prokind = 'a' OR EXISTS ( \
                SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'))"
    )
}

/// トリガー関数の oid と、そのトリガーを持つ表を引く SQL。列は (関数 oid, 表名)。
pub(crate) fn pg_trigger_functions_sql(schema: &str) -> String {
    let s = pg_lit(schema);
    format!(
        "SELECT DISTINCT t.tgfoid::text, c.relname::text FROM pg_trigger t \
           JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = {s} AND NOT t.tgisinternal"
    )
}

/// 外部キーを後付けする `ALTER TABLE` を引く SQL。列は (表名, 参照先スキーマ, 参照先表, 文)。
/// 定義本文は `pg_get_constraintdef` (複合キー・ON DELETE/UPDATE・DEFERRABLE を含む)。
pub(crate) fn pg_foreign_keys_sql(schema: &str) -> String {
    let s = pg_lit(schema);
    format!(
        "SELECT c.relname::text, rn.nspname::text, rc.relname::text, \
                format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s;', n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid)) \
           FROM pg_constraint k \
           JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
           JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace \
          WHERE k.contype = 'f' AND n.nspname = {s} ORDER BY c.relname, k.conname"
    )
}

/// ビュー間の依存を引く SQL。列は (ビュー, 依存先のビュー / マテビュー)。
pub(crate) fn pg_view_deps_sql(schema: &str) -> String {
    let s = pg_lit(schema);
    format!(
        "SELECT DISTINCT v.relname::text, t.relname::text FROM pg_depend d \
           JOIN pg_rewrite r ON r.oid = d.objid \
           JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace n ON n.oid = v.relnamespace \
           JOIN pg_class t ON t.oid = d.refobjid \
          WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass \
            AND d.deptype = 'n' AND v.oid <> t.oid AND t.relkind IN ('v', 'm') AND n.nspname = {s}"
    )
}

/// MySQL のビュー間の依存を引く SQL (8.0.13+ の `VIEW_TABLE_USAGE`)。列は (ビュー, 参照先)。
pub(crate) fn mysql_view_deps_sql(schema: &str) -> String {
    let s = sql_literal(DriverKind::Mysql, &Value::String(schema.to_string()));
    format!(
        "SELECT VIEW_NAME, TABLE_NAME FROM information_schema.VIEW_TABLE_USAGE \
          WHERE VIEW_SCHEMA = {s} AND TABLE_SCHEMA = {s}"
    )
}

fn str_at(row: &[Value], i: usize) -> Option<&str> {
    match row.get(i) {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// 文字列として読む。MySQL の `information_schema` は列によって 16 進の `Bytes` で返ることが
/// あるので、UTF-8 として復号する。
fn text_at(row: &[Value], i: usize) -> Option<String> {
    match row.get(i) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Bytes(h)) => {
            let h = h.strip_prefix("0x").unwrap_or(h);
            let bytes: Option<Vec<u8>> = (0..h.len() / 2)
                .map(|k| u8::from_str_radix(h.get(2 * k..2 * k + 2)?, 16).ok())
                .collect();
            String::from_utf8(bytes?).ok()
        }
        _ => None,
    }
}

/// 行 → 文字列の組 (2 列)。NULL や非文字列の行は読み飛ばす。
fn pairs(rows: &[Vec<Value>]) -> Vec<(String, String)> {
    rows.iter()
        .filter_map(|r| Some((text_at(r, 0)?, text_at(r, 1)?)))
        .collect()
}

/// PostgreSQL の identity 列。
struct IdentityCol {
    column: String,
    always: bool,
    last_value: Option<String>,
}

/// PostgreSQL の `CREATE TABLE`。共有の再構成ロジック (`table_ddl`) に、`format_type` で
/// 引き直した正確な列の型を渡して作る。外部キーは埋め込まず (後でまとめて `ALTER TABLE`)、
/// identity 列は `ALTER TABLE ... ADD GENERATED ... AS IDENTITY` を続ける。
async fn postgres_table_ddl(
    conn: &Connection,
    schema: &str,
    table: &str,
    types: &[(String, String)],
    identity: &[IdentityCol],
) -> Result<String> {
    let mut columns = conn.columns(schema, table).await?;
    if columns.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "no definition found for table '{table}'"
        )));
    }
    for col in &mut columns {
        if let Some((_, t)) = types.iter().find(|(n, _)| *n == col.name) {
            col.data_type = t.clone();
        }
    }
    let indexes = conn.list_indexes(schema, table).await?;
    // 外部キーは別途 (データ投入後に) 付ける。
    let extras = conn.table_ddl_extras(schema, table).await?;
    let mut ddl = crate::db::table_ddl::synthesize_create_table(
        DriverKind::Postgres,
        Some(schema),
        table,
        &columns,
        &indexes,
        &[],
        &extras,
    );
    for id in identity {
        ddl.push_str(&format!(
            "ALTER TABLE {} ALTER COLUMN {} ADD GENERATED {} AS IDENTITY;\n",
            qualified_table(DriverKind::Postgres, schema, table),
            quote_ident(DriverKind::Postgres, &id.column),
            if id.always { "ALWAYS" } else { "BY DEFAULT" }
        ));
    }
    Ok(ddl)
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
    let pg = driver == DriverKind::Postgres;
    let schema = resolve_schema(driver, database, database_is_connection_db, options)?.to_string();
    let selected = selected_tables(options)?;
    // マスキングはソルトの取得 (keyring) を伴うので、書き込み開始前に検証して fail closed。
    let mask_spec = load_mask_spec(options.masks.clone()).await?;

    let all_names = conn.tables(&schema).await?;
    let objects = conn.schema_objects(&schema).await?;
    let view_names: HashSet<&str> = objects
        .iter()
        .filter(|o| o.kind == "view" || o.kind == "materialized_view")
        .map(|o| o.name.as_str())
        .collect();
    if let Some(sel) = &selected {
        ensure_tables_exist(sel, all_names.iter().map(String::as_str))?;
    }
    let in_scope = |n: &str| selected.as_ref().map_or(true, |s| s.iter().any(|x| x == n));
    let mut ordered_tables: Vec<String> = all_names
        .iter()
        .filter(|n| !view_names.contains(n.as_str()) && in_scope(n))
        .cloned()
        .collect();
    ordered_tables.sort();
    let views: Vec<&SchemaObject> = objects
        .iter()
        .filter(|o| (o.kind == "view" || o.kind == "materialized_view") && in_scope(&o.name))
        .collect();
    let whole_schema = selected.is_none();
    let schema_part = !options.no_create_info;

    // 表の種別 (PostgreSQL): パーティション親は未対応。継承・パーティションの子は警告を残す。
    let mut warnings: Vec<String> = Vec::new();
    if pg {
        let kinds = conn.execute(&pg_table_kinds_sql(&schema), None).await?;
        for r in &kinds.rows {
            let Some(name) = str_at(r, 0).filter(|n| in_scope(n)) else {
                continue;
            };
            if str_at(r, 1) == Some("p") {
                return Err(AppError::InvalidInput(format!(
                    "partitioned table '{name}' is not supported by the native dump; use pg_dump"
                )));
            }
            if str_at(r, 2) == Some("true") {
                warnings.push(format!(
                    "table {name} is a partition; dumped as a plain table without its partition parent"
                ));
            } else if str_at(r, 3) == Some("true") {
                warnings.push(format!(
                    "table {name} inherits from another table; dumped without INHERITS"
                ));
            }
        }
    }

    // PostgreSQL の事前取得 (書き込み前に済ませ、失敗は書き始める前に返す)。
    let mut type_stmts: Vec<String> = Vec::new();
    let mut extension_stmts: Vec<String> = Vec::new();
    let mut seq_creates: Vec<String> = Vec::new();
    let mut seq_names: Vec<String> = Vec::new();
    let mut seq_owned_stmts: Vec<String> = Vec::new();
    let mut seq_setvals: Vec<String> = Vec::new();
    let mut fk_stmts: Vec<String> = Vec::new();
    let mut functions: Vec<&SchemaObject> = Vec::new();
    if pg && schema_part {
        for r in &conn.execute(&pg_types_sql(&schema), None).await?.rows {
            match (str_at(r, 0), str_at(r, 1)) {
                (Some("unsupported"), Some(t)) => {
                    warnings.push(format!(
                        "type {t} is not dumped; create it before restoring"
                    ));
                }
                (Some(_), Some(stmt)) => type_stmts.push(stmt.to_string()),
                _ => {}
            }
        }
        if whole_schema {
            for r in &conn.execute(&pg_extensions_sql(&schema), None).await?.rows {
                if let Some(e) = str_at(r, 0) {
                    extension_stmts.push(format!(
                        "CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};",
                        quote_ident(driver, e),
                        quote_ident(driver, &schema)
                    ));
                }
            }
        }
        let skip: HashSet<String> = conn
            .execute(&pg_skip_functions_sql(&schema), None)
            .await?
            .rows
            .iter()
            .filter_map(|r| str_at(r, 0).map(str::to_string))
            .collect();
        // トリガーを出すなら、そのトリガー関数は routines オフでも出す (無いと復元できない)。
        let trigger_fns: HashSet<String> = if options.triggers {
            pairs(
                &conn
                    .execute(&pg_trigger_functions_sql(&schema), None)
                    .await?
                    .rows,
            )
            .into_iter()
            .filter(|(_, t)| ordered_tables.contains(t))
            .map(|(f, _)| f)
            .collect()
        } else {
            HashSet::new()
        };
        functions = objects
            .iter()
            .filter(|o| o.kind == "function" || o.kind == "procedure")
            .filter(|o| o.id.as_ref().map_or(true, |id| !skip.contains(id)))
            .filter(|o| {
                (whole_schema && options.routines)
                    || o.id.as_ref().is_some_and(|id| trigger_fns.contains(id))
            })
            .collect();
        for r in &conn
            .execute(&pg_foreign_keys_sql(&schema), None)
            .await?
            .rows
        {
            let (Some(tbl), Some(ref_schema), Some(ref_tbl), Some(stmt)) =
                (str_at(r, 0), str_at(r, 1), str_at(r, 2), str_at(r, 3))
            else {
                continue;
            };
            let target_ok = if ref_schema == schema {
                ordered_tables.iter().any(|t| t == ref_tbl)
            } else {
                whole_schema
            };
            if ordered_tables.iter().any(|t| t == tbl) && target_ok {
                fk_stmts.push(stmt.to_string());
            }
        }
    }
    if pg {
        for r in &conn.execute(&pg_sequences_sql(&schema), None).await?.rows {
            let owner = str_at(r, 1);
            // テーブル指定時は、指定テーブルが所有するか、誰も所有しないものだけ。
            if let Some(o) = owner {
                if !ordered_tables.iter().any(|t| t == o) {
                    continue;
                }
            } else if !whole_schema {
                continue;
            }
            if schema_part {
                if let Some(c) = str_at(r, 0) {
                    seq_creates.push(c.to_string());
                }
                if let Some(o) = str_at(r, 2) {
                    seq_owned_stmts.push(o.to_string());
                }
                if let Some(n) = str_at(r, 4) {
                    seq_names.push(n.to_string());
                }
            }
            if !options.no_data {
                if let Some(s) = str_at(r, 3) {
                    seq_setvals.push(s.to_string());
                }
            }
        }
    }

    // ビューの作成順 (依存先が先)。
    let ordered_views: Vec<&SchemaObject> = if views.len() > 1 {
        let edges = if pg {
            pairs(&conn.execute(&pg_view_deps_sql(&schema), None).await?.rows)
        } else {
            // 8.0.13 未満など使えないときは名前順のまま。
            match conn.execute(&mysql_view_deps_sql(&schema), None).await {
                Ok(r) => pairs(&r.rows),
                Err(e) => {
                    tracing::warn!(error = %e, "view dependency lookup failed; using name order");
                    Vec::new()
                }
            }
        };
        let names: Vec<String> = views.iter().map(|v| v.name.clone()).collect();
        order_by_deps(&names, &edges)
            .0
            .iter()
            .filter_map(|n| views.iter().find(|v| &v.name == n).copied())
            .collect()
    } else {
        views.clone()
    };

    let writer: Writer = Arc::new(std::sync::Mutex::new(std::io::BufWriter::new(file)));
    let total_tables = ordered_tables.len() as u64;

    // ---- 先頭 ----
    match driver {
        DriverKind::Mysql => write_chunk(&writer, counter, mysql_header())?,
        _ => write_chunk(&writer, counter, &postgres_header(&schema))?,
    }
    if !warnings.is_empty() {
        let w: String = warnings
            .iter()
            .map(|w| format!("-- WARNING: {w}\n"))
            .collect();
        write_chunk(&writer, counter, &format!("{w}\n"))?;
    }
    if pg && schema_part {
        let mut chunk = String::new();
        for s in extension_stmts.iter().chain(type_stmts.iter()) {
            chunk.push_str(s);
            chunk.push('\n');
        }
        // 既存の DB へ復元しても失敗しないよう、作り直す対象を先にまとめて消す。表の
        // `DROP ... CASCADE` は所有シーケンスも道連れに消すので、シーケンス作成より前に置く。
        if options.add_drop_table {
            // 依存するビューが先 (作成順の逆)。
            for v in ordered_views.iter().rev() {
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
            for t in &ordered_tables {
                chunk.push_str(&format!(
                    "DROP TABLE IF EXISTS {} CASCADE;\n",
                    qualified_table(driver, &schema, t)
                ));
            }
            for n in &seq_names {
                chunk.push_str(&format!(
                    "DROP SEQUENCE IF EXISTS {};\n",
                    qualified_table(driver, &schema, n)
                ));
            }
        }
        for c in &seq_creates {
            chunk.push_str(c);
            chunk.push('\n');
        }
        for o in &functions {
            let def = conn
                .object_definition(&schema, &o.kind, &o.name, o.id.as_deref())
                .await?;
            chunk.push_str(&terminated(&def));
            chunk.push('\n');
        }
        write_chunk(&writer, counter, &chunk)?;
    }

    // ---- 表: DDL → 行データ ----
    let mut identity_setvals: Vec<String> = Vec::new();
    let mut processed = 0u64;
    for name in &ordered_tables {
        let pg_types: Vec<(String, String)> = if pg {
            pairs(
                &conn
                    .execute(&pg_column_types_sql(&schema, name), None)
                    .await?
                    .rows,
            )
        } else {
            Vec::new()
        };
        let identity: Vec<IdentityCol> = if pg {
            conn.execute(&pg_identity_sql(&schema, name), None)
                .await?
                .rows
                .iter()
                .filter_map(|r| {
                    Some(IdentityCol {
                        column: str_at(r, 0)?.to_string(),
                        always: str_at(r, 1)? == "a",
                        last_value: str_at(r, 2).map(str::to_string),
                    })
                })
                .collect()
        } else {
            Vec::new()
        };

        let mut chunk = String::new();
        if schema_part {
            if !pg && options.add_drop_table {
                chunk.push_str(&format!(
                    "DROP TABLE IF EXISTS {};\n",
                    qualified_table(driver, &schema, name)
                ));
            }
            let ddl = if pg {
                postgres_table_ddl(conn, &schema, name, &pg_types, &identity).await?
            } else {
                conn.object_definition(&schema, "table", name, None).await?
            };
            chunk.push_str(&terminated(&ddl));
            chunk.push('\n');
        }
        write_chunk(&writer, counter, &chunk)?;

        if !options.no_data {
            // 生成列は INSERT できないので外し、列を明示して SELECT / INSERT の対応を固定する。
            let generated: HashSet<String> = conn
                .generated_columns(Some(&schema), name)
                .await?
                .into_iter()
                .collect();
            let col_info = conn.columns(&schema, name).await?;
            let mut columns: Vec<String> = Vec::new();
            let mut exprs: Vec<String> = Vec::new();
            for c in col_info.iter().filter(|c| !generated.contains(&c.name)) {
                columns.push(c.name.clone());
                exprs.push(if pg {
                    let ty = pg_types
                        .iter()
                        .find(|(n, _)| *n == c.name)
                        .map_or(c.data_type.as_str(), |(_, t)| t.as_str());
                    pg_select_expr(&c.name, ty)
                } else {
                    mysql_select_expr(&c.name, &c.data_type)
                });
            }
            for id in &identity {
                if let Some(v) = &id.last_value {
                    identity_setvals.push(format!(
                        "SELECT pg_catalog.setval(pg_get_serial_sequence({}, {}), {v}, true);",
                        pg_lit(&qualified_table(driver, &schema, name)),
                        pg_lit(&id.column)
                    ));
                }
            }
            if !columns.is_empty() {
                let overriding = identity.iter().any(|i| i.always);
                stream_table_rows(
                    conn,
                    driver,
                    &schema,
                    name,
                    &columns,
                    &exprs,
                    overriding,
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
        progress(counter.load(Ordering::SeqCst), processed, total_tables);
    }

    // ---- 表の後 ----
    if schema_part {
        // PostgreSQL: シーケンスの所有、外部キー (データ投入後なので順序・循環に依らない)。
        if pg {
            let mut chunk = String::new();
            for s in seq_owned_stmts.iter().chain(fk_stmts.iter()) {
                chunk.push_str(s);
                chunk.push('\n');
            }
            if !chunk.is_empty() {
                chunk.push('\n');
            }
            write_chunk(&writer, counter, &chunk)?;
        }

        // MySQL: ルーチンはビューより前 (ビューが関数を呼ぶことがある)。
        if !pg && whole_schema && options.routines {
            let mut chunk = String::new();
            for o in objects
                .iter()
                .filter(|o| o.kind == "function" || o.kind == "procedure")
            {
                let def = conn
                    .object_definition(&schema, &o.kind, &o.name, o.id.as_deref())
                    .await?;
                if options.add_drop_table {
                    chunk.push_str(&format!(
                        "DROP {} IF EXISTS {};\n",
                        o.kind.to_uppercase(),
                        quote_ident(driver, &o.name)
                    ));
                }
                chunk.push_str(&mysql_delimited(&def));
                chunk.push('\n');
            }
            write_chunk(&writer, counter, &chunk)?;
        }

        let mut chunk = String::new();
        for v in &ordered_views {
            if !pg && options.add_drop_table {
                chunk.push_str(&format!(
                    "DROP VIEW IF EXISTS {};\n",
                    qualified_table(driver, &schema, &v.name)
                ));
            }
            let def = if pg {
                // PostgreSQL は表 DDL の入口がビューも振り分ける (完全な CREATE VIEW を返す)。
                conn.object_definition(&schema, "table", &v.name, None)
                    .await?
            } else {
                conn.object_definition(&schema, "view", &v.name, None)
                    .await?
            };
            chunk.push_str(&terminated(&def));
            chunk.push('\n');
        }
        write_chunk(&writer, counter, &chunk)?;

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
                    if !pg {
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

        if !pg && whole_schema && options.events {
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
    let setvals: Vec<&String> = seq_setvals.iter().chain(identity_setvals.iter()).collect();
    if !setvals.is_empty() {
        let mut chunk = String::new();
        for s in setvals {
            chunk.push_str(s);
            chunk.push('\n');
        }
        write_chunk(&writer, counter, &chunk)?;
    }
    if !pg {
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
    select_exprs: &[String],
    overriding: bool,
    extended: bool,
    mask_spec: Option<&crate::db::masking::MaskSpec>,
    writer: &Writer,
    counter: &Arc<AtomicU64>,
    progress: &ProgressFn,
    tables_done: u64,
    total_tables: u64,
) -> Result<()> {
    // SELECT は常に修飾して、接続の既定 DB / search_path に依存しない。PostgreSQL は
    // 継承・パーティションの子を二重に読まないよう `ONLY`。
    let from = match driver {
        DriverKind::Mysql => format!(
            "{}.{}",
            quote_ident(driver, schema),
            quote_ident(driver, table)
        ),
        _ => format!("ONLY {}", qualified_table(driver, schema, table)),
    };
    let select_sql = format!("SELECT {} FROM {from}", select_exprs.join(", "));
    let prefix = insert_prefix(driver, schema, table, columns, overriding);
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

    fn s(v: &str) -> Value {
        Value::String(v.into())
    }

    fn edge(c: &str, p: &str) -> (String, String) {
        (c.to_string(), p.to_string())
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
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
    fn insert_prefix_quotes_columns_and_overrides_identity() {
        let p = insert_prefix(
            DriverKind::Mysql,
            "d",
            "t",
            &["id".into(), "we`ird".into()],
            false,
        );
        assert_eq!(p, "INSERT INTO `t` (`id`, `we``ird`)");
        let p = insert_prefix(DriverKind::Postgres, "public", "t", &["Id".into()], true);
        assert_eq!(
            p,
            "INSERT INTO \"public\".\"t\" (\"Id\") OVERRIDING SYSTEM VALUE"
        );
    }

    #[test]
    fn row_tuple_renders_every_value_kind_for_mysql() {
        let row = vec![
            Value::Null,
            Value::Int(i64::MIN),
            Value::UInt(u64::MAX),
            Value::Float(1.5),
            Value::Bool(true),
            s("it's a \\ back\nslash\0\u{1a}"),
            Value::Bytes("00ff".into()),
        ];
        assert_eq!(
            row_tuple(DriverKind::Mysql, &row),
            "(NULL, -9223372036854775808, 18446744073709551615, 1.5, 1, \
             'it''s a \\\\ back\nslash\\0\\Z', X'00ff')"
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
        assert_eq!(out.matches("INSERT INTO t (a) VALUES ").count(), 3);
        assert_eq!(out.matches(";\n").count(), 3);
        assert!(out.ends_with(";\n"));
    }

    #[test]
    fn order_by_deps_puts_parents_first_and_ignores_self_reference() {
        let edges = vec![edge("a", "b"), edge("b", "c"), edge("c", "c")];
        let (ordered, cyclic) = order_by_deps(&names(&["c", "a", "b"]), &edges);
        assert_eq!(ordered, vec!["c", "b", "a"]);
        assert!(!cyclic);
    }

    #[test]
    fn order_by_deps_ignores_outside_references_and_sorts_ties() {
        let edges = vec![edge("m", "other")];
        let (ordered, cyclic) = order_by_deps(&names(&["z", "m", "a"]), &edges);
        assert_eq!(ordered, vec!["a", "m", "z"]);
        assert!(!cyclic);
    }

    #[test]
    fn order_by_deps_reports_cycles_and_keeps_every_name() {
        let edges = vec![edge("a", "b"), edge("b", "a")];
        let (ordered, cyclic) = order_by_deps(&names(&["a", "b", "c"]), &edges);
        assert!(cyclic);
        assert_eq!(ordered.len(), 3);
        assert_eq!(ordered[0], "c");
    }

    #[test]
    fn headers_match_dialect() {
        assert!(mysql_header().contains("FOREIGN_KEY_CHECKS=0"));
        assert!(mysql_header().contains("NO_AUTO_VALUE_ON_ZERO"));
        assert!(mysql_header().contains("SET TIME_ZONE='+00:00'"));
        assert!(mysql_footer().contains("SET TIME_ZONE=@OLD_TIME_ZONE"));
        assert!(mysql_footer().contains("SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS"));
        let h = postgres_header("public");
        assert!(h.contains("standard_conforming_strings = on"));
        assert!(h.contains("check_function_bodies = false"));
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
    fn select_exprs_convert_only_what_needs_it() {
        assert_eq!(mysql_select_expr("a", "int"), "`a`");
        let e = mysql_select_expr("t`s", "timestamp(3)");
        assert!(e.contains("CONVERT_TZ(`t``s`, @@session.time_zone, '+00:00')"));
        assert!(e.ends_with("AS `t``s`"));
        assert_eq!(mysql_select_expr("d", "datetime"), "`d`");
        for plain in [
            "integer",
            "bigint",
            "smallint",
            "boolean",
            "text",
            "bytea",
            "double precision",
            "character varying(20)",
            "character(3)",
        ] {
            assert_eq!(pg_select_expr("c", plain), "\"c\"", "{plain}");
        }
        for cast in [
            "numeric(20,4)",
            "int4range",
            "point",
            "tsvector",
            "time with time zone",
            "timestamp with time zone",
            "date",
            "text[]",
            "real",
            "mood",
            "jsonb",
        ] {
            assert_eq!(pg_select_expr("c", cast), "\"c\"::text AS \"c\"", "{cast}");
        }
    }

    #[test]
    fn pg_queries_escape_schema_literals() {
        assert!(pg_sequences_sql("we'ird").contains("s.schemaname = 'we''ird'"));
        assert!(pg_sequences_sql("x").contains("<> 'i'"));
        let sql = pg_column_types_sql("s'1", "t'x");
        assert!(sql.contains("n.nspname = 's''1'") && sql.contains("c.relname = 't''x'"));
        for q in [
            pg_identity_sql("s'", "t"),
            pg_table_kinds_sql("s'"),
            pg_types_sql("s'"),
            pg_extensions_sql("s'"),
            pg_skip_functions_sql("s'"),
            pg_trigger_functions_sql("s'"),
            pg_foreign_keys_sql("s'"),
            pg_view_deps_sql("s'"),
        ] {
            assert!(q.contains("'s'''"), "{q}");
        }
        assert!(mysql_view_deps_sql("d'b").contains("VIEW_SCHEMA = 'd''b'"));
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
