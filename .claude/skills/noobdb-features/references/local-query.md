# ローカル横断クエリ (#740)

## ローカル横断クエリ (#740)

複数接続の結果セットをローカルエンジンへ取り込み、異種 DB 間 JOIN・再分析を 1 アプリ内で
完結させる機能です。第 1 候補は DuckDB (#709) でしたが、本実装は #709 に先行しないため
**既にフル依存済みの組み込み SQLite をインメモリ相当 (一時ファイル) で使う縮退構成**を
採用しています。将来 DuckDB へ差し替える場合は `db::Connection` の `Sqlite` 版
`register_local_table` / `list_local_tables` / `drop_local_table` / `vacuum_into` を
新バリアントへ実装し直すだけで、`commands/local.rs` (IPC 層) は無改修で済む設計です。

- **「ローカル」接続 = 駆動元セッションを持たない特殊セッション**。`create_local_session`
  が OS 標準の一時領域 (`std::env::temp_dir()/noobdb-local/`) に空の SQLite ファイルを
  touch し、既存の `Connection::Sqlite` としてそのまま開きます。以降のクエリ実行は
  **既存の `run_query` / `run_query_stream` 等をそのまま再利用**し、新しい実行経路は
  一切増やしていません。フロント (`App.tsx`) はこの「ローカル」を実在しない擬似
  `ConnectionProfile` (`id: "__local__"`、`driver: "sqlite"`) として扱い、`handleConnect`
  内で `id` を見て `api.connect` の代わりに `api.createLocalSession` を呼ぶ以外は、
  複数同時接続のタブ切替・タブ復元・エディタ・グリッド・エクスポートを他の接続と
  完全に共有します。
- **登録**: `register_local_table` が `db::types::{Column, Value}` (既存のワイヤ
  フォーマットそのもの) を受け取り、`db::sqlite::SqliteConn::register_local_table` が
  1 トランザクションで「テーブル作成 (無型宣言 = BLOB affinity で値を無変換のまま保持) →
  行 INSERT (`Value` を文字列往復させず直接 bind — `Bytes` は実 BLOB に、`Int`/`Float`/
  `Bool` はそれぞれの storage class に、`Null` は SQL NULL に) → 由来メタデータ upsert」
  まで行います。無型宣言のカラムは SQLite の BLOB affinity (無変換) を利用しており、
  型付き `Value` から文字列を経由しない分、CSV インポート系の文字列ベース経路より
  高精度に往復します。取り込み対象は**在メモリの取得済み行のみ**で、上限
  `MAX_LOCAL_TABLE_ROWS = 200_000` (バックエンド `commands/local.rs` とフロント
  `components/localQuery.ts` の同名定数で表現) を超える登録はバックエンドが拒否します。
- **由来メタデータ**は隠しカタログテーブル `__noobdb_local_meta` (ローカル DB 自身の中、
  初回登録時に遅延作成) に保存し、`LocalTableMeta` (元の接続名・実行 SQL・ドライバ・
  登録日時・行数) として `list_local_tables` で返します。セッション固有の `AppState`
  側の別管理は持たず、ローカル DB ファイル自体がこの状態の単一の情報源です。
- **置き場所は全ユーザ共有なので、権限と所有者を検証してから使う (Unix)**:
  `std::env::temp_dir()/noobdb-local/` には複数 DB を横断結合した**実データ**が入る
  一方、`/tmp` は誰でも書ける固定パスです。ディレクトリは `0700` で作成し、既に
  存在する場合は「シンボリックリンクでない・実ディレクトリである・所有者が自分・
  group/other に権限が無い」の 4 点を `symlink_metadata` (lstat) で確認してから使い、
  満たさなければ**黙って使わずエラーで拒否**します (攻撃者に先回りで作られた
  ディレクトリやリンクへ書き込まないため)。SQLite ファイル自体も `create_new`
  (`O_CREAT|O_EXCL`、リンクを辿らない) + `mode(0o600)` で作ります
  (`dump.rs::DefaultsFile::create` と同じパターン)。`cleanup_stale_local_files` も
  同様に lstat してから消すので、`noobdb-local` がリンクへ差し替えられていても
  リンク先を再帰削除しません。
- **既定揮発 / 明示操作でのみ永続化**: バッキングファイルは OS 標準の一時領域に置き、
  `disconnect` 時に削除します (`Session.local_temp_file` の有無で「ローカルセッション
  かどうか」を判別)。アプリ異常終了で削除が走らなくても、次回起動時に
  `commands::local::cleanup_stale_local_files` が同ディレクトリを丸ごと掃除します
  (前回起動のセッションはどのみち全て無効なので安全)。「ファイルに保存」は
  `save_local_database` → SQLite の `VACUUM INTO` で独立したスナップショットファイルを
  書き出すだけで、元のセッション自体の揮発性は変えません。
- **UI**: `ResultGrid` の「ローカルに登録」ボタン (`RegisterLocalTableModal` で名前確認
  + 件数/上限/プライバシー注記を表示) と、サイドバーの「ローカル」タブ
  (`LocalTablesPanel`。登録済みテーブルの由来一覧・削除・ファイル保存)。安全性/
  プライバシーの明示 (外部送信なし、ここでの書き込みは元接続に反映されない) は
  モーダル文言に集約しています。
- 統合テストは `tests/local_query_integration.rs` に集約 (SQLite ベースで外部サーバ
  不要・常時実行)。異種「接続」2 つ (別々の temp SQLite ファイルで模擬) からの登録 →
  JOIN、BLOB/NULL/日時の往復、上限行数超過の拒否、非ローカルセッションへの誤呼び出し
  拒否、`VACUUM INTO` によるファイル保存を検証します。
