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

use noobdb_lib::__test_api as t;
use serde_json::json;
use t::{
    Column, ForeignKey, IndexInfo, LiveQuery, PreviewResult, ProcessInfo, QueryResult,
    QueryStatsSupport, SchemaObject, ServerInfo, ServerMetrics, ServerVariable, StatementStat,
    TableColumnInfo, TableRowEstimate, TableSchema, TableSizeInfo, Value,
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
