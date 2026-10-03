//! 外部 DB / SSH サーバを必要とする統合テスト (環境変数 NOOBDB_TEST_* が無ければスキップ) の束ね役。
//! リンク回数を減らすため 1 つの実行ファイルにまとめている。
//!
//! 個々のテストファイルは `tests/<名前>.rs` のまま置き、ここから `#[path]` で取り込む
//! (`include_str!` の相対パスやドキュメント上の参照先を変えないため)。新しいテストを足すときは
//! ファイルを作ってここに `mod` を 1 行足す (足し忘れるとそのテストは走らない)。

// mysql / postgres が共有するヘルパ。複数の `mod common;` から同じファイルを読むと
// clippy::duplicate_mod になるので、ここで 1 度だけ取り込む。
#[path = "../common/mod.rs"]
mod common;

#[path = "../mysql_integration.rs"]
mod mysql_integration;
#[path = "../postgres_integration.rs"]
mod postgres_integration;
#[path = "../ssh_integration.rs"]
mod ssh_integration;
#[path = "../tls_integration.rs"]
mod tls_integration;
