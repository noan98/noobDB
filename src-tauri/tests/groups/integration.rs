//! 外部サービスなしで常時走る統合テスト (SQLite 中心) の束ね役。
//! リンク回数を減らすため 1 つの実行ファイルにまとめている。
//!
//! 個々のテストファイルは `tests/<名前>.rs` のまま置き、ここから `#[path]` で取り込む
//! (`include_str!` の相対パスやドキュメント上の参照先を変えないため)。新しいテストを足すときは
//! ファイルを作ってここに `mod` を 1 行足す (足し忘れるとそのテストは走らない)。

#[path = "../local_query_integration.rs"]
mod local_query_integration;
#[path = "../query_result_cache_integration.rs"]
mod query_result_cache_integration;
#[path = "../result_handle_sqlite.rs"]
mod result_handle_sqlite;
#[path = "../sandbox_integration.rs"]
mod sandbox_integration;
#[path = "../schema_cache_integration.rs"]
mod schema_cache_integration;
#[path = "../script_runner_integration.rs"]
mod script_runner_integration;
#[path = "../search_integration.rs"]
mod search_integration;
#[path = "../sqlite_integration.rs"]
mod sqlite_integration;
#[path = "../stream_batching_sqlite.rs"]
mod stream_batching_sqlite;
#[path = "../sync_apply_integration.rs"]
mod sync_apply_integration;
#[path = "../timeout_cancel_pool.rs"]
mod timeout_cancel_pool;
#[path = "../transfer_integration.rs"]
mod transfer_integration;
