# クエリ履歴とスニペット

## クエリ履歴

`history/store.rs` は data_dir 内の `history.sqlite` に SQLite (`sqlx`) で履歴を
記録します。プールは初回利用時に遅延オープンされ、`query_history` テーブルとインデックス
を `CREATE TABLE IF NOT EXISTS` で用意するため、新規インストールでもマイグレーション
手順は不要です。記録はストリーミング実行パスと書き込みパス (`run_query_transaction`・
`import_csv`) のみが行い、ページングや編集用の内部クエリは履歴を汚しません。記録は
ベストエフォートで、失敗してもログに残すだけで呼び出し元には伝播しません。`skip_history`
フラグが立ったセッションは一切記録しません。検索は SQL 本文への大小無視部分一致で、
LIKE ワイルドカードはエスケープされます。

**一覧は SQL 全文を運ばない (#1256)。** `list_history` の各行は空白を畳んだ先頭 400
文字の `sql_preview` (超過は `…`) と全文の文字数 `sql_len` だけを持ち、全文は
`get_history_sql(id)` を復元・コピー・新規タブ・スニペット保存の時点で呼んで取る。
エディタの ↑/↓ ナビとコマンドパレット用には `list_history_sql(profile_id, limit)` が
SQL 全文だけを返す (実行のたびの再取得はせず、実行直後の SQL はフロントが先頭へ積む)。

## スニペット

`snippets/store.rs` は保存済み SQL を JSON ファイルに永続化します。`Snippet` は
`folder`・`tags`・対象 `driver` (任意)・`scope` (`SnippetScope`: `Any` / `Profile` /
`Group`) を持ち、scope で「どの接続のときに表示するか」を絞り込めます。プロファイルと
同じ 8 文字スラッグを ID に使います。
