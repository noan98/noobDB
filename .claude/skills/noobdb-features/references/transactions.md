# 明示的トランザクション

## 明示的トランザクション

ストリーミング/オートコミット経路 (`run_query` 等) とは別に、UI のインラインセル編集や
複数文の対話的実行のために**明示的なトランザクション境界**を張る IPC があります。
`begin_transaction` → `run_in_transaction` (複数回) → `finish_transaction(commit)` の
3 コマンドが `db::Connection` の `begin_transaction` / `execute_in_transaction` /
`finish_transaction` / `transaction_active` にマップされ、セッションが内部に抱える
トランザクションハンドル上で実行されます。`run_query_transaction` (all-or-nothing の
文配列をまとめて投入する従来経路) とは別物で、こちらは**開いたまま複数の往復**を
できる点が違います。読み取り専用セッションでは書き込み文が拒否される点は同じです。

**MySQL の DDL は非原子である点に注意 (#640)。** `run_query_transaction` /
`apply_sync_sql` が使う `execute_transaction` は「begin → 逐次実行 → commit、失敗時
rollback」の all-or-nothing 実装ですが、**MySQL/MariaDB は DDL (`CREATE` / `ALTER` /
`DROP` / `TRUNCATE` / `RENAME` 等) を実行した時点で暗黙コミット**します。そのため
`["CREATE TABLE t ...", "INSERT INTO t ... (失敗)"]` のような **DDL+DML 混在バッチ**では、
後続 DML が失敗してロールバックしても先行の `CREATE TABLE` は残り、all-or-nothing が
崩れます。これは MySQL 固有の制約で `execute_transaction` 側では吸収できないため、
**方針は「非原子性を明示する」**とし、`db/mysql.rs::execute_transaction` のドキュメント
コメントに詳細を記載しています (分割・事前検証はしない)。`apply_sync_sql` は既に MySQL で
best-effort 逐次のため整合します。**スキーマ変更の原子性が必要な呼び出し側は、1 回の
`execute_transaction` に DDL と DML を混ぜないでください。** PostgreSQL は
トランザクショナル DDL なので同シナリオで `CREATE` もロールバックされ、この問題は
ありません。ドライバ差は `mysql_integration::mysql_ddl_dml_mixed_batch_is_not_atomic` /
`postgres_integration::postgres_ddl_dml_mixed_batch_rolls_back` の対比テストで固定して
います (環境変数ゲート、未設定ならスキップ)。

## 開始オプション: 分離レベルと READ ONLY (#1166)

`begin_transaction` は任意引数 `isolation` (`read-uncommitted` / `read-committed` /
`repeatable-read` / `serializable`) と `readOnly` を受ける (省略でサーバ既定、後方互換)。
SQL 片は `db/tx_options.rs` の enum (`TxIsolation`) からのみ組み立て、文字列連結しない。

| ドライバ | 発行 |
|---|---|
| MySQL | `SET TRANSACTION ISOLATION LEVEL ...` を `START TRANSACTION` の**前**に (次の 1 TX だけに効く)。READ ONLY は `START TRANSACTION READ ONLY` |
| PostgreSQL | `BEGIN ISOLATION LEVEL ... READ ONLY` の 1 文。READ UNCOMMITTED は READ COMMITTED 扱い |
| SQLite | 非対応。指定されると `InvalidInput` で拒否 (黙って無視しない)。UI もトグルを無効化 |

フロントの判定は `src/txOptions.ts` (`supportsTxOptions` / `resolveTxOptions`)。

## SAVEPOINT / 部分ロールバック (#1418)

明示トランザクション上に `create_savepoint` / `rollback_to_savepoint` / `release_savepoint`
(いずれも `sessionId` + `name`) を足している。3 ドライバとも構文は共通
(`SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT`)。SQL 組み立ては
`db/savepoint.rs` (純ロジック): 名前は `[A-Za-z_][A-Za-z0-9_]{0,62}` のみ許可し、さらに
`sync::quote_ident` でクォートする。`execute_in_transaction` と同じ保持接続で流すので
トランザクションが無ければエラー。SAVEPOINT 自体は書き込みではないため読み取り専用
ガードは通さない (書き込み文は `run_in_transaction` のガードが従来どおり拒否)。

DB の意味論: `ROLLBACK TO` は指定 SAVEPOINT を残し新しいものを破棄、`RELEASE` は指定と
新しいものを破棄。PostgreSQL ではエラーで aborted になった TX も `ROLLBACK TO` で回復できる。
フロントはスタックを `src/savepoints.ts` (`afterRollbackTo` / `afterRelease`) で同じ
意味論に追従させ、`SavepointControl` (TX 中のヘッダのメニュー) から操作する。
書き込み承認 (`requireWriteApproval`) と同じ条件 (本番 + `confirm_writes`、読み取り専用を除く) のときだけ ROLLBACK TO の確認ダイアログを出す (UI レベルのみ)。

MySQL は SAVEPOINT をプリペアド文で受け付けない (1295) ため、`Connection::execute_tx_control` が
MySQL だけ保持接続へ `raw_sql` で流す。PostgreSQL は aborted (25P02) のまま COMMIT すると
黙って ROLLBACK 扱いになるので、`tx_finish` が検出してエラーにする (トランザクションは終了扱い)。
