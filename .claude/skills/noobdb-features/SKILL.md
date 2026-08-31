---
name: noobdb-features
description: noobDB の機能レイヤを変更するとき — エクスポート/ダンプ/インポート、明示的トランザクション、スキーマ・データ比較と同期 (Diff/Sync)、サンドボックス、プロセス管理、ユーザ/権限管理、ローカル横断クエリ、タスクスケジューラ、DML フライトレコーダーと Undo、スキーマ健全性アドバイザ、ライブクエリ・インスペクタ、アプリ内自動更新を扱うときに読む。
---

# noobDB の機能レイヤ

`commands/` の各モジュールが担う機能群です。全体に共通する設計方針:

- **純粋計算層 (`db/`) と IPC 層 (`commands/`) を分離する。** 純粋層はドライバ
  非依存・副作用なしで単体テストできる形に保ちます (Diff/Sync、サンドボックス、
  アドバイザ、Undo がこの形)。
- **既存の実行基盤を再利用し、DB への新しい書き込み経路を増やさない。**
  サンドボックスの書き戻しは `apply_sync_sql`、Undo の適用は
  `run_query_transaction`、タスクのエクスポートは `export_query_stream` を
  そのまま通ります。結果として既存の安全網 (read_only 拒否、トランザクション適用、
  履歴記録) がそのまま効きます。
- **SQL のレンダリングを二重実装しない。** 逆方向 SQL も同期 SQL も
  `db::data_diff::generate_data_sync_sql` / `db::sync::quote_ident` を共有します。

## 参照

| ファイル | 内容 |
|---|---|
| `references/data-io.md` | CSV/JSON/NDJSON/Markdown/SQL のエクスポート、`mysqldump` 連携、インポートのエラー行処理 |
| `references/transactions.md` | 明示的トランザクション境界。**MySQL の DDL は暗黙コミットで非原子**な点に注意 |
| `references/diff-sync.md` | スキーマ/データ比較と同期 SQL の生成 |
| `references/sandbox.md` | 壊せる砂場 (#747)。影テーブル・競合検出・書き戻し |
| `references/server-admin.md` | プロセス監視/KILL、ユーザ・権限管理 (#732) |
| `references/local-query.md` | ローカル横断クエリ (#740)。一時領域の権限検証が要点 |
| `references/scheduler.md` | タスクスケジューラ (#730)。UTC 固定・読み取り専用限定 |
| `references/flight-recorder.md` | DML フライトレコーダーと Undo (#735) |
| `references/diagnostics.md` | スキーマ健全性アドバイザ (#741)、ライブクエリ・インスペクタ (#746)、サーバ情報 (#563)、スキーマドリフト (#736) |
| `references/updater.md` | アプリ内自動更新 (#705)。**公開鍵はプレースホルダのまま** |

## 書き込み経路のガードは自動では効きません

`is_read_only_sql` は SQL 文を通る経路にしか効きません。**SQL 文ではない書き込み**
(`kill_process` / `apply_sync_sql` / `apply_privilege_sql` / `import_csv` /
`sandbox_advance_base`) は**コマンド側で明示的に `read_only` を拒否**しています。
同種のコマンドを追加するときは同じガードを入れてください。

また `sandbox_session_id` のようにセッション ID を受け取るコマンドは、**そのセッションが
本当にそのサンドボックス/ローカル DB のものかを検証**してから使います
(`get_sandbox_session` / `get_local_session`)。検証が無いと IPC を直接叩いて
本番の読み取り専用接続を対象にできてしまいます。
