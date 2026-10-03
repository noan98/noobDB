//! 共有ゴールデンベクタ (src/__tests__/fixtures/*.json) を Rust 実装へ通すテストと、キャッシュ無効化マトリクスの束ね役。
//! 以前は 1 ファイル = 1 実行ファイルで、Tauri / sqlx / russh を含むテストバイナリを
//! ファイルの数だけリンクしていた (特に Windows の PDB 書き出しが重い)。1 本にまとめてリンクを減らす。
//!
//! 個々のテストファイルは `tests/<名前>.rs` のまま置き、ここから `#[path]` で取り込む
//! (`include_str!` の相対パスやドキュメント上の参照先を変えないため)。新しいテストを足すときは
//! ファイルを作ってここに `mod` を 1 行足す (足し忘れるとそのテストは走らない)。

#[path = "../auto_limit_golden.rs"]
mod auto_limit_golden;
#[path = "../cache_invalidation_matrix.rs"]
mod cache_invalidation_matrix;
#[path = "../data_search_golden.rs"]
mod data_search_golden;
#[path = "../diff_sync_golden.rs"]
mod diff_sync_golden;
#[path = "../error_hint_golden.rs"]
mod error_hint_golden;
#[path = "../error_kind_golden.rs"]
mod error_kind_golden;
#[path = "../export_format_golden.rs"]
mod export_format_golden;
#[path = "../introspection_golden.rs"]
mod introspection_golden;
#[path = "../mask_golden.rs"]
mod mask_golden;
#[path = "../object_search_golden.rs"]
mod object_search_golden;
#[path = "../plan_watch_golden.rs"]
mod plan_watch_golden;
#[path = "../query_shape_golden.rs"]
mod query_shape_golden;
#[path = "../read_only_golden.rs"]
mod read_only_golden;
#[path = "../result_ops_golden.rs"]
mod result_ops_golden;
#[path = "../schema_mutating_golden.rs"]
mod schema_mutating_golden;
#[path = "../script_split_golden.rs"]
mod script_split_golden;
#[path = "../sql_quoting_golden.rs"]
mod sql_quoting_golden;
#[path = "../ssh_host_key_mismatch_golden.rs"]
mod ssh_host_key_mismatch_golden;
#[path = "../statement_split_golden.rs"]
mod statement_split_golden;
#[path = "../where_used_golden.rs"]
mod where_used_golden;
