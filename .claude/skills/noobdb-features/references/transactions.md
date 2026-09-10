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
