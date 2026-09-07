// #825 でフィクスチャ数が増え、`serde_json::json!` マクロの再帰的展開が既定の
// 再帰制限 (128) を超えるようになったため引き上げる。
#![recursion_limit = "256"]

//! zod ⇔ serde フィールド整合の共有ゴールデン (Rust 側、#625)。
//!
//! IPC のコマンド名パリティは `ipcCommandParity.test.ts` が担うが、**レスポンス
//! 構造体のフィールドレベル整合 (zod スキーマ ⇔ Rust serde 型)** は目視頼みだった。
//! ここでは主要レスポンス型の**代表インスタンスを serde で JSON 化したフィクスチャ**
//! (`src/__tests__/fixtures/serdeResponseFixtures.json`) を 1 ファイルだけ共有し、
//! 読み取り専用ゴールデン (#444) と同じ発想で両言語から突き合わせる:
//!
//! - **本テスト (Rust)**: 構造体から実際に serde が吐く JSON がフィクスチャと一致する
//!   ことを固定する。Rust 側でフィールドを追加/削除/リネーム/型変更するとシリアライズ
//!   結果が変わり、このテストが落ちる (フィクスチャ再生成を促す)。
//! - **フロント (`schemaParity.test.ts`)**: 同じフィクスチャを `api/schemas.ts` の zod で
//!   `safeParse` して通ること + キー集合がスキーマ shape と一致することを確認する。
//!   zod 側でフィールドが欠ける/増えるとキー集合がズレて落ちる。
//!
//! → フィクスチャ 1 つを介して、Rust と zod の**双方向のドリフト**を CI が検出する。
//!
//! フィクスチャの再生成 (意図的にレスポンス型を変えたとき):
//!   `NOOBDB_WRITE_SERDE_FIXTURES=1 cargo test --test serde_schema_parity`
//! を実行するとフィクスチャを上書きする (その後 diff を確認してコミット)。
//!
//! #825 でストリーミングイベント (`query-stream:*` / `preview-stream:*` /
//! `csv-import:*` / `dump-stream:*` / `export-stream:*` / `connect-progress:phase`)
//! の emit ペイロード構造体もこのゴールデンへ加えた。これらは元々 `commands::*`
//! 配下の非公開型だったため、`lib.rs::__test_api` へピンポイントで再エクスポート
//! している (フィールドも同様に `pub` 化。#824 の `LogView` と同じパターン)。
//!
//! #1096 で Query/Preview ストリームは `app.emit()` の個別イベント構造体をやめ、
//! Tauri Channel で送る `kind` タグ付き enum (`QueryStreamMessage` /
//! `PreviewStreamMessage`) に統合した (大量データ転送の効率化 — IPC 回数と
//! payload 重複の削減)。CSV インポート/エクスポート/ダンプは引き続き名前付き
//! イベントのまま。

use std::path::PathBuf;

use noobdb_lib::__test_api as t;
use serde_json::json;
use t::{
    CancelStreamResult, Column, ColumnDiff, ConnectPhaseEvent, ConnectResponse, ConnectionProfile,
    CsvPreview, DataDiff, DiffStatus, DriverKind, DumpDoneEvent, DumpErrorEvent, DumpProgressEvent,
    ExportDoneEvent, ExportErrorEvent, ExportProgressEvent, ForeignKey, HealthFinding,
    HistoryEntry, ImportDoneEvent, ImportErrorEvent, ImportProgressEvent, ImportResult,
    ImportStartedEvent, IndexInfo, KnownHost, LiveQuery, LocalTableMeta, LogView, PreviewResult,
    PreviewStreamMessage, ProcessInfo, ProfileWithSecretFlags, QueryResult, QueryStatsSupport,
    QueryStreamMessage, RowDiff, RowStatus, RuleId, SchemaDiff, SchemaHealthReport, SchemaObject,
    ServerInfo, ServerMetrics, ServerVariable, Severity, SkippedRowInfo, SkippedRule, Snippet,
    SnippetScope, SshAuthMethod, SshJumpProfile, SshProfile, SslMode, StatementStat,
    StreamCancelledEvent, SyncKind, SyncPlan, SyncStatement, TableColumnInfo, TableDiff,
    TableRowEstimate, TableRowIdentity, TableSchema, TableSizeInfo, Value,
};

const FIXTURE_JSON: &str = include_str!("../../src/__tests__/fixtures/serdeResponseFixtures.json");

/// 主要レスポンス型の代表インスタンスを serde で JSON 化し、
/// `{ 型名: JSON }` のマップにまとめて返す。フロントのフィクスチャと同一内容。
///
/// Option フィールドは基本的に `Some` を入れてキー + 型を露出させる (serde は None も
/// `null` として出すのでキー自体は常に present)。zod の `.nullable()` は両方受ける。
fn build_fixtures() -> serde_json::Value {
    let column = Column {
        name: "id".into(),
        type_name: "INTEGER".into(),
    };
    let query_result = QueryResult {
        columns: vec![
            column.clone(),
            Column {
                name: "label".into(),
                type_name: "TEXT".into(),
            },
        ],
        rows: vec![
            vec![Value::Int(1), Value::String("a".into())],
            vec![Value::Null, Value::Bytes("deadbeef".into())],
        ],
        rows_affected: 0,
        elapsed_ms: 12,
    };
    let table_column_info = TableColumnInfo {
        name: "id".into(),
        data_type: "int".into(),
        nullable: false,
        key: "PRI".into(),
        default: Some("0".into()),
        extra: "auto_increment".into(),
        referenced_table: Some("parent".into()),
        referenced_column: Some("id".into()),
    };
    let table_schema = TableSchema {
        name: "users".into(),
        columns: vec!["id".into(), "name".into()],
    };
    let foreign_key = ForeignKey {
        table: "orders".into(),
        column: "user_id".into(),
        referenced_table: "users".into(),
        referenced_column: Some("id".into()),
        constraint_name: Some("fk_orders_user".into()),
    };
    let index_info = IndexInfo {
        name: "idx_users_name".into(),
        columns: vec!["name".into()],
        unique: true,
        primary: false,
        method: Some("btree".into()),
    };
    let schema_object = SchemaObject {
        kind: "view".into(),
        name: "active_users".into(),
        id: Some("1234".into()),
    };
    let table_row_estimate = TableRowEstimate {
        name: "users".into(),
        estimate: Some(1234),
    };
    let table_row_identity = TableRowIdentity {
        strategy: "rowid".into(),
        hidden_column: Some("rowid".into()),
    };
    let table_size_info = TableSizeInfo {
        name: "users".into(),
        row_estimate: Some(1234),
        data_bytes: Some(65536),
        index_bytes: Some(16384),
        total_bytes: Some(81920),
    };
    let server_variable = ServerVariable {
        name: "max_connections".into(),
        value: "151".into(),
    };
    let server_info = ServerInfo {
        version: "8.0.36".into(),
        variables: vec![server_variable.clone()],
    };
    let process_info = ProcessInfo {
        id: 42,
        user: Some("root".into()),
        host: Some("127.0.0.1:53344".into()),
        database: Some("testdb".into()),
        command: Some("Query".into()),
        state: Some("executing".into()),
        time_secs: Some(3),
        query: Some("SELECT 1".into()),
        is_self: true,
    };
    let query_stats_support = QueryStatsSupport {
        live_tail: true,
        statements: false,
        live_tail_reason: Some("stats_unreadable".into()),
        statements_reason: Some("pg_stat_statements_missing".into()),
    };
    let live_query = LiveQuery {
        key: "42:1699".into(),
        query: "SELECT * FROM users WHERE id = 1".into(),
        user: Some("app".into()),
        host: Some("10.0.0.5:53344".into()),
        database: Some("appdb".into()),
        application: Some("myapp".into()),
        duration_ms: Some(1.5),
        rows_examined: Some(100),
        running: true,
        started_at_ms: Some(1700000000000.0),
    };
    let statement_stat = StatementStat {
        digest: "abc123".into(),
        fingerprint: "SELECT * FROM `users` WHERE `id` = ?".into(),
        database: Some("appdb".into()),
        calls: 1200,
        total_time_ms: 4321.5,
        max_time_ms: 87.2,
        rows: Some(1200),
    };
    let server_metrics = ServerMetrics {
        connections: Some(42),
        active: Some(3),
        idle_in_transaction: Some(1),
        lock_waiting: Some(0),
        questions: Some(1_000_000),
        slow_queries: Some(12),
        lock_waits: Some(5),
    };
    let preview_result = PreviewResult {
        target_table: Some("users".into()),
        columns: vec![column.clone()],
        primary_key: vec!["id".into()],
        before_rows: vec![vec![Value::Int(1)]],
        after_rows: vec![vec![Value::Int(2)]],
        rows_affected: 1,
        elapsed_ms: 5,
        truncated: false,
    };
    let health_finding = HealthFinding {
        rule: RuleId::FkMissingIndex,
        severity: Severity::High,
        table: "orders".into(),
        columns: vec!["user_id".into()],
        context: vec!["users".into()],
        fix_ddl: Some("CREATE INDEX `idx_orders_user_id` ON `orders` (`user_id`);".into()),
        statistical: false,
    };
    let skipped_rule = SkippedRule {
        rule: RuleId::UnusedIndex,
        reason: "performance_schema_off".into(),
    };
    let schema_health_report = SchemaHealthReport {
        driver: DriverKind::Mysql,
        tables_analyzed: 3,
        findings: vec![health_finding.clone()],
        skipped: vec![skipped_rule.clone()],
    };

    // --- #824: 未収載だった主要レスポンス/永続化型 ---------------------------

    let ssh_profile = SshProfile {
        host: "jump.example.com".into(),
        port: 22,
        user: "deploy".into(),
        auth_method: SshAuthMethod::Key,
        private_key_path: PathBuf::from("/home/deploy/.ssh/id_ed25519"),
        // #708: exposes the bastion-hop field so the zod ⇔ serde golden also
        // covers a chained (2-hop) profile, not just a direct one.
        jump: Some(SshJumpProfile {
            host: "bastion.example.com".into(),
            port: 2222,
            user: "ops".into(),
            auth_method: SshAuthMethod::Password,
            private_key_path: PathBuf::new(),
        }),
    };
    let connection_profile_inner = ConnectionProfile {
        id: "abc12345".into(),
        name: "Prod MySQL".into(),
        driver: "mysql".into(),
        host: "db.example.com".into(),
        port: 3306,
        user: "app".into(),
        database: Some("appdb".into()),
        ssh: Some(ssh_profile),
        group: Some("production".into()),
        color: Some("#dc2626".into()),
        is_production: true,
        confirm_writes: true,
        read_only: false,
        skip_history: false,
        file_path: None,
        ssl_mode: Some(SslMode::VerifyFull),
        ssl_root_cert: Some("/etc/ssl/ca.pem".into()),
        ssl_client_cert: Some("/etc/ssl/client.pem".into()),
        ssl_client_key: Some("/etc/ssl/client.key".into()),
        init_sql: Some("SET time_zone = '+00:00';".into()),
    };
    let connection_profile = ProfileWithSecretFlags {
        profile: connection_profile_inner,
        has_db_password: true,
        has_ssh_passphrase: false,
        has_ssh_password: false,
        has_ssh_jump_passphrase: false,
        has_ssh_jump_password: true,
    };

    let snippet = Snippet {
        id: "snip0001".into(),
        name: "Active users".into(),
        folder: Some("reports".into()),
        tags: vec!["users".into(), "active".into()],
        sql: "SELECT * FROM users WHERE active = 1".into(),
        driver: Some("mysql".into()),
        scope: SnippetScope::Profile {
            profile_id: "abc12345".into(),
        },
    };

    let history_entry = HistoryEntry {
        id: 101,
        profile_id: Some("abc12345".into()),
        driver: "mysql".into(),
        database: Some("appdb".into()),
        sql: "SELECT 1".into(),
        rows: Some(1),
        rows_affected: None,
        elapsed_ms: Some(12),
        status: "ok".into(),
        error: None,
        executed_at: "2026-01-01T00:00:00Z".into(),
    };

    let log_view = LogView {
        text: "2026-01-01T00:00:00Z INFO noobdb starting".into(),
        path: Some("/home/user/.local/share/noobDB/noobdb.log".into()),
    };

    let csv_preview = CsvPreview {
        headers: vec!["id".into(), "name".into()],
        rows: vec![vec!["1".into(), "Alice".into()]],
        truncated: false,
    };

    let connect_result = ConnectResponse {
        session_id: "abcd1234".into(),
    };

    let local_table_meta = LocalTableMeta {
        name: "r1".into(),
        source_profile: Some("prod-mysql".into()),
        source_sql: "SELECT * FROM orders".into(),
        source_driver: Some("mysql".into()),
        fetched_at_ms: 1_700_000_000_000,
        row_count: 42,
    };

    let profile_import_result = ImportResult {
        imported: 3,
        skipped: 1,
        overwritten: 0,
        invalid: 0,
    };

    let cancel_stream_response = CancelStreamResult {
        cancelled: true,
        delivered_rows: 42,
    };

    let known_host = KnownHost {
        host: "db.example.com".into(),
        port: 22,
        fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".into(),
    };

    let column_diff = ColumnDiff {
        name: "email".into(),
        status: DiffStatus::SourceOnly,
        source: Some(table_column_info.clone()),
        target: None,
        changed_fields: vec![],
    };
    let table_diff = TableDiff {
        name: "users".into(),
        status: DiffStatus::Different,
        columns: vec![column_diff],
    };
    let schema_diff = SchemaDiff {
        source_driver: DriverKind::Mysql,
        target_driver: DriverKind::Postgres,
        tables: vec![table_diff],
    };

    let sync_statement = SyncStatement {
        sql: "ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255);".into(),
        table: "users".into(),
        kind: SyncKind::AddColumn,
        destructive: false,
    };
    let sync_plan = SyncPlan {
        statements: vec![sync_statement],
        warnings: vec!["SQLite cannot alter columns in place".into()],
    };

    let row_diff = RowDiff {
        status: RowStatus::Different,
        key: vec![Value::Int(1)],
        source: Some(vec![Value::Int(1), Value::String("Alice".into())]),
        target: Some(vec![Value::Int(1), Value::String("Alicia".into())]),
        changed_columns: vec!["name".into()],
        key_unreliable: false,
    };
    let data_diff = DataDiff {
        target_driver: DriverKind::Postgres,
        table: "users".into(),
        columns: vec!["id".into(), "name".into()],
        primary_key: vec!["id".into()],
        column_types: vec!["int".into(), "varchar".into()],
        rows: vec![row_diff],
        truncated: false,
        source_count: 10,
        target_count: 10,
    };

    // --- #1096: Query/Preview ストリーミングメッセージ (Tauri Channel) --------
    //
    // `run_query_stream` / `preview_query_stream` は emit ペイロード構造体では
    // なく、`kind` タグ付き enum (`QueryStreamMessage` / `PreviewStreamMessage`)
    // を Channel で送る。`before`/`after` の行メッセージは `kind` 以外全く同じ
    // シェイプなので、フロント `schemaParity.test.ts` はどちらか一方
    // (`beforeRows`) のフィクスチャを before/after 共有の緩いスキーマで検証する
    // (旧 `streamRowsEventLite` と同じ発想、#825 の nestedOnly と同種の間接カバー)。
    //
    // このゴールデンは「zod スキーマの shape (キー集合) が Rust の実 serde 出力と
    // 一致するか」だけを見る構造パリティで、行の中身までは検証しない
    // (`queryStreamRowsMessageLite` は `z.array(z.unknown())`)。そのため行数や
    // 値を変えたバリアントを増やしてもキー集合は変わらず追加のカバレッジには
    // ならないが、CLAUDE.md の「境界ケースを追記する」規約に沿って構造上
    // 意味のある 2 点 — **空結果** (`rows: []` が `null` ではなく空配列で届く
    // ことの固定) と **キャンセル直後** (1 行も届く前に cancel した場合の
    // `deliveredRows: 0`) — を代表値の隣に追加する。「単一行」は既存の
    // `query_stream_rows_message` (`rows: [[1, "a"]]`) がそのまま該当し、
    // 「チャンク境界」はチャンクサイズという実行時パラメータの話であって
    // メッセージの JSON shape には現れないため、このゴールデン (フィールド名/
    // 型のパリティ) の対象外 — `execute_stream` のバッチ分割は
    // `tests/duckdb_integration.rs`
    // (`duckdb_execute_stream_delivers_batched_rows`) が、キャンセル直後に
    // 後続メッセージが無視される UI 側の挙動は
    // `src/__tests__/browser/scenarios.browser.test.tsx` の「停止ボタンで
    // キャンセルすると…以降のイベントは無視される」がそれぞれ担保する。

    let query_stream_columns_message = QueryStreamMessage::Columns {
        columns: vec![column.clone()],
    };
    let query_stream_rows_message = QueryStreamMessage::Rows {
        rows: vec![vec![Value::Int(1), Value::String("a".into())]],
    };
    // 境界ケース: 空の結果セット (0 行の SELECT)。`Vec::new()` は serde で必ず
    // `[]` になり `null` にはならないが、それを固定して回帰を防ぐ。
    let query_stream_rows_message_empty = QueryStreamMessage::Rows { rows: vec![] };
    let query_stream_done_message = QueryStreamMessage::Done {
        total_rows: 2,
        rows_affected: 0,
        elapsed_ms: 12,
        has_columns: true,
        applied_auto_limit: Some(1000),
    };
    let query_stream_error_message = QueryStreamMessage::Error {
        error: "connection reset by peer".into(),
        timed_out: false,
        connection_lost: true,
        delivered_rows: 5,
    };
    let channel_cancelled_message = QueryStreamMessage::Cancelled { delivered_rows: 5 };
    // 境界ケース: 列到着 (先頭チャンク) より前にキャンセルされた場合、1 行も
    // 届いていないので `deliveredRows: 0` になる (#685 のスケルトン段階キャンセル
    // シナリオ、`scenarios.browser.test.tsx` の「カラム到着前のスケルトン段階
    // でも停止ボタン (キャンセル導線) が出る」に対応)。
    let channel_cancelled_message_zero = QueryStreamMessage::Cancelled { delivered_rows: 0 };
    // Export/Dump/Import ストリームは引き続き `app.emit()` の名前付きイベントの
    // ままなので、`StreamCancelledEvent` (streamId を持つ) はここでも固定する。
    let stream_cancelled_event = StreamCancelledEvent {
        stream_id: "strm0001".into(),
        delivered_rows: 5,
    };
    let preview_meta_message = PreviewStreamMessage::Meta {
        target_table: Some("users".into()),
        columns: vec![column.clone()],
        primary_key: vec!["id".into()],
        rows_affected: 1,
        elapsed_ms: 3,
        truncated: false,
    };
    let preview_rows_message = PreviewStreamMessage::BeforeRows {
        rows: vec![vec![Value::Int(1), Value::String("a".into())]],
    };
    let preview_done_message = PreviewStreamMessage::Done {};
    let preview_error_message = PreviewStreamMessage::Error {
        error: "connection reset by peer".into(),
        timed_out: false,
        connection_lost: true,
        delivered_rows: 5,
    };

    let import_started_event = ImportStartedEvent {
        stream_id: "strm0003".into(),
        total: 100,
    };
    let import_progress_event = ImportProgressEvent {
        stream_id: "strm0003".into(),
        inserted: 50,
        total: 100,
    };
    let import_done_event = ImportDoneEvent {
        stream_id: "strm0003".into(),
        inserted: 99,
        elapsed_ms: 42,
        skipped: vec![SkippedRowInfo {
            record: 7,
            line: Some(8),
            reason: "duplicate key".into(),
        }],
    };
    let import_error_event = ImportErrorEvent {
        stream_id: "strm0003".into(),
        error: "NOT NULL constraint failed".into(),
        record: Some(3),
        line: Some(4),
    };

    let dump_progress_event = DumpProgressEvent {
        stream_id: "strm0004".into(),
        bytes: 65536,
        elapsed_ms: 500,
        tables: Some(2),
        tables_total: Some(5),
    };
    let dump_done_event = DumpDoneEvent {
        stream_id: "strm0004".into(),
        bytes: 131072,
        elapsed_ms: 1200,
    };
    let dump_error_event = DumpErrorEvent {
        stream_id: "strm0004".into(),
        error: "mysqldump exited with status 1".into(),
    };

    let export_progress_event = ExportProgressEvent {
        stream_id: "strm0005".into(),
        rows: 500,
    };
    let export_done_event = ExportDoneEvent {
        stream_id: "strm0005".into(),
        rows: 1000,
        bytes: 40960,
    };
    let export_error_event = ExportErrorEvent {
        stream_id: "strm0005".into(),
        message: "disk full".into(),
        rows: 200,
    };

    let connect_phase_event = ConnectPhaseEvent {
        attempt_id: "attempt0001".into(),
        phase: "tunnel_connecting",
    };

    json!({
        "column": column,
        "queryResult": query_result,
        "tableColumnInfo": table_column_info,
        "tableSchema": table_schema,
        "foreignKey": foreign_key,
        "indexInfo": index_info,
        "schemaObject": schema_object,
        "tableRowEstimate": table_row_estimate,
        "tableRowIdentity": table_row_identity,
        "tableSizeInfo": table_size_info,
        "serverVariable": server_variable,
        "serverInfo": server_info,
        "processInfo": process_info,
        "serverMetrics": server_metrics,
        "queryStatsSupport": query_stats_support,
        "liveQuery": live_query,
        "statementStat": statement_stat,
        "previewResult": preview_result,
        "healthFinding": health_finding,
        "skippedRule": skipped_rule,
        "schemaHealthReport": schema_health_report,
        "connectionProfile": connection_profile,
        "snippet": snippet,
        "historyEntry": history_entry,
        "logView": log_view,
        "csvPreview": csv_preview,
        "connectResult": connect_result,
        "localTableMeta": local_table_meta,
        "profileImportResult": profile_import_result,
        "cancelStreamResponse": cancel_stream_response,
        "knownHost": known_host,
        "schemaDiff": schema_diff,
        "syncPlan": sync_plan,
        "dataDiff": data_diff,

        // --- #1096: Query/Preview ストリーミングメッセージ (Tauri Channel) ---
        "queryStreamColumnsMessage": query_stream_columns_message,
        "queryStreamRowsMessageLite": query_stream_rows_message,
        // 境界ケース (空結果・キャンセル直後) — 上のコメント参照。
        "queryStreamRowsMessageLiteEmpty": query_stream_rows_message_empty,
        "queryStreamDoneMessage": query_stream_done_message,
        "queryStreamErrorMessage": query_stream_error_message,
        "channelCancelledMessage": channel_cancelled_message,
        "channelCancelledMessageZero": channel_cancelled_message_zero,
        "previewStreamMetaMessage": preview_meta_message,
        "previewStreamRowsMessageLite": preview_rows_message,
        "previewStreamDoneMessage": preview_done_message,
        "previewStreamErrorMessage": preview_error_message,
        // --- #825: CSV インポート/エクスポート/ダンプの emit ペイロード (名前付き
        // イベントのまま、#1096 のスコープ外) ---
        "streamCancelledEvent": stream_cancelled_event,
        "importStartedEvent": import_started_event,
        "importProgressEvent": import_progress_event,
        "importDoneEvent": import_done_event,
        "importErrorEvent": import_error_event,
        "dumpProgressEvent": dump_progress_event,
        "dumpDoneEvent": dump_done_event,
        "dumpErrorEvent": dump_error_event,
        "exportProgressEvent": export_progress_event,
        "exportDoneEvent": export_done_event,
        "exportStreamErrorEvent": export_error_event,
        "connectPhaseEvent": connect_phase_event,
    })
}

#[test]
fn serde_response_fixtures_match_checked_in() {
    let actual = build_fixtures();

    // 意図的にレスポンス型を変えたときの再生成経路。
    if std::env::var("NOOBDB_WRITE_SERDE_FIXTURES").is_ok() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/__tests__/fixtures/serdeResponseFixtures.json"
        );
        let mut pretty = serde_json::to_string_pretty(&actual).expect("serialize fixtures");
        pretty.push('\n');
        std::fs::write(path, pretty).expect("write fixtures");
        eprintln!("wrote serde fixtures to {path}");
        return;
    }

    let expected: serde_json::Value =
        serde_json::from_str(FIXTURE_JSON).expect("checked-in serde fixtures must be valid JSON");

    assert_eq!(
        actual, expected,
        "serde が吐く JSON が共有フィクスチャとズレています。レスポンス型を意図的に\n\
         変更した場合は `NOOBDB_WRITE_SERDE_FIXTURES=1 cargo test --test serde_schema_parity`\n\
         でフィクスチャを再生成し、フロント (schemaParity.test.ts) も合わせて確認してください。"
    );
}
