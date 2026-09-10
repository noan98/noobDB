# ストリーミングクエリ実行とキャンセル

## ストリーミングクエリ実行とキャンセル

エディタからのクエリは `run_query_stream` (`commands/query.rs`) で実行され、結果は
イベント (`query-stream:columns` / `:rows` / `:done` / `:error`) として段階的に
フロントへ送られます。`run_query_stream` は Tokio タスクを spawn し、その
`AbortHandle` を `AppState.streams` にクライアント提供の `stream_id` で登録します。
`cancel_stream` がそのハンドルを abort し、ストリーミング future を drop することで
プールへ接続が返ります。`query_timeout_secs` が正のときは `tokio::time::timeout` で
実行全体をレースし、超過時は `AppError::Timeout` を返します。

「ドライラン」プレビュー (`preview_query_stream`) はトランザクション内で SQL を実行
してロールバックし、対象テーブルの before/after スナップショット (PK でペアリング) を
`preview-stream:*` イベントで返します。CSV インポート (`import_csv`) とインラインセル
編集 Apply (`run_query_transaction`) も同じストリーム/トランザクション方式
(all-or-nothing) を踏襲します。新しいストリーミングコマンドを足すときは、この
イベント命名・`register_stream`/`forget_stream`・`stream_id` フィルタの 3 点セットに
合わせてください。

**`stream_id` はクライアントが指定する値なので、登録は世代トークンで守ります。**
`register_stream` は登録ごとにトークンを発行して返し、`forget_stream(stream_id, token)`
はトークンが一致する登録だけを消します。これが無いと「同じ id を再利用した新しい
タスクの登録を、先に終わった古いタスクの後始末が消す」競合が起き、`cancel_stream` が
`{cancelled: false}` を返す**キャンセル不能なストリーム**が DB 接続や SSH トンネルを
掴んだまま残ります (接続試行側の `register_connect`/`forget_connect` (#684) と同じ
方式です)。

`preview_query_stream` も `run_query_stream` と同じく `query_timeout_secs` を受け取り
`tokio::time::timeout` でレースします。ドライランは読み取り専用セッションからも呼べる
ため、タイムアウトが無いとロック待ちする `UPDATE` のプレビューで接続と行ロックを無期限に
握れてしまいます。

なお、プレビューの before/after スナップショットを組み立てる純粋ロジック
(ユーザの `WHERE` の抽出、BEFORE で捕まえた PK による AFTER の取り直し) は
**`db/preview.rs`** に集約し、MySQL と PostgreSQL が共有します。ここを共有していな
かった頃は PostgreSQL 側だけ「PK 昇順の先頭 N 件」を撮るだけの実装で、対象行が窓の外に
あると diff が「変更なし」に見える取りこぼしがありました。方言差 (ドル引用、
`RETURNING` の切り落とし、`UPDATE ... FROM` / `DELETE ... USING` の失格判定) は
`SqlFlavor` で分岐します。
