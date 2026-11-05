//! グリッド経由の一括書き込み (`bulk_update_cells`) のフライトレコーダー記録 (#2024)。
//!
//! 結果グリッドのインラインセル編集・行追加/削除は `run_query_stream({ capture: true })` を
//! 通らないため、従来は Undo の対象外だった。ここでは、`bulk_update_cells` が受け取る構造化入力
//! (主キー・編集グループ・追加文) から対象行を特定し、適用の前後で全列の行イメージを読んで、
//! 1 バッチ (`batch_id`) の記録として保存する。
//!
//! - **UPDATE**: 編集グループの主キーで before / after を `SELECT *` し、変わった行だけを
//!   `Update` 記録にする (主キー列を書き換える編集は行を追えないので辞退)。
//! - **DELETE**: 追加文 `DELETE FROM <表> WHERE <条件>` の条件で before を読み、`Delete` 記録にする。
//! - **INSERT**: 追加文 `INSERT INTO <表> (列…) VALUES (…)` の主キー列が単純なリテラルで
//!   指定されているときだけ、その主キーで after を読み `Insert` 記録にする
//!   (AUTO_INCREMENT など主キーを送らない行はコミット後に特定できないので辞退)。
//!
//! **ベストエフォート**: 書き込みトランザクション自体は従来どおり
//! `run_query_transaction_guarded_inner` の 1 本で、before はその直前・after は直後に別接続で
//! 読む (同一トランザクションではない)。そのため、読み取りの失敗・行数の食い違い・上限超過は
//! 記録を辞退するだけで、編集そのものは妨げない (「捕捉が書き込みを妨げない」原則)。
//! 逆方向 SQL は既存の Undo / Redo / バッチ経路 (`generate_data_sync_sql`) を共有し、
//! read_only ガードも `apply_flight_batch` 側の既存経路がそのまま効く。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::commands::bulk_write::{row_condition, BulkUpdateGroup, OR_CHUNK};
use crate::db::sync::quote_ident;
use crate::db::types::{Column, Value};
use crate::db::upsert_capture::parse_upsert;
use crate::db::{Connection, DriverKind, WriteCapture, WriteKind, DEFAULT_CAPTURE_ROW_CAP};
use crate::flight_recorder::{new_batch_id, persist_capture};
use crate::state::Session;

/// `bulk_update_cells` の記録オプション (`run_sql_batch` の capture と同形)。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BulkCaptureConfig {
    /// 1 回の適用で記録する行数の上限。省略時は `DEFAULT_CAPTURE_ROW_CAP`。
    pub row_cap: Option<u32>,
    pub retention_days: Option<u32>,
}

/// 記録の結果 (`BulkWriteOutcome::Applied` に載せる)。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct BulkCaptureOutcome {
    /// 保存した記録の件数 (UPDATE / DELETE / INSERT それぞれ 1 件)。
    pub recorded: u32,
    /// 記録を辞退した部分の数 (主キーを特定できない追加文、行数の食い違い、上限超過など)。
    pub declined: u32,
    /// 記録に共通のバッチ id。1 件も保存しなければ `None`。
    pub batch_id: Option<String>,
}

#[derive(Debug, Default)]
struct Fetched {
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
}

#[derive(Debug)]
struct UpdatePart {
    /// 今回の適用で SET した列 (小文字化はせず、編集グループの表記のまま)。
    set_columns: Vec<String>,
    conds: Vec<String>,
    expected: usize,
    before: Fetched,
    sql: String,
}

#[derive(Debug)]
struct DeletePart {
    before: Fetched,
    sql: String,
}

#[derive(Debug)]
struct InsertPart {
    conds: Vec<String>,
    expected: usize,
    sql: String,
}

/// 適用前に組み立てた記録の計画。
#[derive(Debug, Default)]
pub(crate) struct BulkCapturePlan {
    update: Option<UpdatePart>,
    delete: Option<DeletePart>,
    insert: Option<InsertPart>,
    declined: u32,
}

fn quote_for(driver: DriverKind) -> fn(&str) -> String {
    match driver {
        DriverKind::Mysql => |s| quote_ident(DriverKind::Mysql, s),
        DriverKind::Postgres => |s| quote_ident(DriverKind::Postgres, s),
        DriverKind::Sqlite => |s| quote_ident(DriverKind::Sqlite, s),
    }
}

/// 末尾の `;` と空白を除いた文。
fn trim_stmt(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim_end()
}

/// `SELECT * FROM <ref> WHERE (c1) OR (c2) …` を [`OR_CHUNK`] 件ずつ読んで連結する。
async fn fetch_by_conds(
    conn: &Connection,
    database: Option<&str>,
    table_ref: &str,
    conds: &[String],
) -> crate::error::Result<Fetched> {
    let mut out = Fetched::default();
    for chunk in conds.chunks(OR_CHUNK) {
        let predicate = chunk
            .iter()
            .map(|c| format!("({c})"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let sql = format!("SELECT * FROM {table_ref} WHERE {predicate}");
        let res = conn.execute(&sql, database).await?;
        if out.columns.is_empty() {
            out.columns = res.columns;
        }
        out.rows.extend(res.rows);
    }
    Ok(out)
}

fn pk_signature(row: &[Value], pk_idx: &[usize]) -> String {
    pk_idx
        .iter()
        .map(|&i| format!("{:?}", row.get(i)))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

fn pk_indices(columns: &[Column], pk_columns: &[String]) -> Option<Vec<usize>> {
    let idx: Vec<usize> = pk_columns
        .iter()
        .filter_map(|p| {
            columns
                .iter()
                .position(|c| c.name == *p)
                .or_else(|| columns.iter().position(|c| c.name.eq_ignore_ascii_case(p)))
        })
        .collect();
    (idx.len() == pk_columns.len() && !idx.is_empty()).then_some(idx)
}

/// 主キー列が重複なく行を指しているか (重複は Undo が別の行を取り違えるので辞退する)。
fn pk_unique(rows: &[Vec<Value>], pk_idx: &[usize]) -> bool {
    let mut seen = std::collections::HashSet::with_capacity(rows.len());
    rows.iter().all(|r| seen.insert(pk_signature(r, pk_idx)))
}

/// 編集グループが主キー列を書き換える (行を追えなくなる) か。
fn sets_pk_column(groups: &[BulkUpdateGroup], pk_columns: &[String]) -> bool {
    groups.iter().any(|g| {
        g.set
            .iter()
            .any(|s| pk_columns.iter().any(|p| p.eq_ignore_ascii_case(&s.column)))
    })
}

/// 編集グループが SET する列 (重複なし)。
fn set_columns(groups: &[BulkUpdateGroup]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for g in groups {
        for s in &g.set {
            if !out.iter().any(|c| c.eq_ignore_ascii_case(&s.column)) {
                out.push(s.column.clone());
            }
        }
    }
    out
}

/// [`build_update_capture`] の結果。
#[derive(Debug)]
enum UpdateBuild {
    Capture(Box<WriteCapture>),
    /// 同値の上書きなどで変わった行が無い (辞退ではない。記録するものが無いだけ)。
    NoChange,
    /// 突き合わせできない (行数・列・主キーの食い違い、重複) ので記録しない。
    Decline,
}

/// UPDATE の before / after から `Update` 記録を組み立てる純関数。
///
/// 2 回の `SELECT *` の間に他者が**編集していない列**を変えても、その差分を記録に入れない:
/// 保存する before は「after 行のうち SET した列だけを読み取った before の値に戻した行」にする。
/// これで逆 SQL は編集列だけを戻し、Undo の衝突検出 (全列) は after と照合する。
/// MySQL の `ON UPDATE CURRENT_TIMESTAMP` 列のような副作用の列も巻き戻さない。
fn build_update_capture(
    table: &str,
    pk_columns: &[String],
    set_columns: &[String],
    before: &Fetched,
    after: &Fetched,
    expected: usize,
) -> UpdateBuild {
    let Some(idx) = pk_indices(&before.columns, pk_columns) else {
        return UpdateBuild::Decline;
    };
    let same_columns = before.columns.len() == after.columns.len()
        && before
            .columns
            .iter()
            .zip(&after.columns)
            .all(|(b, a)| b.name == a.name);
    if !same_columns
        || before.rows.len() != expected
        || after.rows.len() != expected
        || !pk_unique(&before.rows, &idx)
        || !pk_unique(&after.rows, &idx)
    {
        return UpdateBuild::Decline;
    }
    let set_idx: Vec<usize> = set_columns
        .iter()
        .filter_map(|c| {
            before
                .columns
                .iter()
                .position(|b| b.name.eq_ignore_ascii_case(c))
        })
        .collect();
    if set_idx.len() != set_columns.len() || set_idx.iter().any(|i| idx.contains(i)) {
        return UpdateBuild::Decline;
    }
    let after_by_pk: HashMap<String, &Vec<Value>> = after
        .rows
        .iter()
        .map(|r| (pk_signature(r, &idx), r))
        .collect();
    let mut b_rows = Vec::new();
    let mut a_rows = Vec::new();
    for b in &before.rows {
        let Some(a) = after_by_pk.get(&pk_signature(b, &idx)) else {
            return UpdateBuild::Decline;
        };
        if a.len() != b.len() {
            return UpdateBuild::Decline;
        }
        if set_idx.iter().all(|&i| a[i] == b[i]) {
            continue;
        }
        let mut restored = (*a).clone();
        for &i in &set_idx {
            restored[i] = b[i].clone();
        }
        b_rows.push(restored);
        a_rows.push((*a).clone());
    }
    if b_rows.is_empty() {
        return UpdateBuild::NoChange;
    }
    UpdateBuild::Capture(Box::new(build_capture(
        WriteKind::Update,
        table,
        pk_columns,
        &before.columns,
        b_rows,
        a_rows,
    )))
}

/// `DELETE FROM <ref> WHERE <cond>;` から `<cond>` を取り出す (フロントが生成する形のみ)。
fn delete_condition(table_ref: &str, sql: &str) -> Option<String> {
    let rest = trim_stmt(sql).strip_prefix("DELETE FROM ")?;
    let rest = rest.strip_prefix(table_ref)?;
    let cond = rest.strip_prefix(" WHERE ")?;
    (!cond.trim().is_empty()).then(|| cond.to_string())
}

/// `pk_columns` が表の実際の主キー列 (`columns` の `key = PRI`) と、大文字小文字を無視した
/// 集合として一致するか。
async fn pk_matches_table_metadata(
    conn: &Connection,
    database: Option<&str>,
    table: &str,
    pk_columns: &[String],
) -> bool {
    let Ok(cols) = conn.columns(database.unwrap_or_default(), table).await else {
        return false;
    };
    let actual: std::collections::BTreeSet<String> = cols
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.to_ascii_lowercase())
        .collect();
    let given: std::collections::BTreeSet<String> =
        pk_columns.iter().map(|c| c.to_ascii_lowercase()).collect();
    !actual.is_empty() && actual == given
}

/// 適用前の準備: 対象行を特定し、UPDATE / DELETE の before を読む。読み取りに失敗した部分は
/// 辞退する (エラーにしない)。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn prepare(
    session: &Session,
    database: Option<&str>,
    table_name: &str,
    table_ref: &str,
    pk_columns: &[String],
    groups: &[BulkUpdateGroup],
    update_sql: &[String],
    extra_statements: &[String],
    cfg: &BulkCaptureConfig,
) -> BulkCapturePlan {
    let driver = session.conn.driver_kind();
    let row_cap = cfg
        .row_cap
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_CAPTURE_ROW_CAP)
        .max(1);
    let mut plan = BulkCapturePlan::default();

    // 呼び出し側が渡した pk_columns が実際の主キーと集合として一致しなければ、Undo が行を
    // 取り違えうるので何も記録しない (メタデータを取れないときも辞退)。
    if !pk_matches_table_metadata(&session.conn, database, table_name, pk_columns).await {
        plan.declined += 1;
        return plan;
    }

    // UPDATE: 編集した行の主キー (重複は 1 つに)。
    let mut seen = std::collections::HashSet::new();
    let mut update_conds = Vec::new();
    for g in groups {
        if g.set.is_empty() {
            continue;
        }
        for key in &g.keys {
            if seen.insert(format!("{key:?}")) {
                update_conds.push(row_condition(driver, pk_columns, key));
            }
        }
    }
    // DELETE / INSERT の追加文を振り分ける。
    let mut delete_conds = Vec::new();
    let mut delete_sql = Vec::new();
    let mut insert_conds = Vec::new();
    let mut insert_sql = Vec::new();
    let mut insert_expected = 0usize;
    let mut insert_ok = true;
    let mut delete_ok = true;
    let quote = quote_for(driver);
    for sql in extra_statements {
        if let Some(cond) = delete_condition(table_ref, sql) {
            delete_conds.push(cond);
            delete_sql.push(sql.clone());
        } else if trim_stmt(sql).starts_with("INSERT INTO ") {
            let probe = format!("{} ON CONFLICT DO NOTHING", trim_stmt(sql));
            let anchor = parse_upsert(&probe).and_then(|h| {
                let n = h.tuple_count();
                h.anchor_where(pk_columns, quote).map(|w| (w, n))
            });
            match anchor {
                Some((w, n)) => {
                    insert_conds.push(w.trim_start_matches("WHERE ").to_string());
                    insert_expected += n;
                    insert_sql.push(sql.clone());
                }
                None => insert_ok = false,
            }
        } else {
            // 想定外の形の追加文は、DELETE / INSERT どちらの記録にも含められない。
            plan.declined += 1;
        }
    }
    if !insert_ok {
        // 1 文でも主キーを特定できないと、記録が実際の追加と食い違う (一部だけ Undo される)。
        plan.declined += 1;
        insert_conds.clear();
    }
    let total = update_conds.len() + delete_conds.len() + insert_expected;
    if total > row_cap {
        // 上限超過: 何も記録しない (一部だけの記録は Undo の範囲を誤らせる)。
        plan.declined += u32::from(!update_conds.is_empty())
            + u32::from(!delete_conds.is_empty())
            + u32::from(!insert_conds.is_empty());
        return plan;
    }

    if !update_conds.is_empty() {
        if sets_pk_column(groups, pk_columns) {
            plan.declined += 1;
        } else {
            match fetch_by_conds(&session.conn, database, table_ref, &update_conds).await {
                Ok(before)
                    if before.rows.len() == update_conds.len()
                        && pk_indices(&before.columns, pk_columns)
                            .is_some_and(|idx| pk_unique(&before.rows, &idx)) =>
                {
                    plan.update = Some(UpdatePart {
                        set_columns: set_columns(groups),
                        expected: update_conds.len(),
                        conds: update_conds,
                        before,
                        sql: update_sql.join("\n"),
                    });
                }
                _ => plan.declined += 1,
            }
        }
    }
    if !delete_conds.is_empty() && delete_ok {
        match fetch_by_conds(&session.conn, database, table_ref, &delete_conds).await {
            Ok(before)
                if before.rows.len() == delete_conds.len()
                    && pk_indices(&before.columns, pk_columns)
                        .is_some_and(|idx| pk_unique(&before.rows, &idx)) =>
            {
                plan.delete = Some(DeletePart {
                    before,
                    sql: delete_sql.join("\n"),
                });
            }
            _ => {
                delete_ok = false;
            }
        }
        if !delete_ok {
            plan.declined += 1;
        }
    }
    if !insert_conds.is_empty() {
        plan.insert = Some(InsertPart {
            conds: insert_conds,
            expected: insert_expected,
            sql: insert_sql.join("\n"),
        });
    }
    plan
}

#[allow(clippy::too_many_arguments)]
fn build_capture(
    kind: WriteKind,
    table: &str,
    pk_columns: &[String],
    columns: &[Column],
    before_rows: Vec<Vec<Value>>,
    after_rows: Vec<Vec<Value>>,
) -> WriteCapture {
    let rows_affected = before_rows.len().max(after_rows.len()) as u64;
    WriteCapture {
        kind,
        capturable: true,
        reason: None,
        table: Some(table.to_string()),
        primary_key: pk_columns.to_vec(),
        columns: columns.iter().map(|c| c.name.clone()).collect(),
        column_types: columns.iter().map(|c| c.type_name.clone()).collect(),
        before_rows,
        after_rows,
        rows_affected,
        companion: None,
    }
}

/// コミット後の仕上げ: after を読んで記録を組み立て、同じバッチ id で保存する。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn finish(
    plan: BulkCapturePlan,
    session: &Session,
    database: Option<&str>,
    table: &str,
    table_ref: &str,
    pk_columns: &[String],
    cfg: &BulkCaptureConfig,
) -> BulkCaptureOutcome {
    let BulkCapturePlan {
        update,
        delete,
        insert,
        mut declined,
    } = plan;
    let mut captures: Vec<(WriteKind, String, WriteCapture)> = Vec::new();

    if let Some(u) = update {
        let after = fetch_by_conds(&session.conn, database, table_ref, &u.conds)
            .await
            .ok();
        let built = after.map(|after| {
            build_update_capture(
                table,
                pk_columns,
                &u.set_columns,
                &u.before,
                &after,
                u.expected,
            )
        });
        match built {
            Some(UpdateBuild::Capture(c)) => captures.push((WriteKind::Update, u.sql, *c)),
            Some(UpdateBuild::NoChange) => {}
            Some(UpdateBuild::Decline) | None => declined += 1,
        }
    }
    // 同じ適用で削除と追加の主キーが重なると、バッチの Undo は (表, 主キー) の重複として拒否される。
    // 追加側を辞退して、削除だけを確実に取り消せるようにする。
    let deleted_sigs: std::collections::HashSet<String> = delete
        .as_ref()
        .and_then(|d| {
            pk_indices(&d.before.columns, pk_columns).map(|idx| {
                d.before
                    .rows
                    .iter()
                    .map(|r| pk_signature(r, &idx))
                    .collect()
            })
        })
        .unwrap_or_default();
    if let Some(d) = delete {
        let c = build_capture(
            WriteKind::Delete,
            table,
            pk_columns,
            &d.before.columns,
            d.before.rows,
            Vec::new(),
        );
        captures.push((WriteKind::Delete, d.sql, c));
    }
    if let Some(i) = insert {
        let built = async {
            let after = fetch_by_conds(&session.conn, database, table_ref, &i.conds)
                .await
                .ok()?;
            let idx = pk_indices(&after.columns, pk_columns)?;
            let overlaps = after
                .rows
                .iter()
                .any(|r| deleted_sigs.contains(&pk_signature(r, &idx)));
            (after.rows.len() == i.expected && pk_unique(&after.rows, &idx) && !overlaps).then(
                || {
                    build_capture(
                        WriteKind::Insert,
                        table,
                        pk_columns,
                        &after.columns,
                        Vec::new(),
                        after.rows,
                    )
                },
            )
        }
        .await;
        match built {
            Some(c) => captures.push((WriteKind::Insert, i.sql, c)),
            None => declined += 1,
        }
    }

    let mut out = BulkCaptureOutcome {
        recorded: 0,
        declined,
        batch_id: None,
    };
    if captures.is_empty() {
        return out;
    }
    let batch_id = new_batch_id();
    let db = database.filter(|d| !d.is_empty()).map(str::to_string);
    for (_, sql, capture) in &captures {
        let saved = persist_capture(
            session.skip_history,
            session.profile_id.clone(),
            session.conn.driver_kind(),
            db.clone(),
            sql.clone(),
            capture,
            cfg.retention_days.map(i64::from),
            Some(batch_id.clone()),
        )
        .await;
        if saved.is_some() {
            out.recorded += 1;
        } else {
            out.declined += 1;
        }
    }
    if out.recorded > 0 {
        out.batch_id = Some(batch_id);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_condition_extracts_where_for_frontend_shape() {
        assert_eq!(
            delete_condition("`d`.`t`", "DELETE FROM `d`.`t` WHERE `id` = 3;"),
            Some("`id` = 3".to_string())
        );
        assert_eq!(
            delete_condition("`d`.`t`", "DELETE FROM `d`.`u` WHERE id = 3;"),
            None
        );
        assert_eq!(delete_condition("`d`.`t`", "DELETE FROM `d`.`t`;"), None);
        assert_eq!(delete_condition("t", "INSERT INTO t (a) VALUES (1)"), None);
    }

    #[test]
    fn insert_anchor_requires_literal_primary_key() {
        let q = quote_for(DriverKind::Sqlite);
        let pk = vec!["id".to_string()];
        let probe = |sql: &str| {
            parse_upsert(&format!("{} ON CONFLICT DO NOTHING", trim_stmt(sql)))
                .and_then(|h| h.anchor_where(&pk, q).map(|w| (w, h.tuple_count())))
        };
        assert_eq!(
            probe("INSERT INTO t (id, name) VALUES (7, 'a');"),
            Some(("WHERE (\"id\" = 7)".to_string(), 1))
        );
        // 主キーを送らない (AUTO_INCREMENT) 行は特定できない。
        assert_eq!(probe("INSERT INTO t (name) VALUES ('a');"), None);
        assert_eq!(probe("INSERT INTO t (id) VALUES (NULL);"), None);
        // 複数行 INSERT は行数も返す。
        assert_eq!(
            probe("INSERT INTO t (id) VALUES (1), (2);").map(|(_, n)| n),
            Some(2)
        );
    }

    #[test]
    fn pk_helpers() {
        let cols = vec![
            Column {
                name: "ID".into(),
                type_name: "int".into(),
            },
            Column {
                name: "v".into(),
                type_name: "text".into(),
            },
        ];
        let idx = pk_indices(&cols, &["id".to_string()]).expect("pk");
        assert_eq!(idx, vec![0]);
        assert!(pk_indices(&cols, &["zz".to_string()]).is_none());
        let rows = vec![
            vec![Value::Int(1), Value::String("a".into())],
            vec![Value::Int(1), Value::String("b".into())],
        ];
        assert!(!pk_unique(&rows, &idx));
        assert!(pk_unique(&rows[..1], &idx));
    }

    fn cols(names: &[&str]) -> Vec<Column> {
        names
            .iter()
            .map(|n| Column {
                name: (*n).into(),
                type_name: "t".into(),
            })
            .collect()
    }

    fn fetched(names: &[&str], rows: Vec<Vec<Value>>) -> Fetched {
        Fetched {
            columns: cols(names),
            rows,
        }
    }

    fn s(v: &str) -> Value {
        Value::String(v.into())
    }

    fn build(before: &Fetched, after: &Fetched, set: &[&str], expected: usize) -> UpdateBuild {
        build_update_capture(
            "t",
            &["id".to_string()],
            &set.iter().map(|c| c.to_string()).collect::<Vec<_>>(),
            before,
            after,
            expected,
        )
    }

    #[test]
    fn update_capture_restores_only_set_columns_in_before() {
        // name を編集。他者が note (未編集列) を 2 回の読み取りの間に変えた。
        let before = fetched(
            &["id", "name", "note"],
            vec![vec![Value::Int(1), s("old"), s("n0")]],
        );
        let after = fetched(
            &["id", "name", "note"],
            vec![vec![Value::Int(1), s("new"), s("n1-by-other")]],
        );
        let UpdateBuild::Capture(c) = build(&before, &after, &["name"], 1) else {
            panic!("capture expected");
        };
        // before の note は after と同じ (他者の変更を巻き戻さない)、name だけが元の値。
        assert_eq!(
            c.before_rows,
            vec![vec![Value::Int(1), s("old"), s("n1-by-other")]]
        );
        assert_eq!(
            c.after_rows,
            vec![vec![Value::Int(1), s("new"), s("n1-by-other")]]
        );
        assert_eq!(c.kind, WriteKind::Update);
    }

    #[test]
    fn update_capture_pairs_rows_by_pk_not_order() {
        let before = fetched(
            &["id", "v"],
            vec![vec![Value::Int(1), s("a")], vec![Value::Int(2), s("b")]],
        );
        let after = fetched(
            &["id", "v"],
            vec![vec![Value::Int(2), s("B")], vec![Value::Int(1), s("A")]],
        );
        let UpdateBuild::Capture(c) = build(&before, &after, &["v"], 2) else {
            panic!("capture expected");
        };
        assert_eq!(c.before_rows[0], vec![Value::Int(1), s("a")]);
        assert_eq!(c.after_rows[0], vec![Value::Int(1), s("A")]);
        assert_eq!(c.before_rows[1], vec![Value::Int(2), s("b")]);
    }

    #[test]
    fn update_capture_same_value_is_no_change() {
        let f = fetched(&["id", "v"], vec![vec![Value::Int(1), s("a")]]);
        assert!(matches!(build(&f, &f, &["v"], 1), UpdateBuild::NoChange));
    }

    #[test]
    fn update_capture_declines_on_mismatch() {
        let one = fetched(&["id", "v"], vec![vec![Value::Int(1), s("a")]]);
        let new = fetched(&["id", "v"], vec![vec![Value::Int(1), s("b")]]);
        // 行数の食い違い。
        assert!(matches!(build(&one, &new, &["v"], 2), UpdateBuild::Decline));
        // 行が消えた (after に同じ主キーが無い)。
        let gone = fetched(&["id", "v"], vec![vec![Value::Int(9), s("b")]]);
        assert!(matches!(
            build(&one, &gone, &["v"], 1),
            UpdateBuild::Decline
        ));
        // 主キー重複。
        let dup = fetched(
            &["id", "v"],
            vec![vec![Value::Int(1), s("a")], vec![Value::Int(1), s("b")]],
        );
        assert!(matches!(build(&dup, &dup, &["v"], 2), UpdateBuild::Decline));
        // 列の食い違い。
        let other = fetched(&["id", "w"], vec![vec![Value::Int(1), s("b")]]);
        assert!(matches!(
            build(&one, &other, &["v"], 1),
            UpdateBuild::Decline
        ));
        // SET 列が見つからない。
        assert!(matches!(
            build(&one, &new, &["zz"], 1),
            UpdateBuild::Decline
        ));
    }

    #[test]
    fn update_capture_declines_when_set_touches_primary_key() {
        let one = fetched(&["id", "v"], vec![vec![Value::Int(1), s("a")]]);
        let new = fetched(&["id", "v"], vec![vec![Value::Int(1), s("b")]]);
        assert!(matches!(
            build(&one, &new, &["ID"], 1),
            UpdateBuild::Decline
        ));
    }
}
