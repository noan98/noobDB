//! 書き込み可能な全 IPC 経路が SchemaCache / QueryResultCache を invalidate することを
//! 機械的に固定するメタテスト (#1222)。
//!
//! `cache/mod.rs` のモジュールドキュメントにある invalidate 条件の列挙は手書きで、
//! 新しい書き込み経路を足したときの配線漏れ (#1220: ストリーミング DDL 経路で
//! SchemaCache の無効化が抜けていた) を検出できなかった。ここでは 2 段で固定する。
//!
//! 1. **振る舞い (表駆動)**: 実 SQLite + `AppState` で、各書き込み経路に DDL 相当 /
//!    DML 相当の入力を流し、DDL なら SchemaCache が、書き込み全般なら
//!    QueryResultCache が破棄される (= 次の問い合わせが再取得になる) ことを確認する。
//!    ストリーミング経路は `AppHandle` / `Channel` が要るため、`spawn_query_stream` が
//!    成功後に呼ぶ共通ヘルパ (`invalidate_caches_after_stream_success`) で代表する。
//! 2. **配線 (ソース走査)**: `src/commands/*.rs` のうち SQL を実行する入口を持つ
//!    ファイルは、invalidate を呼ぶか、`READ_ONLY_FILES` に「なぜ不要か」付きで
//!    載せなければ fail する。ストリーミング本体が共通ヘルパを呼ぶことも固定する。
//!    新しい書き込み経路を足して invalidate を忘れるとここが赤になる。
//!
//! 外部サーバ不要 (SQLite temp file) なので常時実走する。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use noobdb_lib::__test_api as t;
use t::AppState;

// ---------------------------------------------------------------------------
// 1. 振る舞い: 経路 x (DDL / DML) の表
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Path {
    RunQuery,
    RunQueryTransaction,
    RunInTransaction,
    /// `run_query_stream` / `spawn_query_stream` (エディタの主経路)。
    Stream,
    /// ファイルからのスクリプト実行 (`run_sql_script`)。
    Script,
    /// エディタのバッチ実行 (`run_sql_batch`)。
    Batch,
    /// スキーマ / データ同期の適用 (`apply_sync_sql`)。
    SyncApply,
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    /// テーブル作成 (SchemaCache も QueryResultCache も破棄されるべき)。
    Ddl,
    /// 行の挿入 (QueryResultCache だけ破棄されるべき)。
    Dml,
}

const ALL_PATHS: [Path; 7] = [
    Path::RunQuery,
    Path::RunQueryTransaction,
    Path::RunInTransaction,
    Path::Stream,
    Path::Script,
    Path::Batch,
    Path::SyncApply,
];

const DDL_SQL: &str = "CREATE TABLE added (id INTEGER PRIMARY KEY)";
const DML_SQL: &str = "INSERT INTO base (id) VALUES (2)";
const PROBE_SQL: &str = "SELECT COUNT(*) FROM base";

async fn setup(tag: &str) -> (AppState, String, Arc<t::Session>, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_inval_matrix_{tag}_{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    conn.execute("CREATE TABLE base (id INTEGER PRIMARY KEY)", None)
        .await
        .expect("create base");
    conn.execute("INSERT INTO base (id) VALUES (1)", None)
        .await
        .expect("seed base");
    let state = AppState::default();
    let id = state.insert(t::make_session(tag, conn, opts, false)).await;
    let session = state.get(&id).await.expect("session exists");
    (state, id, session, path)
}

/// SchemaCache (tables) に 1 回載せる / 読む。再取得が走ったかは `calls` で数える。
async fn touch_schema(session: &t::Session, calls: &AtomicUsize) {
    session
        .schema_cache
        .tables("main", || async {
            calls.fetch_add(1, Ordering::SeqCst);
            session.conn.tables("main").await
        })
        .await
        .expect("tables");
}

/// QueryResultCache に読み取りクエリを 1 回載せる / 読む。
async fn touch_query(session: &t::Session, calls: &AtomicUsize) {
    session
        .query_cache
        .get_or_fetch(session.conn.driver_kind(), None, PROBE_SQL, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            session.conn.execute(PROBE_SQL, None).await
        })
        .await
        .expect("probe query");
}

async fn run_path(path: Path, kind: Kind, state: &AppState, id: &str, session: &Arc<t::Session>) {
    let sql = match kind {
        Kind::Ddl => DDL_SQL,
        Kind::Dml => DML_SQL,
    };
    match path {
        Path::RunQuery => {
            t::run_query_via_command(state, id, sql, None)
                .await
                .expect("run_query");
        }
        Path::RunQueryTransaction => {
            t::run_query_transaction_via_command(state, id, vec![sql.to_string()], None)
                .await
                .expect("run_query_transaction");
        }
        Path::RunInTransaction => {
            session
                .conn
                .begin_transaction(None)
                .await
                .expect("begin transaction");
            t::run_in_transaction_via_command(state, id, sql)
                .await
                .expect("run_in_transaction");
            session
                .conn
                .finish_transaction(false)
                .await
                .expect("rollback transaction");
        }
        Path::Stream => {
            // `spawn_query_stream` は実行成功後にこのヘルパを呼ぶ (#1220)。
            session.conn.execute(sql, None).await.expect("execute");
            t::invalidate_caches_after_stream_success(session, sql).await;
        }
        Path::Script => {
            let mut file = std::env::temp_dir();
            file.push(format!(
                "noobdb_inval_matrix_script_{:?}_{}.sql",
                kind,
                std::process::id()
            ));
            std::fs::write(&file, format!("{sql};\n")).expect("write script");
            let run = t::run_sql_script_via_core(
                session.clone(),
                file.to_str().expect("utf8 path"),
                None,
                t::ScriptOptions::default(),
                Arc::new(std::sync::atomic::AtomicU64::new(0)),
                |_| {},
            )
            .await
            .expect("script setup");
            let _ = std::fs::remove_file(&file);
            assert!(
                matches!(
                    run,
                    t::ScriptRun::Done {
                        failed_count: 0,
                        ..
                    }
                ),
                "スクリプトが成功すること: {run:?}"
            );
        }
        Path::Batch => {
            let (run, _results) = t::run_sql_batch_via_core(
                session.clone(),
                sql,
                None,
                true,
                10,
                Arc::new(std::sync::atomic::AtomicU64::new(0)),
            )
            .await
            .expect("batch setup");
            assert!(
                matches!(
                    run,
                    t::ScriptRun::Done {
                        failed_count: 0,
                        ..
                    }
                ),
                "バッチが成功すること: {run:?}"
            );
        }
        Path::SyncApply => {
            t::apply_sync_sql_via_command(state, id, None, vec![sql.to_string()])
                .await
                .expect("apply_sync_sql");
        }
    }
}

#[tokio::test]
async fn every_write_path_invalidates_the_caches() {
    for path in ALL_PATHS {
        for kind in [Kind::Ddl, Kind::Dml] {
            let tag = format!("{path:?}_{kind:?}").to_lowercase();
            let (state, id, session, db_path) = setup(&tag).await;

            let schema_calls = AtomicUsize::new(0);
            let query_calls = AtomicUsize::new(0);
            // 両キャッシュを温める (以降の再取得だけを数える)。
            touch_schema(&session, &schema_calls).await;
            touch_query(&session, &query_calls).await;
            // 温めた直後にもう一度読んでヒットすること (テスト自体の前提確認)。
            touch_schema(&session, &schema_calls).await;
            touch_query(&session, &query_calls).await;
            assert_eq!(schema_calls.load(Ordering::SeqCst), 1, "{path:?}: 前提");
            assert_eq!(query_calls.load(Ordering::SeqCst), 1, "{path:?}: 前提");

            run_path(path, kind, &state, &id, &session).await;

            touch_schema(&session, &schema_calls).await;
            touch_query(&session, &query_calls).await;

            let schema_refetched = schema_calls.load(Ordering::SeqCst) == 2;
            let query_refetched = query_calls.load(Ordering::SeqCst) == 2;
            // 書き込み全般 (DDL / DML) で QueryResultCache は破棄される。
            assert!(
                query_refetched,
                "{path:?} / {kind:?}: 書き込み成功後に QueryResultCache が invalidate されていない"
            );
            match kind {
                Kind::Ddl => assert!(
                    schema_refetched,
                    "{path:?} / {kind:?}: DDL 成功後に SchemaCache が invalidate されていない (#1220 型の漏れ)"
                ),
                // 純 DML でスキーマ構造は変わらないので、SchemaCache は保持される
                // (過剰 invalidate は再取得コストになるだけで安全側だが、スクリプトの
                // ように「実行した文を見てから決める」経路では判定が効いていることを
                // 確認する)。同期適用は常時 invalidate する設計なので除外。
                Kind::Dml => {
                    if !matches!(path, Path::SyncApply) {
                        assert!(
                            !schema_refetched,
                            "{path:?} / {kind:?}: 純 DML で SchemaCache が破棄されている"
                        );
                    }
                }
            }
            let _ = std::fs::remove_file(&db_path);
        }
    }
}

// ---------------------------------------------------------------------------
// 2. 配線: ソース走査 (新しい書き込み経路の invalidate 忘れを検出)
// ---------------------------------------------------------------------------

/// SQL 実行の入口 (ドライバの execute 系) を呼ぶトークン。
const EXEC_TOKENS: [&str; 5] = [
    ".execute(",
    ".execute_stream(",
    ".execute_transaction(",
    ".execute_in_transaction(",
    ".execute_batch(",
];

/// invalidate を呼ぶ記述。
const INVALIDATE_TOKENS: [&str; 2] = ["invalidate_all()", "invalidate_caches_after_success"];

/// SQL を実行するが invalidate を呼ばなくてよいファイル (理由必須)。
/// ここへ足すときは「そのファイルが書き込みを行わない / キャッシュに影響しない」
/// ことをレビューで確認すること。
const READ_ONLY_FILES: &[(&str, &str)] = &[
    (
        "broadcast.rs",
        "読み取り専用はバックエンド強制 (ensure_broadcast_read_only)",
    ),
    ("cell_blob.rs", "BLOB セルの SELECT のみ"),
    ("connection.rs", "接続確認の SELECT 1 のみ"),
    ("diff.rs", "データ比較の SELECT のみ (適用は sync.rs)"),
    ("dump.rs", "ダンプ (読み出し) のみ"),
    ("export.rs", "エクスポート (読み出し) のみ"),
    (
        "privileges.rs",
        "ユーザ/権限のみ変更し、スキーマ構造にもテーブルの行にも影響しない (本体のコメント参照)",
    ),
    ("search.rs", "検索 (SELECT) のみ"),
    ("timelapse.rs", "履歴の SELECT のみ"),
];

fn commands_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands")
}

fn read_commands_file(name: &str) -> String {
    std::fs::read_to_string(commands_dir().join(name)).expect("read commands source")
}

fn command_sources() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(commands_dir()).expect("read src/commands") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("utf8 file name")
            .to_string();
        let src = std::fs::read_to_string(&path).expect("read source");
        out.push((name, src));
    }
    out
}

#[test]
fn every_sql_executing_command_file_invalidates_or_is_declared_read_only() {
    let mut missing = Vec::new();
    for (name, src) in command_sources() {
        let executes = EXEC_TOKENS.iter().any(|t| src.contains(t));
        if !executes {
            continue;
        }
        let invalidates = INVALIDATE_TOKENS.iter().any(|t| src.contains(t));
        let declared = READ_ONLY_FILES.iter().any(|(f, _)| *f == name);
        if !invalidates && !declared {
            missing.push(name);
        }
    }
    assert!(
        missing.is_empty(),
        "SQL を実行するのに SchemaCache / QueryResultCache を invalidate していない \
         ファイルがある: {missing:?}\n\
         書き込み経路なら成功後に invalidate を呼ぶ (query.rs の \
         invalidate_caches_after_success が共通ヘルパ)。読み取り専用なら \
         READ_ONLY_FILES に理由付きで載せる。"
    );
}

#[test]
fn read_only_allowlist_is_not_stale() {
    for (name, reason) in READ_ONLY_FILES {
        assert!(!reason.is_empty(), "{name}: 理由が空");
        let src = read_commands_file(name);
        assert!(
            EXEC_TOKENS.iter().any(|t| src.contains(t)),
            "{name} は SQL 実行を持たないので READ_ONLY_FILES から外す"
        );
        assert!(
            !INVALIDATE_TOKENS.iter().any(|t| src.contains(t)),
            "{name} は invalidate を呼んでいるので READ_ONLY_FILES から外す"
        );
    }
}

/// 関数 `fn_name` の本体 (宣言から、行頭の `}` まで) を返す。
fn fn_body<'a>(src: &'a str, fn_name: &str) -> &'a str {
    let start = src
        .find(&format!("fn {fn_name}("))
        .unwrap_or_else(|| panic!("fn {fn_name} が見つからない"));
    let rest = &src[start..];
    let end = rest.find("\n}\n").unwrap_or(rest.len());
    &rest[..end]
}

#[test]
fn streaming_and_run_query_share_the_invalidate_helper() {
    let src = read_commands_file("query.rs");
    for f in ["run_query_inner", "spawn_query_stream"] {
        assert!(
            fn_body(&src, f).contains("invalidate_caches_after_success("),
            "{f} が成功後に invalidate_caches_after_success を呼んでいない (#1220)"
        );
    }
    // 明示トランザクション系は文ごとに判定する経路で、両キャッシュを直接 invalidate する。
    for f in ["run_query_transaction_inner", "run_in_transaction_inner"] {
        let body = fn_body(&src, f);
        assert!(
            body.contains("schema_cache.invalidate_all()")
                && body.contains("query_cache.invalidate_all()"),
            "{f} が SchemaCache / QueryResultCache の両方を invalidate していない"
        );
    }
}
