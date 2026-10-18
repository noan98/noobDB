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

**保持ポリシーは行数と期間の 2 本立て (#1539)。** 行数上限は `MAX_HISTORY_ROWS` (10,000 件、
`id` の古い順に削除)。加えて期間上限 `retention_days` (0 = 無効が既定、最大 3650 日) を
`get_history_retention_days` / `set_history_retention_days` で持つ。値は同じ `history.sqlite` の
`history_settings` テーブルに保存して `pool()` 初期化時にプロセス内キャッシュへ読み込む
(フロントの localStorage 設定ではない。履歴を書く Rust 側の全経路が同じ値を参照でき、
起動直後の同期が要らない)。挿入のたびに `prune_expired` が `julianday(executed_at)` で比較して
期限切れの行を削除する (最古行が期限内なら全件走査しない)。`set_*` は保存と同時に
即時削除し、削除件数を返す。flight_recorder の `retention_days` と同じ意味。UI は設定画面の
「クエリ履歴」セクション。

## スニペット

`snippets/store.rs` は保存済み SQL を JSON ファイルに永続化します。`Snippet` は
`folder`・`tags`・対象 `driver` (任意)・`scope` (`SnippetScope`: `Any` / `Profile` /
`Group`) を持ち、scope で「どの接続のときに表示するか」を絞り込めます。プロファイルと
同じ 8 文字スラッグを ID に使います。

**タブストップ記法 (#1489、フロント完結・保存形式は変えない)。** 本文の `${1:既定値}` /
`${1}` / `${name}` / `${0}` は、エディタへ挿入するとき (`QueryEditorHandle.insertSnippet`) と
補完 (`components/sqlSnippetCompletion.ts`) で CodeMirror の `snippet()` に載り、Tab /
Shift+Tab でフィールドを巡回する。パーサは `src/snippetTemplate.ts`。**素の `$1` / `$$` は
タブストップにしない** (PostgreSQL のパラメータ・ドル引用との後方互換)、`{{name}}` (実行時
パラメータ) は `$` を伴わないので衝突しない、記法を含まない本文は従来どおり平文挿入。
新規タブ・ワンクリック実行など エディタを介さない経路は `snippetPlainText` で既定値に置換した
平文を使う。補完候補は `scopeMatches` で現在の接続に合うものだけ (`App.tsx` の `completionSnippets`)。
