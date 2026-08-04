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

use std::path::PathBuf;

use noobdb_lib::__test_api as t;
use serde_json::json;
use t::{
    CancelStreamResult, Column, ColumnDiff, ConnectPhaseEvent, ConnectResponse, ConnectionProfile,
    CsvPreview, DataDiff, DiffStatus, DriverKind, DumpDoneEvent, DumpErrorEvent, DumpProgressEvent,
    ExportDoneEvent, ExportErrorEvent, ExportProgressEvent, ForeignKey, HealthFinding,
    HistoryEntry, ImportDoneEvent, ImportErrorEvent, ImportProgressEvent, ImportResult,
    ImportStartedEvent, IndexInfo, KnownHost, LiveQuery, LocalTableMeta, LogView, PreviewDoneEvent,
    PreviewMetaEvent, PreviewResult, ProcessInfo, ProfileWithSecretFlags, QueryResult,
    QueryStatsSupport, RowDiff, RowStatus, RuleId, SchemaDiff, SchemaHealthReport, SchemaObject,
    ServerInfo, ServerMetrics, ServerVariable, Severity, SkippedRowInfo, SkippedRule, Snippet,
    SnippetScope, SshAuthMethod, SshProfile, SslMode, StatementStat, StreamCancelledEvent,
    StreamColumnsEvent, StreamDoneEvent, StreamErrorEvent, StreamRowsEvent, SyncKind, SyncPlan,
    SyncStatement, TableColumnInfo, TableDiff, TableRowEstimate, TableSchema, TableSizeInfo, Value,
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

    // --- #825: ストリーミングイベントの emit ペイロード -----------------------
    //
    // `preview_query_stream` の行イベント (`PreviewRowsEvent`) は `StreamRowsEvent`
    // と全く同じシェイプ ({ streamId, rows }) なので個別のフィクスチャは持たず
    // `streamRowsEventLite` で間接的にカバーする (フロント `schemaParity.test.ts`
    // の nestedOnly と同じ発想)。`StreamCancelledEvent` は
    // query/preview/export/import の cancelled イベントで共有され、`dump-stream:
    // cancelled` も同一シェイプの `dumpCancelledEvent` zod スキーマで受けるため、
    // フロント側は同じフィクスチャを両スキーマに対して検証する。

    let stream_columns_event = StreamColumnsEvent {
        stream_id: "strm0001".into(),
        columns: vec![column.clone()],
    };
    let stream_rows_event = StreamRowsEvent {
        stream_id: "strm0001".into(),
        rows: vec![vec![Value::Int(1), Value::String("a".into())]],
    };
    let stream_done_event = StreamDoneEvent {
        stream_id: "strm0001".into(),
        total_rows: 2,
        rows_affected: 0,
        elapsed_ms: 12,
        has_columns: true,
        applied_auto_limit: Some(1000),
    };
    let stream_error_event = StreamErrorEvent {
        stream_id: "strm0001".into(),
        error: "connection reset by peer".into(),
        timed_out: false,
        connection_lost: true,
        delivered_rows: 5,
    };
    let stream_cancelled_event = StreamCancelledEvent {
        stream_id: "strm0001".into(),
        delivered_rows: 5,
    };
    let preview_meta_event = PreviewMetaEvent {
        stream_id: "strm0002".into(),
        target_table: Some("users".into()),
        columns: vec![column.clone()],
        primary_key: vec!["id".into()],
        rows_affected: 1,
        elapsed_ms: 3,
        truncated: false,
    };
    let preview_done_event = PreviewDoneEvent {
        stream_id: "strm0002".into(),
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

        // --- #825: ストリーミングイベントの emit ペイロード ---
        "queryStreamColumnsEvent": stream_columns_event,
        "streamRowsEventLite": stream_rows_event,
        "queryStreamDoneEvent": stream_done_event,
        "queryStreamErrorEvent": stream_error_event,
        "streamCancelledEvent": stream_cancelled_event,
        "previewStreamMetaEvent": preview_meta_event,
        "previewStreamDoneEvent": preview_done_event,
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
