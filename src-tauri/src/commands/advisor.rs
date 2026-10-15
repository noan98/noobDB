//! スキーマ健全性アドバイザ (#741) の IPC ラッパー。
//!
//! ライブセッションからテーブル/カラム/インデックス/外部キーのメタデータと
//! (縮退しうる) 未使用インデックス統計を集め、純ロジック (`db::advisor::analyze`)
//! に渡してレポートを返す。すべて読み取りの introspection なので `read_only`
//! セッションでも許可する (適用は生成 DDL のエディタ挿入 → 既存安全網経由)。

use std::collections::{HashMap, HashSet};

use tauri::State;

use crate::advisor_ignore;
use crate::db::advisor::{
    analyze, diff_findings, AdvisorInput, HealthFinding, SchemaHealthReport, TableMeta,
};
use crate::db::types::{IndexInfo, TableColumnInfo};
use crate::db::Connection;
use crate::error::{AppError, Result};
use crate::state::{AdvisorSnapshot, AppState};

/// `db` のスキーマを診断し、健全性の指摘リストを返す。ビューは
/// `schema_objects` の一覧で除外し、ベーステーブルのみを対象にする (PK 欠落
/// ルールがビューで誤検出しないように)。メタデータ収集は列・インデックスとも
/// DB 全体を 1 問い合わせで取得する (#1255)。
///
/// 診断結果は (#1621) 利用者が「対応しない」にした指摘を `ignored` に振り分け、前回診断
/// (同じセッション・同じデータベース、メモリ上の直近 1 件) があれば `diff` に新規 / 解消を載せる。
#[tauri::command]
pub async fn analyze_schema_health(
    session_id: String,
    database: String,
    state: State<'_, AppState>,
) -> Result<SchemaHealthReport> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let report = collect_and_analyze(&session.conn, &database).await?;
    let profile_id = session.profile_id.clone();
    let db = database.clone();
    let keys = crate::commands::assertions::blocking_store(move || {
        advisor_ignore::ignored_keys(profile_id.as_deref(), &db)
    })
    .await?;
    Ok(finalize_report(
        state.inner(),
        &session_id,
        &database,
        report,
        &keys,
    ))
}

/// 診断レポートに「対応しない」の振り分けと前回診断との差分を足し、今回分を前回として残す。
pub(crate) fn finalize_report(
    state: &AppState,
    session_id: &str,
    database: &str,
    mut report: SchemaHealthReport,
    ignored_keys: &HashSet<String>,
) -> SchemaHealthReport {
    let all = std::mem::take(&mut report.findings);
    let (active, ignored) = advisor_ignore::partition(all.clone(), ignored_keys);
    report.findings = active;
    report.ignored = ignored;
    // 最後の保存: 前回を取り出して今回を置く。ロックは短く保ち、await を跨がない。
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let previous = state
        .advisor_last
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            (session_id.to_string(), database.to_string()),
            AdvisorSnapshot {
                at: now,
                findings: all,
            },
        );
    report.diff =
        previous.map(|p| diff_findings(&p.findings, &p.at, &report.findings, &report.ignored));
    report
}

/// 指摘を「対応しない」にする (#1621)。次回以降の診断では本表から外れ、別枠に折りたたまれる。
/// 非秘密の JSON ストア (`advisor_ignores.json`) に (プロファイル, データベース, 指摘キー) を保存する。
#[tauri::command]
pub async fn ignore_advisor_finding(
    session_id: String,
    database: String,
    finding: HealthFinding,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let profile_id = session.profile_id.clone();
    crate::commands::assertions::blocking_store(move || {
        advisor_ignore::add(profile_id.as_deref(), &database, &finding)
    })
    .await
}

/// 「対応しない」を取り消して通常の指摘に戻す (#1621)。
#[tauri::command]
pub async fn unignore_advisor_finding(
    session_id: String,
    database: String,
    finding: HealthFinding,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let profile_id = session.profile_id.clone();
    crate::commands::assertions::blocking_store(move || {
        advisor_ignore::remove(profile_id.as_deref(), &database, &finding)
    })
    .await
}

/// Tauri State を介さずに診断のコア経路を駆動する。統合テスト (`__test_api`) と
/// コマンド本体が共有する。
pub(crate) async fn collect_and_analyze(
    conn: &Connection,
    database: &str,
) -> Result<SchemaHealthReport> {
    let driver = conn.driver_kind();

    // 互いに依存しない 6 本の取得を同時に発行して往復待ちを重ねる (#1609)。
    // 以前は 1 本ずつ await しており、RTT の高いリモート DB では往復が 6 倍になっていた。
    // 列とインデックスは DB 全体を 1 問い合わせずつで取得する (#1255)。
    let (all_tables, objects, columns, indexes, foreign_keys, unused) = tokio::try_join!(
        conn.tables(database),
        conn.schema_objects(database),
        conn.columns_for_database(database),
        conn.indexes_for_database(database),
        conn.foreign_keys(database),
        conn.unused_indexes(database),
    )?;
    // ベーステーブルのみを対象にする。`tables` はビュー/マテビューも含むため、
    // `schema_objects` の view / materialized_view を引いて除外する。
    let view_names: HashSet<String> = objects
        .iter()
        .filter(|o| o.kind == "view" || o.kind == "materialized_view")
        .map(|o| o.name.clone())
        .collect();
    let mut columns_by_table: HashMap<String, Vec<TableColumnInfo>> =
        columns.into_iter().map(|t| (t.name, t.columns)).collect();
    let mut indexes_by_table: HashMap<String, Vec<IndexInfo>> =
        indexes.into_iter().map(|t| (t.name, t.indexes)).collect();

    let mut tables = Vec::new();
    for name in all_tables {
        if view_names.contains(&name) {
            continue;
        }
        tables.push(TableMeta {
            columns: columns_by_table.remove(&name).unwrap_or_default(),
            indexes: indexes_by_table.remove(&name).unwrap_or_default(),
            name,
        });
    }

    Ok(analyze(&AdvisorInput {
        driver,
        tables,
        foreign_keys,
        unused,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::advisor::{RuleId, Severity};
    use crate::db::DriverKind;

    fn finding(table: &str) -> HealthFinding {
        HealthFinding {
            rule: RuleId::MissingPrimaryKey,
            severity: Severity::Low,
            table: table.into(),
            columns: vec![],
            context: vec![],
            fix_ddl: None,
            fix_ddl_online: None,
            statistical: false,
            size_bytes: None,
        }
    }

    fn report(tables: &[&str]) -> SchemaHealthReport {
        SchemaHealthReport {
            driver: DriverKind::Sqlite,
            tables_analyzed: tables.len(),
            findings: tables.iter().map(|t| finding(t)).collect(),
            skipped: vec![],
            table_plans: vec![],
            ignored: vec![],
            diff: None,
        }
    }

    // 初回は差分なし。2 回目から「新規」「解消」が出て、別セッション・別 DB の履歴とは混ざらない。
    #[test]
    fn finalize_report_diffs_against_the_previous_run_per_session_and_database() {
        let state = AppState::default();
        let none = HashSet::new();
        let first = finalize_report(&state, "s1", "app", report(&["a", "b"]), &none);
        assert!(first.diff.is_none());

        let second = finalize_report(&state, "s1", "app", report(&["b", "c"]), &none);
        let diff = second.diff.expect("diff on re-run");
        assert_eq!(diff.new_indexes, vec![1], "c が新規");
        assert_eq!(diff.resolved.len(), 1);
        assert_eq!(diff.resolved[0].table, "a");
        assert_eq!(diff.unchanged, 1);

        // 別 DB / 別セッションは初回扱い。
        assert!(
            finalize_report(&state, "s1", "other", report(&["a"]), &none)
                .diff
                .is_none()
        );
        assert!(finalize_report(&state, "s2", "app", report(&["a"]), &none)
            .diff
            .is_none());
    }

    // 「対応しない」は ignored へ移り、解消扱いにもならない。
    #[test]
    fn finalize_report_moves_ignored_findings_and_does_not_count_them_resolved() {
        let state = AppState::default();
        let none = HashSet::new();
        finalize_report(&state, "s1", "app", report(&["a", "b"]), &none);
        let ignored: HashSet<String> = [finding("a").key()].into_iter().collect();
        let r = finalize_report(&state, "s1", "app", report(&["a", "b"]), &ignored);
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].table, "b");
        assert_eq!(r.ignored.len(), 1);
        assert_eq!(r.ignored[0].table, "a");
        let diff = r.diff.expect("diff");
        assert!(diff.resolved.is_empty());
        assert!(diff.new_indexes.is_empty());
        assert_eq!(diff.unchanged, 1);
    }
}
