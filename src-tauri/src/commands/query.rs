use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::refresh_diff::{PatchRun, RefreshBuilder};
use crate::db::result_store::ResultBuilder;
use crate::db::stream_batch::{StreamBatcher, StreamStats, StreamStatsSnapshot};
use crate::db::tx_options::{TxIsolation, TxOptions};
use crate::db::types::{Column, QueryResult, ServerMessage, StreamBatch, Value};
use crate::db::{apply_auto_limit_for, is_read_only_sql_for, DriverKind};
use crate::error::{AppError, Result};
use crate::history::store as history_store;
use crate::history::NewHistoryEntry;
use crate::perf;
use crate::state::{AppState, Session, StreamHandle, StreamKind};

/// Returns `Err(AppError::ReadOnly)` when the session is RO and `sql` is not
/// strictly read-only. Used at every query entry point (and the streaming
/// export path in `commands::export`).
pub(crate) fn ensure_allowed_for_session(session: &Session, sql: &str) -> Result<()> {
    if session.read_only && !is_read_only_sql_for(session.conn.driver_kind(), sql) {
        // 緊急クエリ実行モード: 読み取り専用セッションでも、ユーザが明示的に
        // 有効化したときだけ書き込み文を通す (`set_emergency_mode` 参照)。
        // 監査の手がかりとしてログには必ず残す。
        if session.emergency_write_active() {
            tracing::warn!(
                session_id = %session.id,
                sql = %sql_summary(sql),
                "emergency mode: allowing a non-read-only statement on a read-only session"
            );
            return Ok(());
        }
        tracing::warn!(
            session_id = %session.id,
            sql = %sql_summary(sql),
            "read-only guard rejected a non-read-only statement"
        );
        return Err(AppError::ReadOnly(
            "read-only profile: only SELECT / SHOW / DESCRIBE / EXPLAIN / WITH are allowed".into(),
        ));
    }
    Ok(())
}

/// 読み取り専用セッションの「緊急クエリ実行モード」を切り替える (#emergency-mode)。
///
/// 有効な間は `ensure_allowed_for_session` が書き込み文を通すため、緊急対応の
/// UPDATE などを別プロファイルで繋ぎ直さずに実行できる。適用範囲は SQL 実行経路
/// (`run_query` / `run_query_transaction` / `run_query_stream` / 明示トランザク
/// ション) のみで、CSV インポート・同期適用・`kill_processes` の read-only 拒否は
/// 変わらない。フラグはセッション在命中のみ有効で、切断・再接続 (`reconnect` の
/// セッション差し替え) で必ずオフに戻る。
///
/// 有効化の合意 (接続先名のタイプ確認) はフロントエンドのダイアログが担う UI
/// レベルの安全網であり、`confirm_writes` と同じ強制レベル (CLAUDE.md 参照)。
/// この IPC を直接呼べば確認なしに有効化できるため、確実な書き込み禁止には
/// DB 側の権限設定を併用すること。
#[tauri::command]
pub async fn set_emergency_mode(
    session_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    set_emergency_mode_inner(state.inner(), &session_id, enabled).await
}

/// Core of [`set_emergency_mode`] decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path. See [`run_query_inner`].
pub(crate) async fn set_emergency_mode_inner(
    state: &AppState,
    session_id: &str,
    enabled: bool,
) -> Result<()> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    // 読み書き可能なセッションで有効化しても意味がない (ガード自体が無い) ので、
    // フロント側の状態管理バグを早期に露見させるためエラーにする。無効化は
    // 冪等な後始末として常に許可する。
    if enabled && !session.read_only {
        return Err(AppError::InvalidInput(
            "emergency mode is only applicable to read-only sessions".into(),
        ));
    }
    session.set_emergency_write(enabled);
    if enabled {
        tracing::warn!(session_id = %session.id, "emergency write mode enabled");
    } else {
        tracing::info!(session_id = %session.id, "emergency write mode disabled");
    }
    Ok(())
}

/// Backend-enforced read-only guard for scheduled re-execution (auto-refresh).
///
/// Auto-refresh polls a statement on a timer with no human in the loop, so it
/// must never run a write — unlike interactive runs, the UI confirmation gates
/// (`confirmDangerousQueries` / production write approval) never fire here.
/// This is enforced for *every* session regardless of the profile's `read_only`
/// flag, so even a writable session can only auto-refresh SELECT-shaped SQL.
///
/// `driver` selects the string-escaping rules the read-only analysis assumes
/// (#852) — the caller passes the session's own driver.
fn ensure_auto_refresh_read_only(driver: DriverKind, sql: &str) -> Result<()> {
    if !is_read_only_sql_for(driver, sql) {
        return Err(AppError::ReadOnly(
            "auto-refresh allows only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)"
                .into(),
        ));
    }
    Ok(())
}

/// Backend-enforced read-only guard for cross-environment broadcast execution
/// (#738). A broadcast fans one statement out to several sessions at once
/// (possibly across different profiles/permission levels), so the caller
/// pins it to read-only regardless of any single session's `read_only` flag —
/// mirroring [`ensure_auto_refresh_read_only`]'s reasoning for scheduled
/// re-execution. The frontend already blocks non-read-only SQL before firing
/// a broadcast, but this is the backend-enforced half of that guarantee.
/// `driver` selects the string-escaping rules the read-only analysis assumes
/// (#852), same as [`ensure_auto_refresh_read_only`].
///
/// EXPLAIN の実測モード (`EXPLAIN ANALYZE`, #1164) も同じ `force_read_only`
/// 経路を使う。`ANALYZE` は SQL を**実際に実行する**ので、対象が書き込みだと
/// 本当にデータが変わる。`EXPLAIN` は許可プレフィックスだが本文の書き込み
/// キーワード走査が効くため、`EXPLAIN ANALYZE DELETE ...` は拒否される。
pub(crate) fn ensure_broadcast_read_only(driver: DriverKind, sql: &str) -> Result<()> {
    if !is_read_only_sql_for(driver, sql) {
        return Err(AppError::ReadOnly(
            "forced read-only execution (broadcast / EXPLAIN ANALYZE) allows only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)"
                .into(),
        ));
    }
    Ok(())
}

/// Collapses `sql` to a short, single-line summary for logging. Never used at
/// `info` level — the full statement (which may carry sensitive literals) is
/// only ever surfaced at `debug` and is truncated here regardless.
fn sql_summary(sql: &str) -> String {
    const MAX: usize = 80;
    let one_line = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > MAX {
        let head: String = one_line.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

#[tauri::command]
pub async fn run_query(
    session_id: String,
    sql: String,
    database: Option<String>,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    run_query_inner(state.inner(), &session_id, &sql, database.as_deref()).await
}

/// Core of [`run_query`] decoupled from Tauri's `State` wrapper so integration
/// tests can drive the exact command path (session lookup + read-only guard +
/// execute) without standing up a Tauri runtime. The `#[tauri::command]`
/// wrapper above is intentionally a one-liner over this.
pub(crate) async fn run_query_inner(
    state: &AppState,
    session_id: &str,
    sql: &str,
    database: Option<&str>,
) -> Result<QueryResult> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    ensure_allowed_for_session(&session, sql)?;
    let driver = session.conn.driver_kind();
    // 計測 (#1094): SQL 実行 + Rust 側デコードの所要時間を perf ログへ (計測 OFF
    // なら Span::start が Instant::now すら呼ばず、log_query_execute も即 return)。
    let perf_span = perf::Span::start();
    // Query Result Cache (#1097): 読み取り専用と判定できる SQL だけがキャッシュを
    // consult する (`QueryResultCache::get_or_fetch` 内部の判定)。書き込み文は
    // 素通しでそのまま実行される — 対象・キー設計はモジュールドキュメント参照。
    let result = session
        .query_cache
        .get_or_fetch(driver, database, sql, || {
            session.conn.execute(sql, database)
        })
        .await;
    if let Ok(r) = &result {
        perf::log_query_execute(
            &session.id,
            perf_span.elapsed_ms(),
            r.rows.len(),
            r.columns.len(),
        );
    }
    if result.is_ok() {
        invalidate_caches_after_success(&session, sql).await;
    }
    result
}

/// 書き込み文の**成功後**にセッションのキャッシュ (Schema Cache / Query Result Cache)
/// を無効化する共通処理 (#1220)。`run_query` とストリーミング経路 (`spawn_query_stream`)
/// の両方がここを通ることで、片方だけ invalidate が抜けるドリフトを防ぐ。
///
/// - Schema Cache (#1097): DDL 相当 (`sql_may_change_schema`) なら丸ごと invalidate。
///   判定は実行前ではなく成功後に行う — 失敗した DDL でキャッシュを無駄に破棄しないため。
/// - Query Result Cache (#1097): DDL/DML を問わず書き込み (読み取り専用でない文) なら
///   丸ごと invalidate (Schema Cache と違い DML でも stale になるため対象が広い)。
///
/// `sql` は auto-limit 適用前の元の文を渡す (LIMIT の注入は判定を変えない)。
pub(crate) async fn invalidate_caches_after_success(session: &Session, sql: &str) {
    let driver = session.conn.driver_kind();
    if crate::db::sql_may_change_schema(driver, sql) {
        session.schema_cache.invalidate_all().await;
    }
    if !crate::db::is_read_only_sql_for(driver, sql) {
        session.query_cache.invalidate_all().await;
    }
}

/// 値ピッカー (#1067) の候補取得 1 回で返す行数の既定値と上限。フロントが
/// `row_cap` を渡さない/大きすぎる値を渡しても、この上限を超えて fetch しない。
const LOOKUP_DEFAULT_ROWS: usize = 200;
const LOOKUP_MAX_ROWS: usize = 1000;

/// セル編集・行追加のスマート値ピッカー (#1067) が、FK 参照先の候補値や
/// ENUM / CHECK 制約の許可値を引くための**読み取り専用**クエリ実行。
///
/// `run_query` との違い:
/// - セッションの `read_only` フラグに関係なく、常に読み取り専用の文だけを通す
///   (候補取得は人の確認を挟まずに裏で走るため、書き込み文が紛れ込む余地を
///   バックエンドで塞ぐ。自動更新 / ブロードキャストと同じ考え方)。緊急クエリ
///   実行モードでも緩めない。
/// - `row_cap` (既定 200・上限 1000) で自動 LIMIT/TOP を挿入し、さらに結果行も
///   その件数で切り詰める — 大テーブルで無制限 fetch しない。
/// - `query_timeout_secs` (設定の「クエリタイムアウト」) で全体を打ち切る。
/// - クエリ履歴・結果キャッシュには載せない (入力補助の裏方クエリで、ユーザの
///   実行履歴を汚さないため)。
#[tauri::command]
pub async fn run_lookup_query(
    session_id: String,
    sql: String,
    database: Option<String>,
    query_timeout_secs: Option<u64>,
    row_cap: Option<u32>,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    run_lookup_query_inner(
        state.inner(),
        &session_id,
        &sql,
        database.as_deref(),
        query_timeout_secs,
        row_cap,
    )
    .await
}

/// Core of [`run_lookup_query`] decoupled from Tauri's `State` wrapper (see
/// [`run_query_inner`]).
pub(crate) async fn run_lookup_query_inner(
    state: &AppState,
    session_id: &str,
    sql: &str,
    database: Option<&str>,
    query_timeout_secs: Option<u64>,
    row_cap: Option<u32>,
) -> Result<QueryResult> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let driver = session.conn.driver_kind();
    if !is_read_only_sql_for(driver, sql) {
        tracing::warn!(
            session_id = %session.id,
            sql = %sql_summary(sql),
            "value lookup rejected a non-read-only statement"
        );
        return Err(AppError::ReadOnly(
            "value lookup allows only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)"
                .into(),
        ));
    }
    let cap = row_cap
        .map(|n| n as usize)
        .unwrap_or(LOOKUP_DEFAULT_ROWS)
        .clamp(1, LOOKUP_MAX_ROWS);
    let limited = apply_auto_limit_for(driver, sql, cap);
    let effective_sql = limited.as_deref().unwrap_or(sql);
    let exec = session.conn.execute(effective_sql, database);
    let mut result = match query_timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(std::time::Duration::from_secs(secs), exec).await {
                Ok(res) => res?,
                Err(_) => return Err(AppError::Timeout(secs)),
            }
        }
        _ => exec.await?,
    };
    // 利用者が既に LIMIT を書いていて自動 LIMIT が挿入されなかった場合でも、
    // 返す行数は必ず上限で切る (フロントの SQL 生成に不備があっても UI を
    // 大量行で埋めない二重の安全網)。
    result.rows.truncate(cap);
    Ok(result)
}

/// Applies `statements` as a single all-or-nothing transaction. Every
/// statement is checked against the read-only gate first, then the whole
/// batch is committed together; if any statement fails the backend rolls the
/// transaction back so no partial edit is left behind. Returns an empty
/// `QueryResult` carrying the total `rows_affected`.
#[tauri::command]
pub async fn run_query_transaction(
    session_id: String,
    statements: Vec<String>,
    database: Option<String>,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    run_query_transaction_inner(state.inner(), session_id, statements, database).await
}

/// Core of [`run_query_transaction`] decoupled from Tauri's `State` wrapper so
/// integration tests can exercise the per-statement read-only guard on the real
/// command path. See [`run_query_inner`].
pub(crate) async fn run_query_transaction_inner(
    state: &AppState,
    session_id: String,
    statements: Vec<String>,
    database: Option<String>,
) -> Result<QueryResult> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    for sql in &statements {
        ensure_allowed_for_session(&session, sql)?;
    }
    tracing::debug!(
        session_id = %session.id,
        statements = statements.len(),
        database = ?database,
        "transaction starting"
    );
    let started = std::time::Instant::now();
    let result = session
        .conn
        .execute_transaction(&statements, database.as_deref())
        .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match &result {
        Ok(affected) => tracing::debug!(
            session_id = %session.id,
            elapsed_ms,
            rows_affected = *affected,
            "transaction committed"
        ),
        Err(e) => tracing::warn!(
            session_id = %session.id,
            error = %e,
            "transaction failed and was rolled back"
        ),
    }
    // The cell-edit Apply path is a primary write entry point, so record the
    // generated statements to history for auditability (skip_history honoured).
    let sql_text = statements.join("\n");
    match &result {
        Ok(affected) => {
            record_write_history(
                &session,
                sql_text,
                database.as_deref(),
                Some(*affected as i64),
                Some(elapsed_ms as i64),
                None,
            )
            .await
        }
        Err(e) => {
            record_write_history(
                &session,
                sql_text,
                database.as_deref(),
                None,
                None,
                Some(e.to_string()),
            )
            .await
        }
    }
    // Schema Cache (#1097): まとめて実行した文のいずれか 1 つでも DDL 相当なら
    // (どれがどのテーブルに効くかまでは解析しないので) 接続単位で丸ごと
    // invalidate する。cell-edit の Apply (通常は DML のみ) では対象外のまま
    // 高速パスを保つ一方、AlterTableModal / CreateIndexModal が生成する
    // ALTER/CREATE 文の適用はここを必ず通る。
    if result.is_ok() {
        let driver = session.conn.driver_kind();
        if statements
            .iter()
            .any(|sql| crate::db::sql_may_change_schema(driver, sql))
        {
            session.schema_cache.invalidate_all().await;
        }
        // Query Result Cache (#1097): 束ねた文のいずれか 1 つでも書き込み
        // (DDL/DML 問わず) なら丸ごと invalidate する。cell-edit の Apply は
        // 通常 DML のみだが、Schema Cache と違い DML でも対象になるため、ここは
        // 「DDL 相当」ではなく「読み取り専用でない」で判定する。
        if statements
            .iter()
            .any(|sql| !crate::db::is_read_only_sql_for(driver, sql))
        {
            session.query_cache.invalidate_all().await;
        }
    }
    let affected = result?;
    Ok(QueryResult::empty(affected, elapsed_ms))
}

// ── 明示トランザクションモード ──
//
// BEGIN で専用接続を確保し、その接続で文を逐次実行して、COMMIT/ROLLBACK で確定/破棄
// する。フロントはトランザクションが有効な間、エディタの実行を `run_in_transaction`
// 経由に切り替える (通常のストリーミング経路はプールの別接続を使うため tx に乗らない)。

/// 明示トランザクションを開始する。`database` は接続のスキーマ/DB コンテキスト。
/// `isolation` / `read_only` は任意 (省略時はサーバ既定)。SQLite は非対応でエラー (#1166)。
#[tauri::command]
pub async fn begin_transaction(
    session_id: String,
    database: Option<String>,
    isolation: Option<TxIsolation>,
    read_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let opts = TxOptions {
        isolation,
        read_only: read_only.unwrap_or(false),
    };
    session
        .conn
        .begin_transaction_with(database.as_deref(), opts)
        .await?;
    tracing::info!(session_id = %session_id, "explicit transaction begun");
    Ok(())
}

/// 明示トランザクション内で 1 文を実行する。読み取り専用ガードは通常実行と同じく適用。
#[tauri::command]
pub async fn run_in_transaction(
    session_id: String,
    sql: String,
    state: State<'_, AppState>,
) -> Result<QueryResult> {
    run_in_transaction_inner(state.inner(), &session_id, &sql).await
}

/// Core of [`run_in_transaction`] decoupled from Tauri's `State` wrapper so
/// integration tests can drive the exact command path (session lookup +
/// read-only guard + execute + cache invalidation) without standing up a
/// Tauri runtime. See [`run_query_inner`]'s doc comment for the pattern.
pub(crate) async fn run_in_transaction_inner(
    state: &AppState,
    session_id: &str,
    sql: &str,
) -> Result<QueryResult> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    ensure_allowed_for_session(&session, sql)?;
    let result = session.conn.execute_in_transaction(sql).await;
    if result.is_ok() {
        let driver = session.conn.driver_kind();
        // Schema Cache (#1097): 明示トランザクション内の DDL は、後で ROLLBACK
        // される可能性があるため理論上は invalidate しすぎ (無駄な再取得 1 回) に
        // なり得るが、COMMIT を待って invalidate すると `finish_transaction` 側で
        // どの文が DDL だったかを覚えておく必要が生じ複雑化するため、fail-closed
        // (stale を残さない) を優先してここで即時 invalidate する。ROLLBACK 時の
        // 「無駄な 1 回の再取得」は安全側のコストとして許容する。
        if crate::db::sql_may_change_schema(driver, sql) {
            session.schema_cache.invalidate_all().await;
        }
        // Query Result Cache (#1097): 同じ理由・同じ fail-closed 方針で、
        // 読み取り専用でない SQL (DDL/DML 問わず) は COMMIT を待たず即時
        // invalidate する。
        if !crate::db::is_read_only_sql_for(driver, sql) {
            session.query_cache.invalidate_all().await;
        }
    }
    result
}

/// 明示トランザクションを確定 (commit=true) または破棄 (false) する。
#[tauri::command]
pub async fn finish_transaction(
    session_id: String,
    commit: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    session.conn.finish_transaction(commit).await?;
    tracing::info!(session_id = %session_id, commit, "explicit transaction finished");
    Ok(())
}

/// 明示トランザクション内に SAVEPOINT を作る (#1418)。名前は英数字と `_` のみ。
#[tauri::command]
pub async fn create_savepoint(
    session_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<()> {
    savepoint_inner(state.inner(), &session_id, &name, SavepointOp::Create).await
}

/// 指定 SAVEPOINT まで巻き戻す (#1418)。PostgreSQL の aborted 状態からも回復できる。
#[tauri::command]
pub async fn rollback_to_savepoint(
    session_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<()> {
    savepoint_inner(state.inner(), &session_id, &name, SavepointOp::RollbackTo).await
}

/// 指定 SAVEPOINT を解放する (#1418)。それより新しい SAVEPOINT も同時に消える。
#[tauri::command]
pub async fn release_savepoint(
    session_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<()> {
    savepoint_inner(state.inner(), &session_id, &name, SavepointOp::Release).await
}

#[derive(Clone, Copy)]
pub(crate) enum SavepointOp {
    Create,
    RollbackTo,
    Release,
}

/// SAVEPOINT 系 3 コマンドの共通コア。SAVEPOINT 自体はデータを書かないため
/// 読み取り専用ガードは通さない (READ ONLY トランザクションでも使える)。
/// 書き込み文の拒否は `run_in_transaction` 側の既存ガードが担う。
pub(crate) async fn savepoint_inner(
    state: &AppState,
    session_id: &str,
    name: &str,
    op: SavepointOp,
) -> Result<()> {
    let session = state
        .get(session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    let driver = session.conn.driver_kind();
    let sql = match op {
        SavepointOp::Create => crate::db::savepoint::create_sql(driver, name)?,
        SavepointOp::RollbackTo => crate::db::savepoint::rollback_to_sql(driver, name)?,
        SavepointOp::Release => crate::db::savepoint::release_sql(driver, name)?,
    };
    session.conn.execute_tx_control(&sql).await?;
    Ok(())
}

// 構造体・フィールドの `pub` は #825 の zod ⇔ serde ゴールデン
// (`serde_schema_parity.rs`) が `__test_api` 経由で代表インスタンスを組み立てる
// ためのもの。IPC 経路としては引き続き非公開モジュール内に留まる (#824 の
// LogView と同じ最小限の可視性拡張パターン)。
//
// #1096: `run_query_stream` / `preview_query_stream` は従来
// `query-stream:columns` / `:rows` / `:done` / `:error` / `:cancelled`
// (preview は `preview-stream:meta` / `:before-rows` / `:after-rows` / `:done` /
// `:error` / `:cancelled`) という**個別の名前付きイベント**を `app.emit()` で
// 全ウィンドウへブロードキャストしていた。`emit()` はペイロードを JSON へ整形して
// `webview.eval()` に丸ごとインライン展開する実装 (tauri 2.11 `manager/webview.rs`
// `emit_js`) なので、行チャンクのような大きなペイロードでも常にその場で JS 文字列へ
// 埋め込まれる。加えて各チャンクに `streamId` を乗せ、フロント側は 1 ストリームにつき
// 5〜6 本の `listen()` を張って `payload.streamId` で自分宛てかどうかを毎回判定して
// いた (他タブ/他ストリーム宛てのイベントも一旦全リスナーに配送されてから捨てられる)。
//
// Tauri の `Channel<T>` は 1 回の invoke に紐づく専用チャンネルで、
// (1) `streamId` をペイロードに含める必要が無くなる (チャンネル自体がスコープ)、
// (2) ペイロードが一定サイズを超えると `webview.eval()` へのインライン展開ではなく
//     fetch 経由の受け渡しに切り替わる (`ipc/channel.rs` `MAX_JSON_DIRECT_EXECUTE_
//     THRESHOLD` 分岐) ため大きな行チャンクほど効く、
// (3) 全ウィンドウへのブロードキャストと no-op な `streamId` 判定が消える、
// という 3 点で大量データ転送に向く。ここでは 1 ストリームにつき 1 チャンネルへ
// `kind` タグ付き enum (`QueryStreamMessage` / `PreviewStreamMessage`) を送ることで、
// 従来 5〜6 イベントに分かれていた emit を 1 本のチャンネル送信にまとめ、各メッセージ
// から `streamId` フィールドを削る (#1096 の「payload に含めるメタデータを整理し、
// 重複情報を削減」に対応)。Export/Dump/Import ストリームは引き続き
// `app.emit()` の名前付きイベントのまま (このコマンドの担当範囲外 — 詳細は
// `cancel_stream` のコメント参照)。
#[derive(Debug, Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QueryStreamMessage {
    Columns {
        columns: Vec<Column>,
    },
    Rows {
        rows: Vec<Vec<Value>>,
        /// この送信分までの**累積**逐次統計 (#1257)。フロントは `rowCount` が
        /// 手元の行数と一致するときだけ採用し、NULL 数・数値 min/max・重複行
        /// フラグの全行走査を省く。統計を持たない経路は `null`。
        stats: Option<StreamStatsSnapshot>,
    },
    /// 自動リフレッシュの差分パッチ (#1257)。`refresh_diff` 付きの再実行で、前回結果との
    /// 差分だけを返す。この場合 `Columns` / `Rows` は送られない。フロントは手元の前回
    /// 行配列に `runs` を適用して今回の結果を再構成する (`unchanged` なら何もしない)。
    Patch {
        total_rows: u64,
        unchanged: bool,
        removed_count: u64,
        runs: Vec<PatchRun>,
    },
    Done {
        total_rows: u64,
        rows_affected: u64,
        elapsed_ms: u64,
        /// True when the result had columns (a SELECT-shaped statement). False
        /// for INSERT/UPDATE/etc. so the UI can show "rows affected" instead.
        has_columns: bool,
        /// The row cap that was auto-injected for this run, or `null` when none
        /// was applied. Lets the UI show a "auto LIMIT N applied" badge.
        applied_auto_limit: Option<u64>,
        /// サーバが実行中に返した通知・警告 (PostgreSQL NOTICE/WARNING、MySQL
        /// SHOW WARNINGS)。SQLite と無い場合は空配列 (#1165)。
        server_messages: Vec<ServerMessage>,
        /// 全行を観測し終えた時点の逐次統計 (#1257)。`Rows` の累積統計と同じ形。
        /// 結果セットの無い文・統計を持たない経路は `null`。
        stats: Option<StreamStatsSnapshot>,
        /// 自動リフレッシュ差分 (#1257) の比較元として保持したスナップショットの ID。
        /// フロントは次回の再実行でこれを `prevSnapshotId` として返す。保持しなかった
        /// (要求なし・行数超過) ときは `null`。
        snapshot_id: Option<u64>,
        /// 実行した SQL が読み取り専用と判定できるか (`is_read_only_sql_for`)。フロントが
        /// 実行後に `isReadOnlySql` をマスク込みで再計算しなくて済むよう、バックエンドの
        /// 判定値をそのまま載せる (#1256)。
        read_only: bool,
        /// 実行した SQL がスキーマを変えうるか (`sql_may_change_schema`)。フロントの
        /// 補完用スキーマキャッシュを無効化する判定に使う (#1256)。
        schema_may_change: bool,
        /// 結果ハンドル (#1264)。全行をバックエンドに保持できたときのハンドル ID。保持しな
        /// かった (要求なし・小さい結果・上限超過・エラー) ときは `null` で、フロントは
        /// 行を JS から送る従来の経路を使う。
        result_id: Option<String>,
    },
    Error {
        error: String,
        /// True when the run was aborted by the execution-timeout guard rather
        /// than failing in the database, so the UI can show a dedicated
        /// timeout message.
        timed_out: bool,
        /// True when the failure means the DB connection was lost (server
        /// closed it, socket broke, network dropped). Lets the UI drop the
        /// now-dead session and prompt a reconnect instead of leaving it stuck
        /// on "connected".
        connection_lost: bool,
        /// Rows already delivered to the frontend (via `Rows` messages) before
        /// the run failed. Lets the UI tell a partial result apart from a
        /// complete one on timeout/error (#685).
        delivered_rows: u64,
    },
    /// Sent by `cancel_stream` when it successfully claims this stream (see
    /// [`crate::state::AppState::cancel_stream`] and the `on_cancel` callback
    /// wired up in `run_query_stream`), mirroring the `Error` variant's
    /// `delivered_rows` so the UI can tell a partial result apart from a
    /// complete one (#685).
    Cancelled {
        delivered_rows: u64,
    },
}

/// Preview (dry-run) stream sibling of [`QueryStreamMessage`] — same rationale,
/// carries `preview_query_stream`'s before/after batches instead.
#[derive(Debug, Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PreviewStreamMessage {
    Meta {
        target_table: Option<String>,
        columns: Vec<Column>,
        primary_key: Vec<String>,
        rows_affected: u64,
        elapsed_ms: u64,
        truncated: bool,
    },
    BeforeRows {
        rows: Vec<Vec<Value>>,
    },
    AfterRows {
        rows: Vec<Vec<Value>>,
    },
    Done {},
    Error {
        error: String,
        /// See [`QueryStreamMessage::Error`]. Preview also races a
        /// `query_timeout_secs` timeout (dry-running an UPDATE/DELETE can lock
        /// waiting rows), so this is carried here too even though the pre-#1096
        /// frontend `PreviewStreamErrorEvent` type never surfaced it.
        timed_out: bool,
        connection_lost: bool,
        delivered_rows: u64,
    },
    /// See [`QueryStreamMessage::Cancelled`].
    Cancelled {
        delivered_rows: u64,
    },
}

/// Still-`app.emit()`-based cancelled payload for the streams this file does
/// not own the transport of (Export/Dump/Import — see `cancel_stream`). Query
/// and Preview streams now report cancellation through their own Channel
/// (`QueryStreamMessage::Cancelled` / `PreviewStreamMessage::Cancelled`)
/// instead, dropping the redundant `stream_id` field a Channel doesn't need.
#[derive(Debug, Serialize, Clone)]
pub struct StreamCancelledEvent {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    #[serde(rename = "deliveredRows")]
    pub delivered_rows: u64,
}

const EV_EXPORT_CANCELLED: &str = "export-stream:cancelled";
const EV_DUMP_CANCELLED: &str = "dump-stream:cancelled";
const EV_IMPORT_CANCELLED: &str = "csv-import:cancelled";
const EV_SCRIPT_CANCELLED: &str = "sql-script:cancelled";
const EV_AI_CANCELLED: &str = "ai-stream:cancelled";
const EV_TRANSFER_CANCELLED: &str = "transfer-stream:cancelled";

/// 自動リフレッシュの差分パッチ (#1257) を要求するパラメータ。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshDiffRequest {
    /// タブを識別するキー (セッション ID と合わせてスナップショットを引く)。
    pub key: String,
    /// 結果列に対する主キー列の添字 (グリッドの `pkIndices` と同じ)。
    pub pk_indices: Vec<usize>,
    /// フロントが手元の行配列に紐づけて持っているスナップショット ID。無い/古いと
    /// パッチにならず全行ストリームになる。
    pub prev_snapshot_id: Option<u64>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_query_stream(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    sql: String,
    database: Option<String>,
    initial_batch: usize,
    chunk_size: usize,
    auto_limit: Option<usize>,
    query_timeout_secs: Option<u64>,
    auto_refresh: Option<bool>,
    force_read_only: Option<bool>,
    // #735 DML フライトレコーダ。true かつ単文の INSERT/UPDATE/DELETE のとき、
    // 通常のストリーミング実行の代わりに `Connection::capture_write` 経由で
    // before/after イメージの記録を試みつつ実行する (`spawn_captured_write`)。
    // 記録の成否に関わらず書き込み自体は行われ、`QueryStreamMessage` は通常経路と
    // 同じ形で送信されるためフロントの購読側 (`onDone`/`onError`) に変更は不要。
    capture: Option<bool>,
    capture_row_cap: Option<u32>,
    capture_retention_days: Option<u32>,
    // 自動リフレッシュの差分パッチ (#1257)。`auto_refresh` のときだけ有効。
    refresh_diff: Option<RefreshDiffRequest>,
    // 結果ハンドル (#1264)。true のとき、全行を合計メモリ上限の範囲でバックエンドにも保持し、
    // `Done` の `result_id` で返す (ソート・フィルタ・検索・エクスポートをバックエンドで行うため)。
    // 保持できなければ `result_id` は `null` で、従来どおり JS から行を送る経路になる。
    retain_result: Option<bool>,
    // #1096: フロントが `invoke` 前に生成し引数として渡す Tauri Channel。1
    // ストリームにつき 1 チャンネルなので、以後の columns/rows/done/error/
    // cancelled はすべてこのチャンネル経由で送る (旧 `query-stream:*` イベント群を
    // 置き換える — 上の `QueryStreamMessage` の doc コメント参照)。
    on_event: Channel<QueryStreamMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    ensure_allowed_for_session(&session, &sql)?;
    // Scheduled re-execution (auto-refresh) is read-only no matter the session.
    let auto_refresh = auto_refresh.unwrap_or(false);
    if auto_refresh {
        ensure_auto_refresh_read_only(session.conn.driver_kind(), &sql)?;
    }
    // Cross-environment broadcast execution (#738) is read-only no matter the
    // session, mirroring the auto-refresh guard above.
    if force_read_only.unwrap_or(false) {
        ensure_broadcast_read_only(session.conn.driver_kind(), &sql)?;
    }
    // `register_stream` をタスク本体の実行より前に完了させるためのゲート。
    // `tokio::spawn` は返り値の `JoinHandle` からしか `AbortHandle` を得られないため
    // 文字通り「spawn より前に register」することはできないが、タスク本体を
    // oneshot の受信待ちから始めれば、`register_stream` が完了するまでタスクの
    // 実処理 (延いては末尾の `forget_stream`) が走らないことを保証できる。これが
    // 無いと、SQL 即エラーのような速いタスクが `register_stream` より先に
    // `forget_stream` してしまい、既に完了したタスクの `AbortHandle` がマップに
    // 残り続け、以後その `stream_id` への `cancel_stream` が誤って `true` を返す
    // (逆に登録前に forget されると後続の同 stream_id 登録を消してしまう競合窓もある)。
    // oneshot は `register_stream` が発行したトークンそのものを運ぶ — タスクは
    // それを受け取った `forget_stream(&stream_id, token)` でしか自分の登録を
    // 消せない (#state.rs の I4 対応)。`stream_id` はクライアント (フロント) が
    // 指定する値で再利用がありうるため、トークン照合なしの無条件 `remove` だと
    // 「同じ id で登録された新しいタスクのエントリを、たまたま遅れて後始末した
    // 旧タスクが消してしまう」競合が起こり、以後 `cancel_stream` が
    // `{cancelled:false}` を返し続ける (DB 接続 / SSH トンネルを握ったままの
    // キャンセル不能なストリームが残る) ため。
    //
    // Shared counter incremented as row batches are emitted, so a cancel or
    // timeout can report how many rows had already reached the frontend
    // (#685). Cloned into the state map (read by `cancel_stream`) and into
    // the task itself (read when building the timeout/error event).
    let delivered_rows = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let delivered_rows_for_task = delivered_rows.clone();
    let capture_requested = capture.unwrap_or(false) && !auto_refresh;
    // `cancel_stream` (別の invoke — このタスクの外) が cancelled 通知を送れるよう、
    // チャンネルをもう 1 つ複製して `on_cancel` コールバックに閉じ込める。
    // `Channel<T>` は内部 `Arc` の clone (#ipc/channel.rs) なので複製自体は軽い。
    let cancel_channel = on_event.clone();
    let handle = tokio::spawn(async move {
        // 送信側 (下の register_stream 直後) が必ず送るので、Err は理論上起こらない
        // が、万一起きても panic せずタスクを静かに終わらせる (登録自体が無ければ
        // forget すべきエントリも無い)。
        let Ok(token) = ready_rx.await else {
            return;
        };
        if capture_requested
            && crate::db::classify_write_kind_for(session.conn.driver_kind(), &sql)
                != crate::db::WriteKind::Other
        {
            spawn_captured_write(
                app,
                session,
                stream_id_for_task,
                token,
                sql,
                database,
                capture_row_cap
                    .map(|n| n as usize)
                    .unwrap_or(crate::db::DEFAULT_CAPTURE_ROW_CAP),
                capture_retention_days.map(|n| n as i64),
                query_timeout_secs,
                delivered_rows_for_task,
                on_event,
            )
            .await;
            return;
        }
        spawn_query_stream(
            app,
            session,
            stream_id_for_task,
            token,
            sql,
            database,
            initial_batch,
            chunk_size,
            auto_limit,
            query_timeout_secs,
            auto_refresh,
            refresh_diff.filter(|_| auto_refresh),
            retain_result.unwrap_or(false),
            delivered_rows_for_task,
            on_event,
        )
        .await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows,
                kind: StreamKind::Query,
                on_cancel: Some(Box::new(move |delivered_rows| {
                    let _ = cancel_channel.send(QueryStreamMessage::Cancelled { delivered_rows });
                })),
            },
        )
        .await;
    // タスク本体の実行を許可する。register_stream が確実に先に完了している。
    let _ = ready_tx.send(token);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_query_stream(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    stream_token: u64,
    sql: String,
    database: Option<String>,
    initial_batch: usize,
    chunk_size: usize,
    auto_limit: Option<usize>,
    query_timeout_secs: Option<u64>,
    auto_refresh: bool,
    refresh_diff: Option<RefreshDiffRequest>,
    retain_result: bool,
    delivered_rows: Arc<AtomicU64>,
    on_event: Channel<QueryStreamMessage>,
) {
    tracing::debug!(
        session_id = %session.id,
        stream_id = %stream_id,
        database = ?database,
        sql = %sql_summary(&sql),
        "query stream starting"
    );
    // Rewrite the statement with an automatic LIMIT when requested and the SQL
    // is eligible. `sql` stays the original so history records what the user
    // actually typed; only `effective_sql` carries the injected cap.
    let (effective_sql, applied_auto_limit) = match auto_limit {
        Some(n) => match apply_auto_limit_for(session.conn.driver_kind(), &sql, n) {
            Some(rewritten) => (rewritten, Some(n as u64)),
            None => (sql.clone(), None),
        },
        None => (sql.clone(), None),
    };
    let send_id = stream_id.clone();
    let delivered_rows_cb = delivered_rows.clone();
    // 計測 (#1094): シリアライズ + IPC emit の所要時間と概算ペイロードサイズを
    // 積算する。計測 OFF なら record_emit はクロージャをそのまま実行するだけ。
    let stream_perf = perf::StreamAccumulator::new();
    // バッチ合流 (#1257): ドライバが 200 行ずつ渡してくるバッチを、初回だけ即送信し、
    // 以降は時間 / サイズ倍々で合流してから Channel へ送る。`execute_stream` の
    // future は `Send` でなければならないので `RefCell` ではなく `Mutex` (競合は無い)。
    let batcher = Mutex::new(StreamBatcher::new(chunk_size));
    // 自動リフレッシュ差分 (#1257)。前回スナップショットは ID が一致するものだけ使う。
    let refresh_key = refresh_diff
        .as_ref()
        .map(|r| format!("{}\u{1}{}", session.id, r.key));
    let refresh_prev = match (&refresh_diff, &refresh_key, app.try_state::<AppState>()) {
        (Some(req), Some(key), Some(state)) => state
            .refresh_snapshots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_matching(key, req.prev_snapshot_id),
        _ => None,
    };
    let refresh: Mutex<Option<RefreshBuilder>> = Mutex::new(None);
    let stats = Mutex::new(StreamStats::new());
    // 結果ハンドル (#1264): 行を複製して溜める。合計上限を超えたら builder 自身が行を
    // 捨てるので、巨大な結果でもここのメモリは上限で頭打ちになる。
    let result_builder: Mutex<Option<ResultBuilder>> = Mutex::new(if retain_result {
        app.try_state::<AppState>().map(|state| {
            ResultBuilder::new(
                state
                    .results
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .limit(),
            )
        })
    } else {
        None
    });
    let send_rows = |rows: Vec<Vec<Value>>| -> Result<()> {
        // Count rows before sending so a cancel racing this exact
        // point never under-reports what actually reached the UI.
        let emitted_len = rows.len() as u64;
        delivered_rows_cb.fetch_add(emitted_len, Ordering::SeqCst);
        // 送信する合流バッチ単位で統計を更新する (累積が送信済み行数と常に一致する)。
        let snapshot = {
            let mut st = stats.lock().unwrap_or_else(|e| e.into_inner());
            st.observe(&rows);
            st.snapshot()
        };
        // 計測 (#1094): Channel 送信の所要時間と概算ペイロードサイズを積算。
        let approx_bytes = perf::approx_rows_bytes(&rows);
        stream_perf.record_emit(approx_bytes, || {
            on_event
                .send(QueryStreamMessage::Rows {
                    rows,
                    stats: Some(snapshot),
                })
                .map_err(|e| {
                    // The UI never received these rows; roll back the count.
                    delivered_rows_cb.fetch_sub(emitted_len, Ordering::SeqCst);
                    tracing::warn!(
                        stream_id = %send_id,
                        error = %e,
                        "failed to send rows message; aborting stream"
                    );
                    AppError::Other(format!("ipc channel send failed: {e}"))
                })
        })
    };
    let exec = session.conn.execute_stream(
        &effective_sql,
        database.as_deref(),
        initial_batch,
        chunk_size,
        |batch| match batch {
            StreamBatch::Columns(columns) => {
                // 自動リフレッシュ差分 (#1257): 前回スナップショットと列構成が一致すれば
                // パッチモードになり、列も行も送らない (フロントは前回の列をそのまま使う)。
                if let Some(req) = &refresh_diff {
                    let prev = refresh_prev.clone();
                    let builder = RefreshBuilder::new(prev, &req.pk_indices, &columns);
                    let is_patch = builder.as_ref().is_some_and(|b| b.is_patch());
                    *refresh.lock().unwrap_or_else(|e| e.into_inner()) = builder;
                    if is_patch {
                        return Ok(());
                    }
                }
                // 計測 (#1094): Channel 送信の所要時間と概算ペイロードサイズを積算。
                let approx_bytes = perf::approx_columns_bytes(&columns);
                stream_perf.record_emit(approx_bytes, || {
                    on_event
                        .send(QueryStreamMessage::Columns { columns })
                        .map_err(|e| {
                            tracing::warn!(
                                stream_id = %send_id,
                                error = %e,
                                "failed to send columns message; aborting stream"
                            );
                            AppError::Other(format!("ipc channel send failed: {e}"))
                        })
                })
            }
            StreamBatch::Rows(rows) => {
                // パッチモードでも全行を観測するので、ハンドルには常に今回の結果全体が入る。
                if let Some(b) = result_builder
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_mut()
                {
                    b.push_batch(&rows);
                }
                {
                    let mut guard = refresh.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(b) = guard.as_mut() {
                        for row in &rows {
                            b.observe(row);
                        }
                        if b.is_patch() {
                            // パッチモード: 行は送らず、統計だけ更新する (最終統計を Done で送る)。
                            drop(guard);
                            stats
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .observe(&rows);
                            return Ok(());
                        }
                    }
                }
                let ready = batcher
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(rows, Instant::now());
                match ready {
                    Some(rows) => send_rows(rows),
                    None => Ok(()),
                }
            }
        },
    );
    // When a positive timeout is configured, race the whole run against it.
    // Elapsing drops the streaming future, which returns the pooled connection
    // (mirroring the manual stop button), so the session stays usable.
    let result = match query_timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(std::time::Duration::from_secs(secs), exec).await {
                Ok(res) => res,
                Err(_) => Err(AppError::Timeout(secs)),
            }
        }
        _ => exec.await,
    };

    // 合流待ちで残った行を吐き出す (正常終了・DB エラー・タイムアウトのどれでも。
    // これで `delivered_rows` と UI が受け取った行数が一致する)。送信に失敗した
    // ときは結果がエラーに置き換わる。
    let flush_rest = batcher.lock().unwrap_or_else(|e| e.into_inner()).finish();
    let result = match (flush_rest, result) {
        (Some(rows), Ok(res)) => send_rows(rows).map(|()| res),
        (Some(rows), Err(e)) => {
            // 元のエラーを優先する。残り行の送信失敗は警告ログだけ (send_rows 内)。
            let _ = send_rows(rows);
            Err(e)
        }
        (None, r) => r,
    };
    let final_stats = stats.lock().unwrap_or_else(|e| e.into_inner()).snapshot();
    // 結果ハンドル (#1264): 成功した結果セットだけをストアへ確定する。`Done` より前に入れるので、
    // フロントは `result_id` を受け取った時点ですぐ使える。保持できなければ `None`。
    let result_id = match (
        &result,
        result_builder
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take(),
    ) {
        (Ok(res), Some(builder)) if !res.columns.is_empty() => {
            match (builder.finish(), app.try_state::<AppState>()) {
                (Some((rows, bytes)), Some(state)) => {
                    let inserted = state
                        .results
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(
                            stream_id.clone(),
                            session.id.clone(),
                            res.columns.len(),
                            rows,
                            bytes,
                        );
                    inserted.then(|| stream_id.clone())
                }
                _ => None,
            }
        }
        _ => None,
    };
    // 自動リフレッシュ差分 (#1257): 成功したときだけ新しいスナップショットを保管し、
    // パッチモードだったならパッチを作る。失敗・タイムアウト時は前回のまま残す。
    let mut snapshot_id: Option<u64> = None;
    let mut refresh_patch = None;
    if result.is_ok() {
        let builder = refresh.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let (Some(builder), Some(key)) = (builder, refresh_key.as_deref()) {
            let outcome = builder.finish();
            let unchanged = outcome.patch.as_ref().is_some_and(|p| p.unchanged);
            if let Some(state) = app.try_state::<AppState>() {
                let mut store = state
                    .refresh_snapshots
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if unchanged {
                    // 内容が同一なら前回のスナップショットをそのまま使い続ける。
                    snapshot_id = refresh_prev.as_ref().map(|p| p.id);
                } else if let Some(snap) = outcome.snapshot {
                    snapshot_id = Some(store.put(key, snap).id);
                } else {
                    store.remove(key);
                }
            }
            refresh_patch = outcome.patch;
        }
    }

    // Query Result Cache (#1097): このストリーミング経路自体はキャッシュを
    // 読み書きしない (Epic #1093 の「大量データを無制限に保持しない」方針との
    // 衝突を避けるため — モジュールドキュメント参照) が、書き込み文をここ経由で
    // 実行できる以上、`run_query` 側がキャッシュした結果を stale にしうるため
    // invalidate だけは行う。判定は元の `sql` (auto-limit 適用前) で行う —
    // LIMIT の注入は read-only 判定を変えないため `effective_sql` と等価。
    // 判定値は Done メッセージにも載せるので 1 度だけ計算する (#1256)。
    let read_only = crate::db::is_read_only_sql_for(session.conn.driver_kind(), &sql);
    let schema_may_change = crate::db::sql_may_change_schema(session.conn.driver_kind(), &sql);
    if result.is_ok() {
        // Schema Cache (#1220): DDL 成功後は SchemaCache も invalidate する。以前は
        // query_cache だけで、エディタ (ストリーミング) で流した ALTER / CREATE INDEX
        // 後もツリー・補完・describe が最大 TTL まで旧スキーマのままだった。
        invalidate_caches_after_success(&session, &sql).await;
    }

    match &result {
        Ok(res) => {
            tracing::debug!(
                session_id = %session.id,
                stream_id = %stream_id,
                elapsed_ms = res.elapsed_ms,
                rows = res.rows_affected,
                has_columns = !res.columns.is_empty(),
                "query stream completed"
            );
            // 計測 (#1094): SQL 実行 + emit の内訳を perf ログへ (計測 OFF なら no-op)。
            perf::log_query_stream(
                &session.id,
                &stream_id,
                res.elapsed_ms,
                stream_perf.emit_ms(),
                stream_perf.emit_calls(),
                stream_perf.payload_bytes_approx(),
                delivered_rows.load(Ordering::SeqCst),
                res.columns.len(),
            );
            if let Some(p) = refresh_patch {
                if let Err(e) = on_event.send(QueryStreamMessage::Patch {
                    total_rows: p.total_rows,
                    unchanged: p.unchanged,
                    removed_count: p.removed_count,
                    runs: p.runs,
                }) {
                    tracing::warn!(
                        session_id = %session.id,
                        stream_id = %stream_id,
                        error = %e,
                        "failed to send patch message"
                    );
                }
            }
            if let Err(e) = on_event.send(QueryStreamMessage::Done {
                total_rows: if res.columns.is_empty() {
                    0
                } else {
                    res.rows_affected
                },
                rows_affected: res.rows_affected,
                elapsed_ms: res.elapsed_ms,
                has_columns: !res.columns.is_empty(),
                applied_auto_limit: if res.columns.is_empty() {
                    None
                } else {
                    applied_auto_limit
                },
                server_messages: res.server_messages.clone(),
                stats: if res.columns.is_empty() {
                    None
                } else {
                    Some(final_stats)
                },
                snapshot_id,
                read_only,
                schema_may_change,
                result_id: result_id.clone(),
            }) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "failed to send done message"
                );
                // フロントに届かなかったハンドルは誰も解放できないので、ここで捨てる。
                if let (Some(id), Some(state)) = (&result_id, app.try_state::<AppState>()) {
                    state
                        .results
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .release(id);
                }
            }
        }
        Err(e) => {
            if matches!(e, AppError::Timeout(_)) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "query stream timed out"
                );
            } else {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "query stream failed"
                );
            }
            if let Err(send_err) = on_event.send(QueryStreamMessage::Error {
                error: e.to_string(),
                timed_out: matches!(e, AppError::Timeout(_)),
                connection_lost: e.is_connection_lost(),
                delivered_rows: delivered_rows.load(Ordering::SeqCst),
            }) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %send_err,
                    "failed to send error message"
                );
            }
        }
    }

    // Auto-refresh re-runs the same statement on a timer; recording every tick
    // would flood the history with duplicates, so polling never writes history.
    if !auto_refresh {
        record_history(&session, &sql, database.as_deref(), &result).await;
    }

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id, stream_token).await;
    }
}

/// The `run_query_stream` capture-enabled sibling of [`spawn_query_stream`]
/// (#735 DML flight recorder). Instead of streaming a result set, this
/// executes a single INSERT/UPDATE/DELETE via [`crate::db::Connection::
/// capture_write`] and sends the *same* `QueryStreamMessage::Done` / `Error`
/// messages `spawn_query_stream` would have — so the frontend's existing
/// `onDone`/`onError` subscription handles both paths without change. On
/// success, a capturable write is persisted to the local flight-recorder
/// store (best-effort; failing to persist never fails the run, the write
/// already happened).
#[allow(clippy::too_many_arguments)]
async fn spawn_captured_write(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    stream_token: u64,
    sql: String,
    database: Option<String>,
    row_cap: usize,
    retention_days: Option<i64>,
    query_timeout_secs: Option<u64>,
    delivered_rows: Arc<AtomicU64>,
    on_event: Channel<QueryStreamMessage>,
) {
    tracing::debug!(
        session_id = %session.id,
        stream_id = %stream_id,
        database = ?database,
        sql = %sql_summary(&sql),
        "captured write starting"
    );
    let started = std::time::Instant::now();
    let exec = session
        .conn
        .capture_write(&sql, database.as_deref(), row_cap);
    // Same timeout treatment as the ordinary streaming path (`spawn_query_stream`):
    // without this, a captured write could hang indefinitely — the capture
    // step itself runs a dry-run preview *and* the real write, so it is at
    // least as susceptible to a stuck query as a normal execution.
    let outcome = match query_timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(std::time::Duration::from_secs(secs), exec).await {
                Ok(res) => res,
                Err(_) => Err(AppError::Timeout(secs)),
            }
        }
        _ => exec.await,
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;

    // Query Result Cache (#1097): capture 対象は呼び出し元 (`run_query_stream`)
    // が `classify_write_kind_for != Other` を確認済み — つまり単文の
    // INSERT/UPDATE/DELETE であることが保証されているため、判定を挟まず成功時は
    // 常に invalidate する。
    if outcome.is_ok() {
        session.query_cache.invalidate_all().await;
    }

    match &outcome {
        Ok((result, capture)) => {
            tracing::debug!(
                session_id = %session.id,
                stream_id = %stream_id,
                elapsed_ms,
                rows = result.rows_affected,
                capturable = capture.capturable,
                "captured write completed"
            );
            if let Err(e) = on_event.send(QueryStreamMessage::Done {
                total_rows: 0,
                rows_affected: result.rows_affected,
                elapsed_ms,
                has_columns: false,
                applied_auto_limit: None,
                server_messages: result.server_messages.clone(),
                stats: None,
                snapshot_id: None,
                read_only: crate::db::is_read_only_sql_for(session.conn.driver_kind(), &sql),
                schema_may_change: crate::db::sql_may_change_schema(
                    session.conn.driver_kind(),
                    &sql,
                ),
                result_id: None,
            }) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "failed to send done message (captured write)"
                );
            }

            crate::flight_recorder::persist_capture(
                session.skip_history,
                session.profile_id.clone(),
                session.conn.driver_kind(),
                database.clone(),
                sql.clone(),
                capture,
                retention_days,
            )
            .await;
        }
        Err(e) => {
            tracing::warn!(
                session_id = %session.id,
                stream_id = %stream_id,
                error = %e,
                "captured write failed"
            );
            if let Err(send_err) = on_event.send(QueryStreamMessage::Error {
                error: e.to_string(),
                timed_out: matches!(e, AppError::Timeout(_)),
                connection_lost: e.is_connection_lost(),
                delivered_rows: delivered_rows.load(Ordering::SeqCst),
            }) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %send_err,
                    "failed to send error message (captured write)"
                );
            }
        }
    }

    let result_for_history: Result<QueryResult> = outcome.map(|(r, _)| r);
    record_history(&session, &sql, database.as_deref(), &result_for_history).await;

    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id, stream_token).await;
    }
}

/// Persists one executed statement to the query history. Best-effort: failures
/// are logged but never surfaced to the caller, and sessions flagged
/// `skip_history` are skipped entirely. Only the streaming run path records
/// history, so internal pagination/edit queries don't pollute it.
pub(crate) async fn record_history(
    session: &Session,
    sql: &str,
    database: Option<&str>,
    result: &Result<QueryResult>,
) {
    if session.skip_history {
        return;
    }
    let driver = session.conn.driver_kind().as_str().to_string();
    let database = database.map(str::to_string);
    let executed_at = chrono::Utc::now().to_rfc3339();
    let entry = match result {
        Ok(res) => {
            let has_columns = !res.columns.is_empty();
            NewHistoryEntry {
                profile_id: session.profile_id.clone(),
                driver,
                database,
                sql: sql.to_string(),
                rows: has_columns.then_some(res.rows_affected as i64),
                rows_affected: (!has_columns).then_some(res.rows_affected as i64),
                elapsed_ms: Some(res.elapsed_ms as i64),
                status: "ok".to_string(),
                error: None,
                executed_at,
            }
        }
        Err(e) => NewHistoryEntry {
            profile_id: session.profile_id.clone(),
            driver,
            database,
            sql: sql.to_string(),
            rows: None,
            rows_affected: None,
            elapsed_ms: None,
            status: "error".to_string(),
            error: Some(e.to_string()),
            executed_at,
        },
    };
    if let Err(e) = history_store::record(entry).await {
        tracing::warn!("failed to record query history: {e}");
    }
}

/// Records a single write to history for the non-streaming write paths (inline
/// cell-edit Apply and CSV import). These never return columns, so the count is
/// always carried in `rows_affected`. Best-effort and `skip_history`-aware,
/// mirroring [`record_history`]. Pass `rows_affected`/`elapsed_ms` on success
/// and `error` on failure (the unused side stays `None`).
pub(crate) async fn record_write_history(
    session: &Session,
    sql: String,
    database: Option<&str>,
    rows_affected: Option<i64>,
    elapsed_ms: Option<i64>,
    error: Option<String>,
) {
    if session.skip_history {
        return;
    }
    let status = if error.is_some() { "error" } else { "ok" };
    let entry = NewHistoryEntry {
        profile_id: session.profile_id.clone(),
        driver: session.conn.driver_kind().as_str().to_string(),
        database: database.map(str::to_string),
        sql,
        rows: None,
        rows_affected,
        elapsed_ms,
        status: status.to_string(),
        error,
        executed_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Err(e) = history_store::record(entry).await {
        tracing::warn!("failed to record query history: {e}");
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_query_stream(
    app: AppHandle,
    session_id: String,
    stream_id: String,
    sql: String,
    database: Option<String>,
    row_limit: usize,
    chunk_size: usize,
    // ドライラン (INSERT/UPDATE/DELETE をトランザクション内で実行してロールバック)
    // にも通常実行と同じ全体タイムアウトを課す (#I2)。ロック待ちで詰まる UPDATE を
    // プレビューすると、これが無いと接続と行ロックを無期限に握り続けてしまう
    // (読み取り専用セッションからでも preview 経路自体は到達できるため影響がある)。
    // 扱いは run_query_stream と同じ方式 (tokio::time::timeout でレース) に揃える。
    query_timeout_secs: Option<u64>,
    // #1096: `run_query_stream` と同じく、フロントが生成した Tauri Channel。
    // meta/before-rows/after-rows/done/error/cancelled をすべてこの 1 本で送る
    // (旧 `preview-stream:*` イベント群を置き換える)。
    on_event: Channel<PreviewStreamMessage>,
    state: State<'_, AppState>,
) -> Result<()> {
    let session = state
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    // The read-only guard is intentionally skipped here: a preview runs the
    // statement inside a transaction that is always rolled back, so it never
    // persists a change. `preview_execute_with_limit` only accepts
    // INSERT/UPDATE/DELETE/REPLACE and rejects DDL (which would implicit-commit
    // and so can't be rolled back), keeping the read-only guarantee intact while
    // letting a read-only session dry-run a write to inspect its effect.
    //
    // register_stream をタスク本体より前に完了させるためのゲート。理由は
    // run_query_stream 側の同種コメントを参照 (register/forget の順序が逆転すると
    // AbortHandle がマップに残り続けたり、後続の同 stream_id 登録を消してしまう)。
    // oneshot は register_stream が発行したトークンを運び、タスクはそれを使って
    // 自分の登録だけを forget_stream する (run_query_stream と同じ理由)。
    let delivered_rows = Arc::new(AtomicU64::new(0));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
    let stream_id_for_task = stream_id.clone();
    let delivered_rows_for_task = delivered_rows.clone();
    let cancel_channel = on_event.clone();
    let handle = tokio::spawn(async move {
        let Ok(token) = ready_rx.await else {
            return;
        };
        spawn_preview_stream(
            app,
            session,
            stream_id_for_task,
            token,
            sql,
            database,
            row_limit,
            chunk_size,
            query_timeout_secs,
            delivered_rows_for_task,
            on_event,
        )
        .await;
    });
    let token = state
        .register_stream(
            stream_id,
            StreamHandle {
                abort: handle.abort_handle(),
                delivered_rows,
                kind: StreamKind::Preview,
                on_cancel: Some(Box::new(move |delivered_rows| {
                    let _ = cancel_channel.send(PreviewStreamMessage::Cancelled { delivered_rows });
                })),
            },
        )
        .await;
    let _ = ready_tx.send(token);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_preview_stream(
    app: AppHandle,
    session: Arc<Session>,
    stream_id: String,
    stream_token: u64,
    sql: String,
    database: Option<String>,
    row_limit: usize,
    chunk_size: usize,
    query_timeout_secs: Option<u64>,
    delivered_rows: Arc<AtomicU64>,
    on_event: Channel<PreviewStreamMessage>,
) {
    let exec = session
        .conn
        .preview_execute_with_limit(&sql, database.as_deref(), row_limit);
    // run_query_stream と同じレース方式: 超過したら future を drop してプールへ
    // 接続を返す (プレビューはトランザクション内なので、drop は暗黙のロールバック
    // として働き、握っていた行ロックも解放される)。
    let result = match query_timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(std::time::Duration::from_secs(secs), exec).await {
                Ok(res) => res,
                Err(_) => Err(AppError::Timeout(secs)),
            }
        }
        _ => exec.await,
    };
    match result {
        Ok(p) => {
            if let Err(e) = on_event.send(PreviewStreamMessage::Meta {
                target_table: p.target_table.clone(),
                columns: p.columns.clone(),
                primary_key: p.primary_key.clone(),
                rows_affected: p.rows_affected,
                elapsed_ms: p.elapsed_ms,
                truncated: p.truncated,
            }) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "failed to send preview meta message"
                );
            }
            emit_chunks(
                &on_event,
                &stream_id,
                |rows| PreviewStreamMessage::BeforeRows { rows },
                &p.before_rows,
                chunk_size,
                &delivered_rows,
            );
            emit_chunks(
                &on_event,
                &stream_id,
                |rows| PreviewStreamMessage::AfterRows { rows },
                &p.after_rows,
                chunk_size,
                &delivered_rows,
            );
            if let Err(e) = on_event.send(PreviewStreamMessage::Done {}) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "failed to send preview done message"
                );
            }
        }
        Err(e) => {
            if matches!(e, AppError::Timeout(_)) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "preview stream timed out"
                );
            } else {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %e,
                    "preview stream failed"
                );
            }
            if let Err(send_err) = on_event.send(PreviewStreamMessage::Error {
                error: e.to_string(),
                timed_out: matches!(e, AppError::Timeout(_)),
                connection_lost: e.is_connection_lost(),
                delivered_rows: delivered_rows.load(Ordering::SeqCst),
            }) {
                tracing::warn!(
                    session_id = %session.id,
                    stream_id = %stream_id,
                    error = %send_err,
                    "failed to send preview error message"
                );
            }
        }
    }
    if let Some(state) = app.try_state::<AppState>() {
        state.forget_stream(&stream_id, stream_token).await;
    }
}

/// Sends `rows` to `channel` in `chunk_size`-row pieces, wrapping each chunk
/// with `make_msg` (`PreviewStreamMessage::BeforeRows` / `AfterRows`, passed
/// as a variant constructor). Shared by the before/after halves of a preview
/// so the chunking/`delivered_rows` bookkeeping stays in one place.
fn emit_chunks(
    channel: &Channel<PreviewStreamMessage>,
    stream_id: &str,
    make_msg: impl Fn(Vec<Vec<Value>>) -> PreviewStreamMessage,
    rows: &[Vec<Value>],
    chunk_size: usize,
    delivered_rows: &AtomicU64,
) {
    let chunk = chunk_size.max(1);
    let mut i = 0;
    while i < rows.len() {
        let end = (i + chunk).min(rows.len());
        let emitted_len = (end - i) as u64;
        delivered_rows.fetch_add(emitted_len, Ordering::SeqCst);
        if let Err(e) = channel.send(make_msg(rows[i..end].to_vec())) {
            // The UI never received this chunk; roll back the count.
            delivered_rows.fetch_sub(emitted_len, Ordering::SeqCst);
            tracing::warn!(
                stream_id = %stream_id,
                error = %e,
                "failed to send preview rows chunk"
            );
        }
        i = end;
    }
}

/// Result of [`cancel_stream`]. Replaces the plain boolean this command used
/// to return: without a row count, a cancelled run's partial rows are
/// indistinguishable from a complete result to the caller (#685).
#[derive(Debug, Serialize, Clone)]
pub struct CancelStreamResult {
    pub cancelled: bool,
    #[serde(rename = "deliveredRows")]
    pub delivered_rows: u64,
}

/// Aborts the streaming task registered for `stream_id` (any of
/// `run_query_stream` / `preview_query_stream` / `export_query_stream` /
/// `import_csv` — they all share `AppState.streams`). On a genuine cancel
/// (the stream was still running) this also notifies the stream's transport
/// carrying the same row count, for parity with the `:done`/`:error` terminal
/// messages (#685):
///
/// - Query/Preview (#1096): via the `on_cancel` callback stored in
///   [`StreamHandle`] at registration time, which sends a `Cancelled` message
///   down the same Tauri Channel the rest of that stream used (see
///   `QueryStreamMessage` / `PreviewStreamMessage`).
/// - Export/Dump/Import: still the legacy `app.emit()` `<kind>-stream:
///   cancelled` named event (outside this command's transport migration).
///
/// The frontend's own cancel flow detaches its listeners before calling this
/// command (so it never observes either notification) and instead reads
/// `deliveredRows` off the return value directly — the notification exists for
/// any other consumer and for architectural symmetry with the other
/// terminal messages.
#[tauri::command]
pub async fn cancel_stream(
    app: AppHandle,
    stream_id: String,
    state: State<'_, AppState>,
) -> Result<CancelStreamResult> {
    match state.cancel_stream(&stream_id).await {
        Some((delivered_rows, kind, on_cancel)) => {
            if let Some(notify) = on_cancel {
                notify(delivered_rows);
            } else {
                let event = match kind {
                    StreamKind::Export => Some(EV_EXPORT_CANCELLED),
                    // A dump reuses `delivered_rows` as bytes-written; the frontend's
                    // dump handler reads the field as bytes. The partial file is
                    // deleted on cancel like a streaming export (#686).
                    StreamKind::Dump => Some(EV_DUMP_CANCELLED),
                    // In `skip` mode an import auto-commits each chunk, so a cancel
                    // can leave rows persisted; `delivered_rows` carries that count
                    // for parity with the other terminal events (`abort` mode rolls
                    // back and reports 0). #687 review follow-up.
                    StreamKind::Import => Some(EV_IMPORT_CANCELLED),
                    // A script run reports the number of statements already
                    // committed (autocommit or a closed script-level
                    // transaction); an open transaction is rolled back by the
                    // runner's drop guard (#973).
                    StreamKind::Script => Some(EV_SCRIPT_CANCELLED),
                    // AI リクエスト (#690)。`delivered_rows` は送信済みの delta 件数。
                    StreamKind::Ai => Some(EV_AI_CANCELLED),
                    // 接続間転送 (#986)。`create` / `replace` では作りかけのテーブルを
                    // 後始末で DROP するため、`delivered_rows` (書き込み済み行数) が
                    // 永続化されて残るのは `append` のときだけ。
                    StreamKind::Transfer => Some(EV_TRANSFER_CANCELLED),
                    // Query/Preview always register an `on_cancel` callback (see
                    // `run_query_stream` / `preview_query_stream`), so this arm is
                    // unreachable in practice; keep it exhaustive rather than
                    // panicking on a future refactor that drops the callback.
                    StreamKind::Query | StreamKind::Preview | StreamKind::Search => None,
                };
                if let Some(event) = event {
                    if let Err(e) = app.emit(
                        event,
                        StreamCancelledEvent {
                            stream_id: stream_id.clone(),
                            delivered_rows,
                        },
                    ) {
                        tracing::warn!(stream_id = %stream_id, error = %e, "failed to emit cancelled event");
                    }
                }
            }
            Ok(CancelStreamResult {
                cancelled: true,
                delivered_rows,
            })
        }
        None => Ok(CancelStreamResult {
            cancelled: false,
            delivered_rows: 0,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every supported driver, so the read-only guards are asserted under both
    /// masking flavours (MySQL's backslash escapes vs. the standard reading)
    /// rather than only the one that happens to be the default (#852).
    const ALL_DRIVERS: [DriverKind; 3] =
        [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite];

    #[test]
    fn auto_refresh_allows_read_only_statements() {
        for sql in [
            "SELECT * FROM users",
            "  select 1",
            "SHOW TABLES",
            "DESCRIBE users",
            "EXPLAIN SELECT 1",
            "WITH t AS (SELECT 1) SELECT * FROM t",
        ] {
            for driver in ALL_DRIVERS {
                assert!(
                    ensure_auto_refresh_read_only(driver, sql).is_ok(),
                    "expected `{sql}` to be allowed for auto-refresh on {driver:?}"
                );
            }
        }
    }

    #[test]
    fn auto_refresh_rejects_writes_and_ddl() {
        for sql in [
            "DELETE FROM users",
            "UPDATE users SET name = 'x'",
            "INSERT INTO users VALUES (1)",
            "DROP TABLE users",
            "TRUNCATE users",
            // Stacked statement hiding a write behind a SELECT.
            "SELECT 1; DELETE FROM users",
            // Data-modifying CTE.
            "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
        ] {
            for driver in ALL_DRIVERS {
                assert!(
                    matches!(
                        ensure_auto_refresh_read_only(driver, sql),
                        Err(AppError::ReadOnly(_))
                    ),
                    "expected `{sql}` to be rejected for auto-refresh on {driver:?}"
                );
            }
        }
    }

    #[test]
    fn broadcast_allows_read_only_statements() {
        for sql in [
            "SELECT * FROM users",
            "  select 1",
            "SHOW TABLES",
            "DESCRIBE users",
            "EXPLAIN SELECT 1",
            "EXPLAIN ANALYZE SELECT * FROM users",
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users",
            "WITH t AS (SELECT 1) SELECT * FROM t",
        ] {
            for driver in ALL_DRIVERS {
                assert!(
                    ensure_broadcast_read_only(driver, sql).is_ok(),
                    "expected `{sql}` to be allowed for broadcast execution on {driver:?}"
                );
            }
        }
    }

    #[test]
    fn broadcast_rejects_writes_and_ddl() {
        for sql in [
            "DELETE FROM users",
            "UPDATE users SET name = 'x'",
            "INSERT INTO users VALUES (1)",
            "DROP TABLE users",
            "TRUNCATE users",
            // Stacked statement hiding a write behind a SELECT.
            "SELECT 1; DELETE FROM users",
            // Data-modifying CTE.
            "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
            // #1164: 実測モード (EXPLAIN ANALYZE) は対象 SQL を実際に実行する。
            "EXPLAIN ANALYZE DELETE FROM users",
            "EXPLAIN ANALYZE UPDATE users SET name = 'x'",
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) INSERT INTO users VALUES (1)",
            "EXPLAIN (ANALYZE) WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
            "EXPLAIN ANALYZE SELECT 1; DELETE FROM users",
        ] {
            for driver in ALL_DRIVERS {
                assert!(
                    matches!(
                        ensure_broadcast_read_only(driver, sql),
                        Err(AppError::ReadOnly(_))
                    ),
                    "expected `{sql}` to be rejected for broadcast execution on {driver:?}"
                );
            }
        }
    }

    // I4: `run_query_stream` / `preview_query_stream` が使う「register_stream を
    // タスク本体の実行より前に完了させるゲート」の順序保証を確認する回帰テスト。
    // ゲートが無いと、SQL 即エラーのような速いタスクが register_stream より先に
    // forget_stream してしまい、完了済みタスクの AbortHandle がマップに残り続ける
    // (以後その stream_id への cancel_stream が誤って true を返す) 競合が起こりうる。
    // ここではその実装パターンそのものを AppState に対して再現し、
    // 「register_stream 完了時点でエントリが存在する」→「ゲート解放後にタスクが
    // forget_stream する」という順序が守られることを検証する。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stream_gate_ensures_register_happens_before_task_forgets_itself() {
        let state = Arc::new(AppState::default());
        let stream_id = "test-stream-gate".to_string();

        // 本番コード (run_query_stream / preview_query_stream) と同じく、oneshot は
        // register_stream が発行したトークンそのものを運ぶ。
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u64>();
        let task_state = state.clone();
        let task_stream_id = stream_id.clone();
        // 実処理を模した「即完了するタスク」。ゲートを待ってから自分の登録を消す。
        let handle = tokio::spawn(async move {
            let Ok(token) = ready_rx.await else {
                return;
            };
            task_state.forget_stream(&task_stream_id, token).await;
        });
        let token = state
            .register_stream(
                stream_id.clone(),
                StreamHandle {
                    abort: handle.abort_handle(),
                    delivered_rows: Arc::new(AtomicU64::new(0)),
                    kind: StreamKind::Query,
                    on_cancel: None,
                },
            )
            .await;
        // register_stream が完了した時点でエントリが存在すること (forget がまだ
        // 走っていない = ゲートで正しく順序付けられている)。
        assert!(
            state.streams.read().await.contains_key(&stream_id),
            "stream should be registered before the gate is released"
        );
        let _ = ready_tx.send(token);
        handle.await.unwrap();
        // タスクがゲート解放後に forget_stream を実行し、エントリが消えていること。
        assert!(
            !state.streams.read().await.contains_key(&stream_id),
            "stream should have been forgotten by the task after the gate opened"
        );
    }

    /// #1096: `run_query_stream`/`preview_query_stream` が組み立てる `on_cancel`
    /// 配線 (Channel を clone してクロージャに閉じ込め、`cancel_stream` がそれを
    /// 呼ぶと `Cancelled` メッセージが同じ Channel から届く) を、`AppHandle` /
    /// 実 Tauri アプリなしで再現・固定する。
    ///
    /// `run_query_stream` 本体は `AppHandle` (Channel 引数は Webview 経由の IPC
    /// デシリアライズでしか得られない) を要するため統合テストから直接は駆動
    /// できない (`tests/timeout_cancel_pool.rs` 冒頭のコメントと同じ制約) が、
    /// `tauri::ipc::Channel::new` はプレーンなコンストラクタなのでこの配線
    /// パターン自体は単体テストで検証できる。「キャンセル時にストリームが確実に
    /// 終了する」という受け入れ条件のうち、*on_cancel が実際に呼ばれて Cancelled
    /// メッセージが同じチャンネルへ飛ぶ* 部分をここで固定する — 呼ばれなければ
    /// フロントの `channel.onmessage` は永久に無音のままで、UI がキャンセル後も
    /// 「実行中」表示のまま止まる (#685 の回帰)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_stream_fires_the_registered_on_cancel_channel_callback() {
        use tauri::ipc::InvokeResponseBody;

        // Channel の送信先: `on_message` は生の InvokeResponseBody (JSON 文字列)
        // を受け取る (`tauri::ipc::IpcResponse` の blanket impl が
        // `serde_json::to_string` で作る)。mpsc に流し、後で kind/deliveredRows
        // を検証する。
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<InvokeResponseBody>();
        let channel: Channel<QueryStreamMessage> = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        // run_query_stream が spawn 前に行うのと同じ clone
        // (タスク本体用と on_cancel クロージャ用の 2 系統)。
        let cancel_channel = channel.clone();

        let state = AppState::default();
        // このテストではタスク本体の中身は関係ない (on_cancel の配線だけを見る)
        // ので、abort されるまで無期限に pending な no-op タスクで十分。
        let jh = tokio::spawn(std::future::pending::<()>());
        let stream_id = "strm-oncancel-test".to_string();
        state
            .register_stream(
                stream_id.clone(),
                StreamHandle {
                    abort: jh.abort_handle(),
                    delivered_rows: Arc::new(AtomicU64::new(3)),
                    kind: StreamKind::Query,
                    // run_query_stream 本体と同一の配線パターン。
                    on_cancel: Some(Box::new(move |delivered_rows| {
                        let _ =
                            cancel_channel.send(QueryStreamMessage::Cancelled { delivered_rows });
                    })),
                },
            )
            .await;

        let (delivered_rows, kind, on_cancel) = state
            .cancel_stream(&stream_id)
            .await
            .expect("registered stream should be found and cancelled");
        assert_eq!(delivered_rows, 3);
        assert_eq!(kind, StreamKind::Query);
        let on_cancel =
            on_cancel.expect("query stream must register an on_cancel callback (#1096)");
        // `cancel_stream` コマンドがここで呼ぶのと同じ。
        on_cancel(delivered_rows);

        let body = rx
            .recv()
            .await
            .expect("on_cancel should have sent a Cancelled message down the channel");
        let InvokeResponseBody::Json(json) = body else {
            panic!("expected a JSON payload, got raw bytes");
        };
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["kind"], "cancelled");
        assert_eq!(value["deliveredRows"], 3);
    }
}
