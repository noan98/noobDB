# アーキテクチャ概要

2 プロセス構成と、Tauri `setup` フックの落とし穴。

noobDB は MySQL / PostgreSQL / SQLite / DuckDB (#709) / Microsoft SQL Server (#729)
に対応した軽量デスクトップ DB クライアントで、SSH トンネルをファーストクラスで
サポートします。Rust バックエンド (`rust-version` 1.77、edition 2021) は `sqlx`
(`tls-rustls`。MySQL/PostgreSQL/SQLite の 3 ドライバが使う)、DuckDB 専用の `duckdb`
(bundled)、MSSQL 専用の `tiberius`、`russh`、`keyring` などに依存しています
(バージョンの正は `src-tauri/Cargo.toml`)。

## 2 プロセス構成

- **フロントエンド** (`src/`): React 19 + TypeScript + Vite。UI の状態はすべて
  ここで保持しますが、セッションやプロファイルに関してはバックエンドの状態が
  正となります。UI から Rust への通信は `invoke(...)` のみ — `src/api/tauri.ts`
  が Tauri コマンド全体への型付けされた単一のラッパーです。JS 側の引数名は
  camelCase の規約 (例: `sessionId`) で、Tauri が自動的に Rust 側の `snake_case`
  に変換します。ストリーミングコマンドの結果は `invoke` の戻り値ではなくイベント
  (`listen`) で受け取ります — `tauri.ts` の `listenQueryStream` /
  `listenPreviewStream` / `listenImportStream` を参照。
- **バックエンド** (`src-tauri/src/`): Tauri 2 + Tokio。`lib.rs::run()` で IPC
  ハンドラを登録し、`AppState` を Tauri 管理ステートとしてインストールします。
  `tracing` でログを出力し、`main.rs` は薄いシムで `noobdb_lib::run()` を呼ぶだけです。

## `setup` フックでは `tokio::spawn` を使わないこと

`lib.rs::run()` の `.setup(...)` フックは、Tauri がイベントループの `Ready`
ハンドラ (= **メインスレッド**) から呼び出します (`tauri::app::setup`)。ここには
**Tokio ランタイムのコンテキストが入っていません** — Tauri は `setup` を
`async_runtime::block_on` で包まないためです。したがって `setup` の中で
`tokio::spawn` / `tokio::time` などスレッドローカルのランタイムハンドルを要求する
API を呼ぶと `there is no reactor running, must be called from the context of a
Tokio 1.x runtime` で **panic** します。**`setup` から常駐タスクを起動するときは
`tauri::async_runtime::spawn` を使ってください** (グローバルランタイムのハンドルへ
直接投げるためランタイム外から呼んでも安全。投入後のタスク内では通常どおり
`tokio::spawn` / `tokio::time::sleep` が使えます)。IPC コマンドハンドラ
(`#[tauri::command] async fn`) は Tauri の非同期ランタイム上で実行されるため、
そちらでの `tokio::spawn` は従来どおり問題ありません (`commands/query.rs` などの
ストリーミング経路)。

この panic は**ウィンドウ生成の後**に起きます (`tauri::app::setup` は設定ファイルの
ウィンドウを先に build してからユーザの `setup` を呼ぶ) — 症状は「真っ白なウィンドウが
一瞬表示された直後にプロセスが終了」で、リリースビルドは
`windows_subsystem = "windows"` によりコンソールを持たないため panic メッセージも
表示されません (v0.9.0 のインストール後クラッシュの原因)。`tracing` のログにも
残らないため、`<data_dir>/noobdb.log` は `noobDB starting` で途切れます。回帰テストは
`tasks/scheduler.rs` の `spawn_detached_works_outside_a_tokio_runtime` (素の
`#[test]` = ランタイム外から呼ぶことで本番と同じ条件を再現) が固定しています。
