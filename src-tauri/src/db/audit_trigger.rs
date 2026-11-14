//! 変更履歴 (監査) テーブルと INSERT / UPDATE / DELETE トリガーの DDL 生成 (#2305)。純層で DB 無しでテストできる。
//!
//! 生成物は `<table>_audit` 表 (`audit_id` / `op` / `changed_at` / `changed_by` / `pk` / `old_row` /
//! `new_row`) と AFTER トリガー。3 ドライバで次のように作り分ける。
//!
//! - **PostgreSQL**: 汎用の plpgsql 関数 1 本 (`to_jsonb(OLD)` / `to_jsonb(NEW)`) とトリガー 1 本。
//!   列が増えても作り直し不要。
//! - **MySQL**: 操作ごとのトリガー 3 本。`JSON_OBJECT('col', NEW.col, ...)` を列明示で書く。
//! - **SQLite**: 操作ごとのトリガー 3 本。`json_object(...)` を列明示で書く。
//!
//! 列明示のトリガー (MySQL / SQLite) は本体に `/* noobdb-audit {json} */` の印を埋め、記録している
//! 列・オプションを後から読み戻せるようにしている (`audit_status` が現在の列と突き合わせて
//! 「再生成が必要」を判定する)。

use serde::{Deserialize, Serialize};

use super::sync::{quote_ident, sqlite_is_main, sqlite_table_ref};
use super::types::TableTrigger;
use super::DriverKind;
use crate::error::{AppError, Result};

const MARKER_PREFIX: &str = "/* noobdb-audit ";
const MARKER_SUFFIX: &str = " */";
const MARKER_VERSION: u32 = 1;
/// MySQL のトリガー名 / PostgreSQL の識別子の最大長 (バイト)。
const MYSQL_NAME_MAX: usize = 64;
const PG_NAME_MAX: usize = 63;
/// SQLite の関数の引数上限 (`SQLITE_MAX_FUNCTION_ARG` 既定 127) に収まる、1 つの `json_object` の列数 (1 列 2 引数)。
const SQLITE_JSON_PAIRS_MAX: usize = 63;

/// 監査の対象列 (表の現在の列)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditColumn {
    pub name: String,
    pub data_type: String,
    pub primary_key: bool,
}

/// ウィザードの入力。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditOptions {
    pub insert: bool,
    pub update: bool,
    pub delete: bool,
    /// 記録しない列 (`old_row` / `new_row` から外す。`pk` には主キーを常に入れる)。
    #[serde(default)]
    pub exclude_columns: Vec<String>,
    /// 値が変わらない UPDATE は記録しない。
    #[serde(default)]
    pub skip_unchanged_update: bool,
    /// 監査表の名前。空なら `<table>_audit`。
    #[serde(default)]
    pub audit_table: String,
    /// 監査表のスキーマ / DB。`None` は対象表と同じ (SQLite は常に同じ)。
    #[serde(default)]
    pub audit_schema: Option<String>,
}

/// 生成結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditDdl {
    pub audit_table: String,
    pub audit_schema: String,
    /// 実行する文 (1 文ずつ)。再生成なら既存トリガーの DROP から始まり、監査表は作らない。
    pub create: Vec<String>,
    /// 監査トリガー (と PostgreSQL の関数) を外す文。
    pub drop_triggers: Vec<String>,
    /// 監査表を外す文。
    pub drop_table: String,
    /// `old_row` / `new_row` に記録する列。
    pub recorded_columns: Vec<String>,
    /// 作る / 外すトリガーの名前。
    pub trigger_names: Vec<String>,
    /// 事前警告のコード (`no_primary_key` / `mysql_*` / `mysql_audit_table_reused`。UI が文言に直す)。
    pub warnings: Vec<String>,
}

/// MySQL の監査表が持つ列 (`audit_table_ddl` と揃える)。
const MYSQL_AUDIT_COLUMNS: [&str; 7] = [
    "audit_id",
    "op",
    "changed_at",
    "changed_by",
    "pk",
    "old_row",
    "new_row",
];

/// MySQL の監査表の再利用可否を判定する (#2335)。`existing` は同名の表の列名 (表が無ければ空)。
/// 空なら `Ok(false)` (新規作成)、列構成が監査表と一致すれば `Ok(true)` (再利用)、
/// 別構造の表なら `InvalidInput` (業務表を黙って流用・削除しない)。
pub fn check_mysql_audit_table_reuse(audit_table: &str, existing: &[String]) -> Result<bool> {
    if existing.is_empty() {
        return Ok(false);
    }
    let same = existing.len() == MYSQL_AUDIT_COLUMNS.len()
        && MYSQL_AUDIT_COLUMNS
            .iter()
            .all(|c| existing.iter().any(|e| e.eq_ignore_ascii_case(c)));
    if same {
        Ok(true)
    } else {
        Err(AppError::InvalidInput(format!(
            "同名の表 {audit_table} が既にあり、監査表と列の構成が違います。別の監査表名を指定してください"
        )))
    }
}

/// 構造パネル用の状態。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditStatus {
    /// 監査トリガーがあるか。
    pub present: bool,
    /// トリガーから読み戻したオプション (PostgreSQL は汎用関数なので `None`)。
    pub options: Option<AuditOptions>,
    pub recorded_columns: Vec<String>,
    /// 表に増えたが記録されていない列。
    pub added_columns: Vec<String>,
    /// 記録しているが表から無くなった列。
    pub removed_columns: Vec<String>,
    /// 主キー列が生成時から変わった (トリガー / 関数に主キー列名を埋め込んでいるので PostgreSQL でも再生成が要る)。
    pub pk_changed: bool,
    /// 再生成が必要か (列の増減 (PostgreSQL を除く) か主キー列の変化)。
    pub needs_regeneration: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    v: u32,
    audit_table: String,
    audit_schema: String,
    ops: Vec<String>,
    exclude: Vec<String>,
    skip_unchanged: bool,
    columns: Vec<String>,
    /// 生成時の主キー列 (`pk` に埋め込んでいる)。古い印には無い。
    #[serde(default)]
    pk: Option<Vec<String>>,
}

fn invalid<T>(msg: &str) -> Result<T> {
    Err(AppError::InvalidInput(msg.to_string()))
}

fn name_max(driver: DriverKind) -> usize {
    match driver {
        DriverKind::Mysql => MYSQL_NAME_MAX,
        DriverKind::Postgres => PG_NAME_MAX,
        DriverKind::Sqlite => usize::MAX,
    }
}

/// 監査表の既定名。
pub fn default_audit_table(table: &str) -> String {
    format!("{table}_audit")
}

/// 文字列リテラル (3 ドライバとも `'` の二重化。MySQL は `\` も二重化)。
fn lit(driver: DriverKind, s: &str) -> String {
    let body = s.replace('\'', "''");
    if driver == DriverKind::Mysql {
        format!("'{}'", body.replace('\\', "\\\\"))
    } else {
        format!("'{body}'")
    }
}

/// トリガー名。PostgreSQL は `[0]` 1 本だけ、MySQL / SQLite は INSERT / UPDATE / DELETE の順。
pub fn trigger_names(driver: DriverKind, table: &str) -> Vec<String> {
    match driver {
        DriverKind::Postgres => vec![format!("{table}_audit_trg")],
        _ => ["ins", "upd", "del"]
            .iter()
            .map(|s| format!("{table}_audit_{s}"))
            .collect(),
    }
}

pub fn pg_function_name(table: &str) -> String {
    format!("{table}_audit_fn")
}

/// 監査表の参照 (修飾付き)。
fn audit_table_ref(driver: DriverKind, schema: &str, audit: &str) -> String {
    match driver {
        DriverKind::Sqlite => sqlite_table_ref(schema, audit),
        _ => format!(
            "{}.{}",
            quote_ident(driver, schema),
            quote_ident(driver, audit)
        ),
    }
}

/// `database` 上の名前付きオブジェクト (トリガー / 関数) の参照。SQLite の `main` は修飾なし。
fn object_ref(driver: DriverKind, database: &str, name: &str) -> String {
    if driver == DriverKind::Sqlite && sqlite_is_main(database) {
        quote_ident(driver, name)
    } else {
        format!(
            "{}.{}",
            quote_ident(driver, database),
            quote_ident(driver, name)
        )
    }
}

fn audit_table_ddl(driver: DriverKind, target: &str) -> String {
    match driver {
        DriverKind::Mysql => format!(
            // MySQL は DDL が暗黙コミットされ、後続の CREATE TRIGGER が失敗すると監査表だけが残る (#2335)。
            // 再実行で 1050 (Table already exists) にならないよう IF NOT EXISTS にする。
            "CREATE TABLE IF NOT EXISTS {target} (\n  audit_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  op VARCHAR(6) NOT NULL,\n  changed_at DATETIME(6) NOT NULL,\n  changed_by VARCHAR(288) NULL,\n  pk JSON NULL,\n  old_row JSON NULL,\n  new_row JSON NULL\n)"
        ),
        DriverKind::Postgres => format!(
            "CREATE TABLE {target} (\n  audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  op TEXT NOT NULL,\n  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n  changed_by TEXT NULL,\n  pk JSONB NULL,\n  old_row JSONB NULL,\n  new_row JSONB NULL\n)"
        ),
        DriverKind::Sqlite => format!(
            "CREATE TABLE {target} (\n  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,\n  op TEXT NOT NULL,\n  changed_at TEXT NOT NULL,\n  changed_by TEXT NULL,\n  pk TEXT NULL,\n  old_row TEXT NULL,\n  new_row TEXT NULL\n)"
        ),
    }
}

/// 列を JSON オブジェクトにする式 (MySQL / SQLite)。`rec` は `NEW` / `OLD`。
fn json_object_expr(driver: DriverKind, rec: &str, cols: &[&AuditColumn]) -> String {
    let parts: Vec<String> = cols
        .iter()
        .map(|c| {
            let value = format!("{rec}.{}", quote_ident(driver, &c.name));
            let value = if driver == DriverKind::Sqlite {
                // json_object は BLOB 値を受け付けない。宣言型が BLOB でない列にも BLOB 値は入りうるので、
                // 全列を値の型で判定して 16 進文字列にする。
                format!("CASE WHEN typeof({value}) = 'blob' THEN hex({value}) ELSE {value} END")
            } else {
                value
            };
            format!("{}, {value}", lit(driver, &c.name))
        })
        .collect();
    let func = match driver {
        DriverKind::Mysql => "JSON_OBJECT",
        DriverKind::Postgres => "jsonb_build_object",
        DriverKind::Sqlite => "json_object",
    };
    if driver != DriverKind::Sqlite || parts.len() <= SQLITE_JSON_PAIRS_MAX {
        return format!("{func}({})", parts.join(", "));
    }
    // SQLite は関数の引数が 127 個まで (1 列で 2 引数)。63 組ずつの json_object に分け、
    // 各 `{...}` の外側の括弧を長さで 1 文字ずつ外して連結し、1 つのオブジェクトにする。
    // - json_patch は NULL のメンバーを「削除」と解釈して NULL 値の列が落ちるので使わない。
    // - JSON サブタイプの付いた値 (json_set / json() の結果) は入れ子のオブジェクトとして埋まるため、
    //   rtrim('}') だと値側の `}` まで削って壊れる。長さで外す。
    // - 式を 2 度書かないよう、副問い合わせで各チャンクに名前 (j0, j1, ...) を付ける。
    let chunks: Vec<&[String]> = parts.chunks(SQLITE_JSON_PAIRS_MAX).collect();
    let inner: Vec<String> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{func}({}) AS j{i}", c.join(", ")))
        .collect();
    let body: Vec<String> = (0..chunks.len())
        .map(|i| format!("substr(j{i}, 2, length(j{i}) - 2)"))
        .collect();
    format!(
        "(SELECT '{{' || {} || '}}' FROM (SELECT {}))",
        body.join(" || ',' || "),
        inner.join(", ")
    )
}

fn marker_comment(marker: &Marker) -> Result<String> {
    let json = serde_json::to_string(marker)
        .map_err(|e| AppError::InvalidInput(format!("監査の印を作れません: {e}")))?;
    // `*/` でコメントが閉じないよう `/` をエスケープする (JSON として有効)。
    Ok(format!(
        "{MARKER_PREFIX}{}{MARKER_SUFFIX}",
        json.replace('/', "\\/")
    ))
}

fn parse_marker(definition: &str) -> Option<Marker> {
    let start = definition.find(MARKER_PREFIX)? + MARKER_PREFIX.len();
    let end = definition[start..].find(MARKER_SUFFIX)? + start;
    serde_json::from_str::<Marker>(&definition[start..end])
        .ok()
        .filter(|m| m.v == MARKER_VERSION)
}

fn op_event(op: &str) -> &'static str {
    match op {
        "INSERT" => "INSERT",
        "UPDATE" => "UPDATE",
        _ => "DELETE",
    }
}

/// 監査の DDL 一式を作る。`regenerate` が true なら既存トリガーの DROP から始め、監査表は作らない。
pub fn build_audit_ddl(
    driver: DriverKind,
    database: &str,
    table: &str,
    columns: &[AuditColumn],
    opts: &AuditOptions,
    regenerate: bool,
) -> Result<AuditDdl> {
    if !(opts.insert || opts.update || opts.delete) {
        return invalid("記録する操作 (INSERT / UPDATE / DELETE) を 1 つ以上選んでください");
    }
    if table.is_empty() {
        return invalid("表の名前が空です");
    }
    let audit = if opts.audit_table.trim().is_empty() {
        default_audit_table(table)
    } else {
        opts.audit_table.trim().to_string()
    };
    if audit == table {
        return invalid("監査表の名前が対象の表と同じです");
    }
    let schema = match (&opts.audit_schema, driver) {
        // SQLite のトリガー本体は別スキーマの表を参照できないので、常に対象表と同じ。
        (_, DriverKind::Sqlite) | (None, _) => database.to_string(),
        (Some(s), _) if s.trim().is_empty() => database.to_string(),
        (Some(s), _) => s.trim().to_string(),
    };
    if driver == DriverKind::Sqlite
        && opts
            .audit_schema
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty() && !s.trim().eq_ignore_ascii_case(database))
    {
        return invalid("SQLite の監査表は対象の表と同じデータベースにしか作れません");
    }
    let tnames = trigger_names(driver, table);
    let fn_name = pg_function_name(table);
    let max = name_max(driver);
    if tnames
        .iter()
        .chain(std::iter::once(&fn_name))
        .chain(std::iter::once(&audit))
        .any(|n| {
            if driver == DriverKind::Mysql {
                n.chars().count() > max
            } else {
                n.len() > max
            }
        })
    {
        return invalid("名前が長すぎます (監査表・トリガー名がドライバの上限を超えます)");
    }
    for ex in &opts.exclude_columns {
        if !columns.iter().any(|c| &c.name == ex) {
            return Err(AppError::InvalidInput(format!(
                "記録しない列 {ex} が表にありません"
            )));
        }
    }
    let recorded: Vec<&AuditColumn> = columns
        .iter()
        .filter(|c| !opts.exclude_columns.contains(&c.name))
        .collect();
    if recorded.is_empty() {
        return invalid("記録する列がありません (すべての列を除外しています)");
    }
    let pk: Vec<&AuditColumn> = columns.iter().filter(|c| c.primary_key).collect();

    let mut warnings = Vec::new();
    if pk.is_empty() {
        warnings.push("no_primary_key".to_string());
    }

    let ops: Vec<String> = [
        (opts.insert, "INSERT"),
        (opts.update, "UPDATE"),
        (opts.delete, "DELETE"),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .map(|(_, n)| n.to_string())
    .collect();
    let marker = Marker {
        v: MARKER_VERSION,
        audit_table: audit.clone(),
        audit_schema: schema.clone(),
        ops: ops.clone(),
        exclude: opts.exclude_columns.clone(),
        skip_unchanged: opts.skip_unchanged_update,
        columns: recorded.iter().map(|c| c.name.clone()).collect(),
        pk: Some(pk.iter().map(|c| c.name.clone()).collect()),
    };
    let audit_ref = audit_table_ref(driver, &schema, &audit);
    let table_q = quote_ident(driver, table);
    let table_ref = match driver {
        DriverKind::Sqlite => table_q.clone(), // トリガーの ON は修飾できない
        _ => format!("{}.{}", quote_ident(driver, database), table_q),
    };

    // --- DROP スクリプト ---
    let mut drop_triggers = Vec::new();
    match driver {
        DriverKind::Postgres => {
            drop_triggers.push(format!(
                "DROP TRIGGER IF EXISTS {} ON {table_ref}",
                quote_ident(driver, &tnames[0])
            ));
            drop_triggers.push(format!(
                "DROP FUNCTION IF EXISTS {}()",
                object_ref(driver, database, &fn_name)
            ));
        }
        _ => {
            for n in &tnames {
                drop_triggers.push(format!(
                    "DROP TRIGGER IF EXISTS {}",
                    object_ref(driver, database, n)
                ));
            }
        }
    }
    let drop_table = format!("DROP TABLE IF EXISTS {audit_ref}");

    // --- 作成 ---
    let mut create = Vec::new();
    if regenerate {
        match driver {
            // 関数は CREATE OR REPLACE で置き換えるので、トリガーだけ外す。
            DriverKind::Postgres => create.push(drop_triggers[0].clone()),
            _ => create.extend(drop_triggers.iter().cloned()),
        }
    } else {
        create.push(audit_table_ddl(driver, &audit_ref));
    }
    let marker_text = marker_comment(&marker)?;
    match driver {
        DriverKind::Mysql => create.extend(mysql_triggers(
            database,
            table,
            &audit_ref,
            &tnames,
            &recorded,
            &pk,
            opts,
            &marker_text,
        )),
        DriverKind::Sqlite => create.extend(sqlite_triggers(
            database,
            table,
            &audit_ref,
            &tnames,
            &recorded,
            &pk,
            opts,
            &marker_text,
        )),
        DriverKind::Postgres => create.extend(pg_statements(
            &marker_text,
            database,
            &table_ref,
            &audit_ref,
            &tnames[0],
            &fn_name,
            &recorded,
            &pk,
            &ops,
            opts,
        )),
    }

    Ok(AuditDdl {
        audit_table: audit,
        audit_schema: schema,
        create,
        drop_triggers,
        drop_table,
        recorded_columns: recorded.iter().map(|c| c.name.clone()).collect(),
        trigger_names: tnames,
        warnings,
    })
}

#[allow(clippy::too_many_arguments)]
fn mysql_triggers(
    database: &str,
    table: &str,
    audit_ref: &str,
    names: &[String],
    recorded: &[&AuditColumn],
    pk: &[&AuditColumn],
    opts: &AuditOptions,
    marker: &str,
) -> Vec<String> {
    let d = DriverKind::Mysql;
    let table_ref = format!("{}.{}", quote_ident(d, database), quote_ident(d, table));
    let mut out = Vec::new();
    for (i, (op, on)) in [
        ("INSERT", opts.insert),
        ("UPDATE", opts.update),
        ("DELETE", opts.delete),
    ]
    .into_iter()
    .enumerate()
    {
        if !on {
            continue;
        }
        let pk_expr = |rec: &str| {
            if pk.is_empty() {
                "NULL".to_string()
            } else {
                json_object_expr(d, rec, pk)
            }
        };
        let (old, new, pk_json) = match op {
            "INSERT" => (
                "NULL".to_string(),
                json_object_expr(d, "NEW", recorded),
                pk_expr("NEW"),
            ),
            "UPDATE" => (
                json_object_expr(d, "OLD", recorded),
                json_object_expr(d, "NEW", recorded),
                pk_expr("NEW"),
            ),
            _ => (
                json_object_expr(d, "OLD", recorded),
                "NULL".to_string(),
                pk_expr("OLD"),
            ),
        };
        let insert = format!(
            "INSERT INTO {audit_ref} (op, changed_at, changed_by, pk, old_row, new_row) VALUES ({}, NOW(6), USER(), {pk_json}, {old}, {new});",
            lit(d, op)
        );
        let body = if op == "UPDATE" && opts.skip_unchanged_update {
            let same: Vec<String> = recorded
                .iter()
                .map(|c| {
                    let q = quote_ident(d, &c.name);
                    // 照合順序に依存しない厳密比較 (alice → ALICE も変更として扱う)。
                    format!("CAST(OLD.{q} AS BINARY) <=> CAST(NEW.{q} AS BINARY)")
                })
                .collect();
            format!(
                "  IF NOT ({}) THEN\n    {insert}\n  END IF;",
                same.join(" AND ")
            )
        } else {
            format!("  {insert}")
        };
        out.push(format!(
            "CREATE TRIGGER {} AFTER {} ON {table_ref} FOR EACH ROW\nBEGIN\n  {marker}\n{body}\nEND",
            object_ref(d, database, &names[i]),
            op_event(op)
        ));
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn sqlite_triggers(
    database: &str,
    table: &str,
    audit_ref: &str,
    names: &[String],
    recorded: &[&AuditColumn],
    pk: &[&AuditColumn],
    opts: &AuditOptions,
    marker: &str,
) -> Vec<String> {
    let d = DriverKind::Sqlite;
    // トリガー本体の表は修飾しない (トリガーと同じスキーマで解決される)。
    let audit_local = quote_ident(d, &audit_ref_local(audit_ref));
    let mut out = Vec::new();
    for (i, (op, on)) in [
        ("INSERT", opts.insert),
        ("UPDATE", opts.update),
        ("DELETE", opts.delete),
    ]
    .into_iter()
    .enumerate()
    {
        if !on {
            continue;
        }
        let pk_expr = |rec: &str| {
            if pk.is_empty() {
                "NULL".to_string()
            } else {
                json_object_expr(d, rec, pk)
            }
        };
        let (old, new, pk_json) = match op {
            "INSERT" => (
                "NULL".to_string(),
                json_object_expr(d, "NEW", recorded),
                pk_expr("NEW"),
            ),
            "UPDATE" => (
                json_object_expr(d, "OLD", recorded),
                json_object_expr(d, "NEW", recorded),
                pk_expr("NEW"),
            ),
            _ => (
                json_object_expr(d, "OLD", recorded),
                "NULL".to_string(),
                pk_expr("OLD"),
            ),
        };
        let when = if op == "UPDATE" && opts.skip_unchanged_update {
            let diff: Vec<String> = recorded
                .iter()
                .map(|c| {
                    let q = quote_ident(d, &c.name);
                    format!("OLD.{q} IS NOT NEW.{q}")
                })
                .collect();
            format!("\nWHEN {}", diff.join(" OR "))
        } else {
            String::new()
        };
        out.push(format!(
            "CREATE TRIGGER {} AFTER {} ON {}\nFOR EACH ROW{when}\nBEGIN\n  {marker}\n  INSERT INTO {audit_local} (op, changed_at, changed_by, pk, old_row, new_row) VALUES ({}, strftime('%Y-%m-%dT%H:%M:%f', 'now'), NULL, {pk_json}, {old}, {new});\nEND",
            object_ref(d, database, &names[i]),
            op_event(op),
            quote_ident(d, table),
            lit(d, op)
        ));
    }
    out
}

/// `sqlite_table_ref` が作った参照 (`"x"` または `"s"."x"`) から末尾の名前を取り出す。
fn audit_ref_local(audit_ref: &str) -> String {
    let inner = match audit_ref.rfind("\".\"") {
        Some(p) => &audit_ref[p + 3..],
        None => audit_ref.trim_start_matches('"'),
    };
    inner.trim_end_matches('"').replace("\"\"", "\"")
}

#[allow(clippy::too_many_arguments)]
fn pg_statements(
    marker: &str,
    database: &str,
    table_ref: &str,
    audit_ref: &str,
    trigger: &str,
    fn_name: &str,
    recorded: &[&AuditColumn],
    pk: &[&AuditColumn],
    ops: &[String],
    opts: &AuditOptions,
) -> Vec<String> {
    let d = DriverKind::Postgres;
    // 除外列は `- ARRAY['a','b']` で JSONB から外す。
    let strip = if opts.exclude_columns.is_empty() {
        String::new()
    } else {
        let list: Vec<String> = opts.exclude_columns.iter().map(|c| lit(d, c)).collect();
        format!(" - ARRAY[{}]::text[]", list.join(", "))
    };
    let pk_expr = |rec: &str| {
        if pk.is_empty() {
            "NULL".to_string()
        } else {
            json_object_expr(d, rec, pk)
        }
    };
    let _ = recorded; // 汎用関数なので列は実行時に決まる
    let ins = |old: &str, new: &str, pkv: &str| {
        format!(
            "INSERT INTO {audit_ref} (op, changed_at, changed_by, pk, old_row, new_row) VALUES (TG_OP, now(), current_user, {pkv}, {old}, {new});"
        )
    };
    let mut branches = Vec::new();
    if ops.iter().any(|o| o == "INSERT") {
        branches.push(format!(
            "IF TG_OP = 'INSERT' THEN\n    {}\n    RETURN NEW;",
            ins("NULL", &format!("to_jsonb(NEW){strip}"), &pk_expr("NEW"))
        ));
    }
    if ops.iter().any(|o| o == "UPDATE") {
        let skip = if opts.skip_unchanged_update {
            format!(
                "\n    IF (to_jsonb(OLD){strip}) = (to_jsonb(NEW){strip}) THEN\n      RETURN NEW;\n    END IF;"
            )
        } else {
            String::new()
        };
        branches.push(format!(
            "ELSIF TG_OP = 'UPDATE' THEN{skip}\n    {}\n    RETURN NEW;",
            ins(
                &format!("to_jsonb(OLD){strip}"),
                &format!("to_jsonb(NEW){strip}"),
                &pk_expr("NEW")
            )
        ));
    }
    if ops.iter().any(|o| o == "DELETE") {
        branches.push(format!(
            "ELSIF TG_OP = 'DELETE' THEN\n    {}\n    RETURN OLD;",
            ins(&format!("to_jsonb(OLD){strip}"), "NULL", &pk_expr("OLD"))
        ));
    }
    // 先頭が ELSIF になる (INSERT 無し) ときは IF に直す。
    let mut body = branches.join("\n  ");
    if let Some(rest) = body.strip_prefix("ELSIF ") {
        body = format!("IF {rest}");
    }
    let inner = format!("BEGIN\n  {marker}\n  {body}\n  END IF;\n  RETURN NULL;\nEND;\n");
    // 本体 (識別子の中身を含む) に同じ区切りが現れたら閉じてしまうので、衝突しない区切りを選ぶ。
    let mut tag = "$noobdb_audit$".to_string();
    let mut n = 0;
    while inner.contains(&tag) {
        n += 1;
        tag = format!("$noobdb_audit{n}$");
    }
    let function = format!(
        "CREATE OR REPLACE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS {tag}\n{inner}{tag}",
        object_ref(d, database, fn_name)
    );
    let events: Vec<&str> = ops.iter().map(|o| op_event(o)).collect();
    let create_trigger = format!(
        "CREATE TRIGGER {} AFTER {} ON {table_ref} FOR EACH ROW EXECUTE FUNCTION {}()",
        quote_ident(d, trigger),
        events.join(" OR "),
        object_ref(d, database, fn_name)
    );
    vec![function, create_trigger]
}

/// 表のトリガー一覧と現在の列から、監査の状態を判定する。
pub fn audit_status(
    driver: DriverKind,
    table: &str,
    triggers: &[TableTrigger],
    current_columns: &[String],
    current_pk: &[String],
    pg_function_source: Option<&str>,
) -> AuditStatus {
    let none = AuditStatus {
        present: false,
        options: None,
        recorded_columns: Vec::new(),
        added_columns: Vec::new(),
        removed_columns: Vec::new(),
        pk_changed: false,
        needs_regeneration: false,
    };
    let marker = if driver == DriverKind::Postgres {
        let name = trigger_names(driver, table).remove(0);
        if !triggers.iter().any(|t| t.name == name) {
            return none;
        }
        // PostgreSQL は汎用関数なので、関数本体の印からオプションを読み戻す (読めなければ `options: None`)。
        match pg_function_source.and_then(parse_marker) {
            Some(m) => m,
            None => {
                return AuditStatus {
                    present: true,
                    ..none
                }
            }
        }
    } else {
        match triggers.iter().find_map(|t| parse_marker(&t.definition)) {
            Some(m) => m,
            None => return none,
        }
    };
    let is_pg = driver == DriverKind::Postgres;
    let pk_changed = marker.pk.as_ref().is_some_and(|p| p != current_pk);
    let added: Vec<String> = current_columns
        .iter()
        .filter(|c| !marker.columns.contains(c) && !marker.exclude.contains(c))
        .cloned()
        .collect();
    let removed: Vec<String> = marker
        .columns
        .iter()
        .filter(|c| !current_columns.contains(c))
        .cloned()
        .collect();
    // 表から無くなった除外列は落とす (残すと再生成・削除の入力検証で弾かれる)。
    let exclude: Vec<String> = marker
        .exclude
        .iter()
        .filter(|c| current_columns.contains(c))
        .cloned()
        .collect();
    AuditStatus {
        present: true,
        pk_changed,
        // PostgreSQL は汎用関数なので列の増減では作り直し不要 (主キー列の変化だけが対象)。
        needs_regeneration: pk_changed || (!is_pg && (!added.is_empty() || !removed.is_empty())),
        options: Some(AuditOptions {
            insert: marker.ops.iter().any(|o| o == "INSERT"),
            update: marker.ops.iter().any(|o| o == "UPDATE"),
            delete: marker.ops.iter().any(|o| o == "DELETE"),
            exclude_columns: exclude,
            skip_unchanged_update: marker.skip_unchanged,
            audit_table: marker.audit_table.clone(),
            audit_schema: Some(marker.audit_schema.clone()),
        }),
        recorded_columns: marker.columns,
        added_columns: added,
        removed_columns: removed,
    }
}

/// `SHOW GRANTS` の 1 行の権限リスト (`GRANT <ここ> ON ...`) と対象 (`ON` の右)。
fn grant_parts(line: &str) -> Option<(Vec<String>, &str)> {
    let rest = line.trim().strip_prefix("GRANT ")?;
    let on = rest.find(" ON ")?;
    let privs = rest[..on]
        .split(',')
        .map(|p| p.trim().to_ascii_uppercase())
        .collect();
    let target = rest[on + 4..].split(" TO ").next().unwrap_or("");
    Some((privs, target.trim()))
}

/// MySQL の事前警告 (`mysql_trigger_privilege` / `mysql_binlog_trust`)。
/// `grants` は `SHOW GRANTS FOR CURRENT_USER()` の各行。権限の有無はスコープを区別せず目安で判定する。
pub fn mysql_audit_warnings(log_bin: bool, trust_creators: bool, grants: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let parsed: Vec<(Vec<String>, &str)> = grants.iter().filter_map(|g| grant_parts(g)).collect();
    let has = |name: &str| {
        parsed.iter().any(|(p, _)| {
            p.iter()
                .any(|x| x == name || x == "ALL PRIVILEGES" || x == "ALL")
        })
    };
    if !has("TRIGGER") {
        out.push("mysql_trigger_privilege".to_string());
    }
    let has_super = parsed.iter().any(|(p, target)| {
        p.iter().any(|x| x == "SUPER" || x == "SET_USER_ID")
            || (*target == "*.*" && p.iter().any(|x| x == "ALL PRIVILEGES" || x == "ALL"))
    });
    if log_bin && !trust_creators && !has_super {
        out.push("mysql_binlog_trust".to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, pk: bool) -> AuditColumn {
        AuditColumn {
            name: name.into(),
            data_type: ty.into(),
            primary_key: pk,
        }
    }

    fn pk() -> Vec<String> {
        vec!["id".into()]
    }

    fn cols() -> Vec<AuditColumn> {
        vec![
            col("id", "int", true),
            col("name", "text", false),
            col("secret", "text", false),
        ]
    }

    fn opts() -> AuditOptions {
        AuditOptions {
            insert: true,
            update: true,
            delete: true,
            exclude_columns: vec!["secret".into()],
            skip_unchanged_update: true,
            audit_table: String::new(),
            audit_schema: None,
        }
    }

    #[test]
    fn mysql_create_table_is_rerunnable_after_partial_failure() {
        // 監査表だけが残った状態 (#2335) から再実行しても CREATE TABLE で止まらない。
        let d =
            build_audit_ddl(DriverKind::Mysql, "shop", "users", &cols(), &opts(), false).unwrap();
        assert!(d.create[0].starts_with("CREATE TABLE IF NOT EXISTS "));
        // 暗黙コミットのない PostgreSQL / SQLite は従来どおり (既存表との衝突は検出したい)。
        for driver in [DriverKind::Postgres, DriverKind::Sqlite] {
            let d = build_audit_ddl(driver, "main", "users", &cols(), &opts(), false).unwrap();
            assert!(!d.create[0].contains("IF NOT EXISTS"), "{driver:?}");
        }
    }

    #[test]
    fn mysql_audit_table_reuse_requires_matching_columns() {
        let own: Vec<String> = [
            "audit_id",
            "op",
            "changed_at",
            "changed_by",
            "pk",
            "old_row",
            "new_row",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(!check_mysql_audit_table_reuse("a", &[]).unwrap());
        assert!(check_mysql_audit_table_reuse("a", &own).unwrap());
        let upper: Vec<String> = own.iter().map(|s| s.to_uppercase()).collect();
        assert!(check_mysql_audit_table_reuse("a", &upper).unwrap());
        // 業務表 (列構成が違う) と、列が余分 / 不足の表は拒否する。
        let biz = vec!["id".to_string(), "name".to_string()];
        assert!(matches!(
            check_mysql_audit_table_reuse("a", &biz),
            Err(AppError::InvalidInput(_))
        ));
        let mut extra = own.clone();
        extra.push("note".into());
        assert!(check_mysql_audit_table_reuse("a", &extra).is_err());
        assert!(check_mysql_audit_table_reuse("a", &own[..6]).is_err());
    }

    #[test]
    fn mysql_generates_three_column_explicit_triggers() {
        let d =
            build_audit_ddl(DriverKind::Mysql, "shop", "users", &cols(), &opts(), false).unwrap();
        assert_eq!(d.audit_table, "users_audit");
        assert_eq!(d.create.len(), 4);
        assert!(d.create[0].starts_with("CREATE TABLE IF NOT EXISTS `shop`.`users_audit`"));
        assert!(d.create[0].contains("DATETIME(6)"));
        let ins = &d.create[1];
        assert!(
            ins.contains("CREATE TRIGGER `shop`.`users_audit_ins` AFTER INSERT ON `shop`.`users`")
        );
        assert!(ins.contains("JSON_OBJECT('id', NEW.`id`, 'name', NEW.`name`)"));
        assert!(!ins.contains("secret` ,") && !ins.contains("NEW.`secret`"));
        assert!(
            ins.contains(", USER(),") && !ins.contains("CURRENT_USER()") && ins.contains("NOW(6)")
        );
        let upd = &d.create[2];
        assert!(upd.contains(
            "IF NOT (CAST(OLD.`id` AS BINARY) <=> CAST(NEW.`id` AS BINARY) AND CAST(OLD.`name` AS BINARY) <=> CAST(NEW.`name` AS BINARY)) THEN"
        ));
        assert!(d.create[3].contains("pk, old_row, new_row") && d.create[3].contains("OLD.`id`"));
        assert_eq!(d.recorded_columns, vec!["id", "name"]);
        assert_eq!(d.trigger_names.len(), 3);
    }

    #[test]
    fn mysql_update_without_skip_has_no_if() {
        let mut o = opts();
        o.skip_unchanged_update = false;
        let d = build_audit_ddl(DriverKind::Mysql, "shop", "users", &cols(), &o, false).unwrap();
        assert!(!d.create[2].contains("IF NOT"));
    }

    #[test]
    fn sqlite_uses_when_clause_and_unqualified_body() {
        let d =
            build_audit_ddl(DriverKind::Sqlite, "main", "users", &cols(), &opts(), false).unwrap();
        assert!(d.create[0].starts_with("CREATE TABLE \"users_audit\""));
        assert!(d.create[0].contains("AUTOINCREMENT"));
        let upd = &d.create[2];
        assert!(upd.contains("CREATE TRIGGER \"users_audit_upd\" AFTER UPDATE ON \"users\""));
        assert!(
            upd.contains("WHEN OLD.\"id\" IS NOT NEW.\"id\" OR OLD.\"name\" IS NOT NEW.\"name\"")
        );
        assert!(upd.contains("INSERT INTO \"users_audit\""));
        assert!(upd.contains("strftime('%Y-%m-%dT%H:%M:%f', 'now'), NULL"));
        assert!(upd.contains("json_object('id', CASE WHEN typeof(NEW.\"id\") = 'blob'"));
        assert!(upd.contains("'name', CASE WHEN typeof(NEW.\"name\") = 'blob'"));
    }

    /// SQL 中の各 `json_object(` 呼び出しの引数の個数 (括弧の深さ 1 のカンマ + 1) を返す。
    fn json_object_arg_counts(sql: &str) -> Vec<usize> {
        let mut counts = Vec::new();
        let mut rest = sql;
        while let Some(i) = rest.find("json_object(") {
            let body = &rest[i + "json_object(".len()..];
            let (mut depth, mut commas, mut in_str) = (1, 0, false);
            for ch in body.chars() {
                match ch {
                    '\'' => in_str = !in_str,
                    _ if in_str => {}
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    ',' if depth == 1 => commas += 1,
                    _ => {}
                }
            }
            counts.push(commas + 1);
            rest = body;
        }
        counts
    }

    #[test]
    fn sqlite_wide_table_splits_json_object_under_arg_limit() {
        // 1 列 2 引数。SQLite の関数引数上限 127 を超えないよう、どの json_object も 126 引数以下 (#2334)。
        for n in [70usize, 200] {
            let mut cs = vec![col("id", "INTEGER", true)];
            cs.extend((1..n).map(|i| col(&format!("c{i}"), "INTEGER", false)));
            let mut o = opts();
            o.exclude_columns.clear();
            let d = build_audit_ddl(DriverKind::Sqlite, "main", "w", &cs, &o, false).unwrap();
            for sql in &d.create[1..] {
                let counts = json_object_arg_counts(sql);
                assert!(counts.iter().all(|&c| c <= 126), "{n} 列: {counts:?}");
                assert!(counts.contains(&126), "{n} 列は分割される");
            }
            // 全列が NEW に残る (1 列も欠けない)。
            let ins = &d.create[1];
            // 主キー用の json_object に id がもう 1 回出る。
            assert_eq!(ins.matches("typeof(NEW.").count(), n + 1);
        }
        // 64 列未満は従来どおり 1 つの json_object。
        let d =
            build_audit_ddl(DriverKind::Sqlite, "main", "users", &cols(), &opts(), false).unwrap();
        assert!(!d.create[1].contains("AS j1"));
    }

    #[test]
    fn sqlite_json_object_split_boundaries() {
        // 分割境界: 63 列までは 1 つ、64 列から分割。126 列は 2 つ、127 列は 3 つ (#2334)。
        for (n, chunks) in [(63usize, 1usize), (64, 2), (126, 2), (127, 3)] {
            let cs: Vec<AuditColumn> = (0..n)
                .map(|i| col(&format!("c{i}"), "INTEGER", false))
                .collect();
            let refs: Vec<&AuditColumn> = cs.iter().collect();
            let sql = json_object_expr(DriverKind::Sqlite, "NEW", &refs);
            let counts = json_object_arg_counts(&sql);
            assert_eq!(counts.len(), chunks, "{n} 列");
            assert!(counts.iter().all(|&c| c <= 126), "{n} 列: {counts:?}");
            assert_eq!(counts.iter().sum::<usize>(), n * 2, "{n} 列");
        }
    }

    #[test]
    fn sqlite_attached_database_qualifies_trigger_but_not_body() {
        let d =
            build_audit_ddl(DriverKind::Sqlite, "ext", "users", &cols(), &opts(), false).unwrap();
        assert!(d.create[0].starts_with("CREATE TABLE \"ext\".\"users_audit\""));
        assert!(d.create[1]
            .contains("CREATE TRIGGER \"ext\".\"users_audit_ins\" AFTER INSERT ON \"users\""));
        assert!(d.create[1].contains("INSERT INTO \"users_audit\""));
        assert_eq!(d.drop_table, "DROP TABLE IF EXISTS \"ext\".\"users_audit\"");
    }

    #[test]
    fn sqlite_wraps_every_column_in_blob_guard() {
        // 宣言型が BLOB でない列にも BLOB 値は入りうるので、型名に依らず全列を包む。
        let cs = vec![col("id", "INTEGER", true), col("img", "TEXT", false)];
        let mut o = opts();
        o.exclude_columns.clear();
        let d = build_audit_ddl(DriverKind::Sqlite, "main", "t", &cs, &o, false).unwrap();
        assert!(d.create[1].contains(
            "CASE WHEN typeof(NEW.\"img\") = 'blob' THEN hex(NEW.\"img\") ELSE NEW.\"img\" END"
        ));
        assert!(d.create[1].contains("typeof(NEW.\"id\") = 'blob'"));
    }

    #[test]
    fn postgres_generates_one_generic_function_and_trigger() {
        let d = build_audit_ddl(
            DriverKind::Postgres,
            "public",
            "users",
            &cols(),
            &opts(),
            false,
        )
        .unwrap();
        assert_eq!(d.create.len(), 3);
        assert!(
            d.create[0].contains("GENERATED ALWAYS AS IDENTITY") && d.create[0].contains("JSONB")
        );
        let f = &d.create[1];
        assert!(f.starts_with("CREATE OR REPLACE FUNCTION \"public\".\"users_audit_fn\"()"));
        assert!(f.contains("to_jsonb(NEW) - ARRAY['secret']::text[]"));
        assert!(f.contains(
            "(to_jsonb(OLD) - ARRAY['secret']::text[]) = (to_jsonb(NEW) - ARRAY['secret']::text[])"
        ));
        assert!(f.contains("TG_OP") && f.contains("current_user") && f.contains("now()"));
        assert!(f.contains("jsonb_build_object('id', NEW.\"id\")"));
        assert!(d.create[2].contains(
            "CREATE TRIGGER \"users_audit_trg\" AFTER INSERT OR UPDATE OR DELETE ON \"public\".\"users\""
        ));
        assert_eq!(d.drop_triggers.len(), 2);
        assert!(d.drop_triggers[0].contains("ON \"public\".\"users\""));
    }

    #[test]
    fn postgres_without_insert_starts_with_if() {
        let mut o = opts();
        o.insert = false;
        let d =
            build_audit_ddl(DriverKind::Postgres, "public", "users", &cols(), &o, false).unwrap();
        let f = &d.create[1];
        assert!(f.contains("IF TG_OP = 'UPDATE' THEN") && !f.contains("ELSIF TG_OP = 'UPDATE'"));
        assert!(d.create[2].contains("AFTER UPDATE OR DELETE ON"));
    }

    #[test]
    fn postgres_without_excludes_does_not_strip() {
        let mut o = opts();
        o.exclude_columns.clear();
        let d =
            build_audit_ddl(DriverKind::Postgres, "public", "users", &cols(), &o, false).unwrap();
        assert!(!d.create[1].contains("ARRAY["));
    }

    #[test]
    fn regenerate_drops_triggers_and_skips_audit_table() {
        let d =
            build_audit_ddl(DriverKind::Mysql, "shop", "users", &cols(), &opts(), true).unwrap();
        assert!(d.create[0].starts_with("DROP TRIGGER IF EXISTS `shop`.`users_audit_ins`"));
        assert!(!d.create.iter().any(|s| s.starts_with("CREATE TABLE")));
        let pg = build_audit_ddl(
            DriverKind::Postgres,
            "public",
            "users",
            &cols(),
            &opts(),
            true,
        )
        .unwrap();
        assert!(pg.create[0].starts_with("DROP TRIGGER IF EXISTS \"users_audit_trg\""));
        assert!(pg.create[1].starts_with("CREATE OR REPLACE FUNCTION"));
    }

    #[test]
    fn drop_scripts_cover_triggers_and_table() {
        let d =
            build_audit_ddl(DriverKind::Mysql, "shop", "users", &cols(), &opts(), false).unwrap();
        assert_eq!(d.drop_triggers.len(), 3);
        assert_eq!(d.drop_table, "DROP TABLE IF EXISTS `shop`.`users_audit`");
        let pg = build_audit_ddl(DriverKind::Postgres, "s", "u", &cols(), &opts(), false).unwrap();
        assert_eq!(
            pg.drop_triggers[1],
            "DROP FUNCTION IF EXISTS \"s\".\"u_audit_fn\"()"
        );
    }

    #[test]
    fn custom_audit_table_and_schema() {
        let mut o = opts();
        o.audit_table = "history".into();
        o.audit_schema = Some("audit".into());
        let d =
            build_audit_ddl(DriverKind::Postgres, "public", "users", &cols(), &o, false).unwrap();
        assert!(d.create[0].starts_with("CREATE TABLE \"audit\".\"history\""));
        assert!(d.create[1].contains("INSERT INTO \"audit\".\"history\""));
        let mut s = opts();
        s.audit_schema = Some("other".into());
        assert!(build_audit_ddl(DriverKind::Sqlite, "main", "users", &cols(), &s, false).is_err());
    }

    #[test]
    fn rejects_invalid_input() {
        let mut o = opts();
        o.insert = false;
        o.update = false;
        o.delete = false;
        assert!(build_audit_ddl(DriverKind::Mysql, "d", "t", &cols(), &o, false).is_err());
        let mut o = opts();
        o.exclude_columns = vec!["nope".into()];
        assert!(build_audit_ddl(DriverKind::Mysql, "d", "t", &cols(), &o, false).is_err());
        let mut o = opts();
        o.exclude_columns = vec!["id".into(), "name".into(), "secret".into()];
        assert!(build_audit_ddl(DriverKind::Mysql, "d", "t", &cols(), &o, false).is_err());
        let mut o = opts();
        o.audit_table = "t".into();
        assert!(build_audit_ddl(DriverKind::Mysql, "d", "t", &cols(), &o, false).is_err());
        let long = "x".repeat(60);
        assert!(build_audit_ddl(DriverKind::Mysql, "d", &long, &cols(), &opts(), false).is_err());
    }

    #[test]
    fn no_primary_key_warns_and_uses_null_pk() {
        let cs = vec![col("a", "int", false)];
        let mut o = opts();
        o.exclude_columns.clear();
        let d = build_audit_ddl(DriverKind::Mysql, "d", "t", &cs, &o, false).unwrap();
        assert!(d.warnings.contains(&"no_primary_key".to_string()));
        assert!(d.create[1].contains("USER(), NULL, NULL,"));
    }

    #[test]
    fn identifiers_and_literals_are_escaped() {
        let cs = vec![col("we`ird'", "int", true)];
        let mut o = opts();
        o.exclude_columns.clear();
        let d = build_audit_ddl(DriverKind::Mysql, "d", "t", &cs, &o, false).unwrap();
        assert!(d.create[1].contains("JSON_OBJECT('we`ird''', NEW.`we``ird'`)"));
    }

    fn trig(name: &str, definition: &str) -> TableTrigger {
        TableTrigger {
            name: name.into(),
            timing: "AFTER".into(),
            event: "INSERT".into(),
            definition: definition.into(),
            enabled: true,
        }
    }

    #[test]
    fn status_detects_added_and_removed_columns() {
        for driver in [DriverKind::Mysql, DriverKind::Sqlite] {
            let d = build_audit_ddl(driver, "main", "users", &cols(), &opts(), false).unwrap();
            let triggers: Vec<TableTrigger> = d
                .create
                .iter()
                .filter(|s| s.starts_with("CREATE TRIGGER"))
                .map(|s| trig("users_audit_ins", s))
                .collect();
            let cur: Vec<String> = ["id", "name", "secret"].map(String::from).to_vec();
            let s = audit_status(driver, "users", &triggers, &cur, &pk(), None);
            assert!(s.present && !s.needs_regeneration, "{driver:?}");
            assert_eq!(s.recorded_columns, vec!["id", "name"]);
            let o = s.options.unwrap();
            assert_eq!(o.exclude_columns, vec!["secret"]);
            assert!(o.skip_unchanged_update && o.insert && o.update && o.delete);
            // 列が増えた
            let cur: Vec<String> = ["id", "name", "secret", "email"].map(String::from).to_vec();
            let s = audit_status(driver, "users", &triggers, &cur, &pk(), None);
            assert!(s.needs_regeneration);
            assert_eq!(s.added_columns, vec!["email"]);
            // 列が減った
            let cur: Vec<String> = ["id", "secret"].map(String::from).to_vec();
            let s = audit_status(driver, "users", &triggers, &cur, &pk(), None);
            assert_eq!(s.removed_columns, vec!["name"]);
            assert!(s.needs_regeneration);
        }
    }

    #[test]
    fn status_without_audit_or_for_postgres() {
        let cur: Vec<String> = vec!["id".into()];
        let s = audit_status(
            DriverKind::Mysql,
            "t",
            &[trig("other", "CREATE TRIGGER x")],
            &cur,
            &pk(),
            None,
        );
        assert!(!s.present);
        let s = audit_status(
            DriverKind::Postgres,
            "t",
            &[trig("t_audit_trg", "")],
            &cur,
            &pk(),
            None,
        );
        assert!(s.present && !s.needs_regeneration && s.options.is_none());
        let s = audit_status(DriverKind::Postgres, "t", &[], &cur, &pk(), None);
        assert!(!s.present);
    }

    #[test]
    fn postgres_status_reads_options_back_from_function_source() {
        let mut o = opts();
        o.audit_table = "history".into();
        o.audit_schema = Some("audit".into());
        let d =
            build_audit_ddl(DriverKind::Postgres, "public", "users", &cols(), &o, false).unwrap();
        let src = &d.create[1];
        let cur: Vec<String> = ["id", "name", "secret", "email"].map(String::from).to_vec();
        let trg = [trig("users_audit_trg", "")];
        let st = audit_status(DriverKind::Postgres, "users", &trg, &cur, &pk(), Some(src));
        let got = st.options.expect("options");
        assert_eq!(got.audit_table, "history");
        assert_eq!(got.audit_schema.as_deref(), Some("audit"));
        assert_eq!(got.exclude_columns, vec!["secret"]);
        // 汎用関数なので、列が増えても再生成は要らない。
        assert!(st.present && !st.needs_regeneration);
        // 読み戻せなければ options は None (呼び出し側が表名を編集可能にする)。
        let st = audit_status(
            DriverKind::Postgres,
            "users",
            &trg,
            &cur,
            &pk(),
            Some("BEGIN END"),
        );
        assert!(st.present && st.options.is_none());
    }

    #[test]
    fn pk_change_requires_regeneration_even_on_postgres() {
        // 関数 / トリガーは主キー列名を埋め込むので、主キー列の削除・リネームで書き込みが失敗する。
        let cur: Vec<String> = ["id", "name", "secret"].map(String::from).to_vec();
        let pg = build_audit_ddl(
            DriverKind::Postgres,
            "public",
            "users",
            &cols(),
            &opts(),
            false,
        )
        .unwrap();
        let trg = [trig("users_audit_trg", "")];
        let renamed = vec!["uid".to_string()];
        let st = audit_status(
            DriverKind::Postgres,
            "users",
            &trg,
            &cur,
            &renamed,
            Some(&pg.create[1]),
        );
        assert!(st.pk_changed && st.needs_regeneration);
        let st = audit_status(
            DriverKind::Postgres,
            "users",
            &trg,
            &cur,
            &pk(),
            Some(&pg.create[1]),
        );
        assert!(!st.pk_changed && !st.needs_regeneration);
        let my = build_audit_ddl(DriverKind::Mysql, "d", "users", &cols(), &opts(), false).unwrap();
        let t2 = [trig("users_audit_ins", &my.create[1])];
        let st = audit_status(DriverKind::Mysql, "users", &t2, &cur, &renamed, None);
        assert!(st.pk_changed && st.needs_regeneration);
    }

    #[test]
    fn mysql_audit_statements_use_text_protocol_but_table_does_not() {
        use crate::db::object_diff::{text_protocol_mode, TextProtocolMode};
        // 実行経路 (ユーザー SQL / GUI の DDL = allow_split が偽) で、トリガーの CREATE / DROP はテキスト
        // プロトコル (prepared では MySQL エラー 1295)、CREATE TABLE は通常のまま。
        let d = build_audit_ddl(DriverKind::Mysql, "d", "users", &cols(), &opts(), false).unwrap();
        assert_eq!(
            text_protocol_mode(false, &d.create[0]),
            TextProtocolMode::Prepared
        );
        for st in &d.create[1..] {
            assert_eq!(
                text_protocol_mode(false, st),
                TextProtocolMode::Whole,
                "{st}"
            );
        }
        for st in &d.drop_triggers {
            assert_eq!(
                text_protocol_mode(false, st),
                TextProtocolMode::Whole,
                "{st}"
            );
        }
        assert_eq!(
            text_protocol_mode(false, &d.drop_table),
            TextProtocolMode::Prepared
        );
        // 区切り行 (スキーマ同期専用) をユーザー SQL に混ぜても分割しない。
        assert_eq!(
            text_protocol_mode(false, "CREATE TRIGGER t ...\n-- noobdb:split\nDROP TABLE x"),
            TextProtocolMode::Prepared
        );
        assert_eq!(
            text_protocol_mode(true, "CREATE TRIGGER t ...\n-- noobdb:split\nDROP TABLE x"),
            TextProtocolMode::Split
        );
    }

    #[test]
    fn status_drops_excluded_columns_removed_from_table() {
        let d = build_audit_ddl(DriverKind::Mysql, "d", "users", &cols(), &opts(), false).unwrap();
        let triggers = [trig("users_audit_ins", &d.create[1])];
        // 除外していた secret 列が表から無くなった。
        let cur: Vec<String> = ["id", "name"].map(String::from).to_vec();
        let st = audit_status(DriverKind::Mysql, "users", &triggers, &cur, &pk(), None);
        let o = st.options.expect("options");
        assert!(o.exclude_columns.is_empty());
        // そのまま再生成・削除用の DDL を作れる。
        let cs = vec![col("id", "int", true), col("name", "text", false)];
        assert!(build_audit_ddl(DriverKind::Mysql, "d", "users", &cs, &o, true).is_ok());
    }

    #[test]
    fn postgres_dollar_quote_tag_avoids_collision_with_identifiers() {
        let cs = vec![col("a$noobdb_audit$b", "int", true)];
        let mut o = opts();
        o.exclude_columns.clear();
        let d = build_audit_ddl(DriverKind::Postgres, "public", "t", &cs, &o, false).unwrap();
        let f = &d.create[1];
        assert!(f.contains("AS $noobdb_audit1$\n"), "{f}");
        assert!(f.trim_end().ends_with("$noobdb_audit1$"));
        // 本体に現れる `$noobdb_audit$` は区切りとして使わない。
        assert_eq!(f.matches("$noobdb_audit1$").count(), 2);
    }

    #[test]
    fn marker_survives_slashes_in_column_names() {
        let cs = vec![col("a*/b", "int", true)];
        let mut o = opts();
        o.exclude_columns.clear();
        let d = build_audit_ddl(DriverKind::Sqlite, "main", "t", &cs, &o, false).unwrap();
        let m = parse_marker(&d.create[1]).unwrap();
        assert_eq!(m.columns, vec!["a*/b"]);
    }

    #[test]
    fn mysql_warnings_from_grants() {
        let all = vec!["GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION".to_string()];
        assert!(mysql_audit_warnings(true, false, &all).is_empty());
        let limited = vec!["GRANT SELECT, INSERT ON `app`.* TO `u`@`%`".to_string()];
        assert_eq!(
            mysql_audit_warnings(false, false, &limited),
            vec!["mysql_trigger_privilege"]
        );
        let trig_only = vec!["GRANT SELECT, TRIGGER ON `app`.* TO `u`@`%`".to_string()];
        assert_eq!(
            mysql_audit_warnings(true, false, &trig_only),
            vec!["mysql_binlog_trust"]
        );
        assert!(mysql_audit_warnings(true, true, &trig_only).is_empty());
        let sup = vec![
            "GRANT TRIGGER ON `app`.* TO `u`@`%`".to_string(),
            "GRANT SUPER ON *.* TO `u`@`%`".to_string(),
        ];
        assert!(mysql_audit_warnings(true, false, &sup).is_empty());
    }
}
