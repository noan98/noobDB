# SQL 安全網 (読み取り専用ガード / 自動 LIMIT / ゴールデンベクタ)

`is_read_only_sql`・`apply_auto_limit`・リテラルマスク・言語横断ゴールデンベクタの設計。

## 読み取り専用ガードと自動 LIMIT

`db/mod.rs` の `is_read_only_sql` は、読み取り専用プロファイルで許可してよい文かを
判定する**ベストエフォートの安全網** (パーサではない) です。許可リストは `SELECT` /
`SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `WITH`。コメントと文字列リテラルをマスク
したうえで、隠れた 2 文目 (`SELECT 1; DELETE ...`)、書き込み/DDL キーワード、データ
変更 CTE、`SELECT ... INTO`、ロック付き SELECT (`FOR UPDATE` 等) を弾きます。
`commands::query` の各エントリポイントは `ensure_allowed_for_session` でこのガードを
通します。

**マスクはドライバごとに切り替えます (#852)。** バックスラッシュを文字列リテラルの
エスケープ文字と見なすのは **MySQL/MariaDB だけ**で、PostgreSQL
(`standard_conforming_strings = on`) / SQLite / DuckDB / MSSQL では `\` はただの
文字です。以前はどのドライバでも MySQL 流のマスク (`backslash_escapes = true`) を
使っていたため、`SELECT '\'; DELETE FROM t; --'` のような入力で「まだ文字列の中」と
誤読し、隠れた `;` も `delete` も見えないまま**フェイルオープン**していました
(`is_session_init_sql` だけは先に修正済みで、その判断を残り 3 つの安全網へ横展開した
のが #852)。現在の構成は:

- `mask_for_driver(driver, src)` が `driver_backslash_escapes(driver)` でマスク規則を
  選ぶ。`*_for(driver, ...)` 系の入口 — `is_read_only_sql_for` /
  `has_stacked_statements_for` / `apply_auto_limit_for` / `classify_write_kind_for` —
  はすべてこれを通る。呼び出し側 (`commands::query` の
  `ensure_allowed_for_session` / auto-refresh / broadcast ガード、`commands::export`、
  `commands::flight_recorder`、各ドライバの `preview_execute_with_limit`) は
  `session.conn.driver_kind()` を渡す。
- **ドライバを知らない呼び出し口** (`is_read_only_sql` / `has_stacked_statements` /
  `apply_auto_limit` / `classify_write_kind` の引数なし版) は
  `mask_for_analysis_conservative` に倒す。文字列リテラルは MySQL 流マスクより
  **早くしか閉じない**ため、キーワードは隠れず露出する方向 = fail-closed。
  タスクスケジューラ (`commands::tasks::validate_action` / `tasks::executor::run_once`)
  はプロファイル解決前に検証するのでこちら。フロントも同じ方針で、
  `isReadOnlySql(sql, driver?)` / `maskLiterals(sql, driver?)` は driver 省略時に
  保守的な解釈を採る (`components/sqlDialect.ts` のヘルパが未知ドライバを MySQL 扱い
  するのとは**逆**なので注意)。

**MSSQL のロック系テーブルヒント (#906)。** 他ドライバの `FOR UPDATE` /
`LOCK IN SHARE MODE` を拒否している設計意図 (読み取り専用セッションはロックを取らない)
に合わせ、T-SQL の `WITH (...)` ヒントのうち**共有読み取りより強いロックモード**
(`UPDLOCK` / `XLOCK` / `TABLOCKX`) と**文より長いロック保持期間**
(`HOLDLOCK` / `SERIALIZABLE` / `REPEATABLEREAD` / `READCOMMITTEDLOCK`) を
`has_locking_table_hint` で拒否します。`NOLOCK` / `READUNCOMMITTED` / `READPAST`
(ロックを減らす) と粒度のみのヒント (`ROWLOCK` / `PAGLOCK` / `TABLOCK`) は意図的に
対象外。判定は `WITH (…)` グループの内側に限定するので `updlock` という**列名**は
誤検出しません (入れ子括弧 `INDEX(0)` も追跡し、JOIN の 2 つ目のテーブルに付いた
ヒントも拾います)。全ドライバに適用します — `WITH (…)` がテーブル参照直後に来る形は
他方言では読み取り専用構文として成立しないため誤検出の余地が無く、共有ゴールデンの
期待値を文ごとに 1 つに保てるからです。`FROM t (UPDLOCK)` という `WITH` 無しの
レガシー形は既知の非対応 (通常の括弧式と区別できないため)。

**DuckDB のドライバ条件付き許可 (#1005)。** 許可リストの 6 プレフィックス
(`SELECT`/`SHOW`/`DESCRIBE`/`DESC`/`EXPLAIN`/`WITH`) は MySQL/PostgreSQL/SQLite
時代のままで、DuckDB (#709) 追加後の読み取り構文を欠いていたため、同一ドライバ内で
`db/duckdb.rs::is_query_shape` (クエリか実行かのルーティング判定) と `is_read_only_sql_for`
(読み取り専用ガード) が矛盾していました。`is_read_only_sql_masked` に `Option<DriverKind>`
を足して是正しています。**`VALUES (1),(2)` と `TABLE t`** (PostgreSQL/DuckDB/
MySQL 8.0.19+ の `SELECT * FROM t` 短縮形) は書き込みに転じる構文が存在しないため
**全ドライバ**で許可 (ドライバ非依存の呼び出し口も含む)。**`FROM t` 先頭省略構文と
`SUMMARIZE`** は DuckDB 固有の構文なので **DuckDB のみ**許可します。**`PRAGMA`** は
DuckDB でも照会形 (`PRAGMA database_list`) と設定形 (`PRAGMA memory_limit='1GB'`) の
両方があり後者は書き込みに準じるため、DuckDB でのみ、かつマスク後の本文に `=` を
含まない場合だけ許可します (設定形の構文は必ず `=` を伴い、照会形は伴わないという
近似)。SQLite の `PRAGMA foreign_keys=ON` のような設定形は書き込みであり、かつ
SQLite に「照会専用の PRAGMA」という失って困る用途も無いため、**PRAGMA は DuckDB
以外では一切許可しません** (fail-closed)。本 Issue (#1005) の時点では `is_query_shape`
は変更しておらず、その結果 `FROM`/`TABLE` は読み取り専用ガードこそ通るようになった
ものの、`is_query_shape` がまだこの 2 語を認識しないため実行は `execute()` 経路
(行を返さない) に落ち、空の結果になるという既知のギャップが残っていました。この
ギャップは **#1054 で解消済み** — `db/duckdb.rs::is_query_shape` の許可リストへ
`from`/`table` を (`db::starts_with_word` による語境界一致で) 追加し、`FROM t` /
`TABLE t` も実データを返すようになりました (`tests/duckdb_integration.rs` の
`duckdb_read_only_session_allows_new_read_only_syntax_via_ipc` が実 DuckDB 越しに
固定)。フロントは `dangerousSql.ts` の `READ_ONLY_PREFIXES_ALL_DRIVERS` /
`READ_ONLY_PREFIXES_DUCKDB` が同じ許可集合をミラーし、共有ゴールデン
(`readOnlySqlVectors.json` の `readOnlyDuckdb` 次元) で両実装の一致を固定しています。

`apply_auto_limit` は、自前で行数を制限していない素の `SELECT` / `WITH ... SELECT` に
自動で `LIMIT n` を付与します。判定は保守的で、迷ったら `None` (ユーザの SQL をそのまま
実行) を返します。単一行集計 (`COUNT(*)` 等) や既存の `LIMIT`/`OFFSET`、ロック句がある
場合は付与しません。`db/mod.rs` の単体テストがこれら 2 関数の挙動を広くカバーしています。
**MSSQL 版 (`apply_auto_limit_mssql`) はトップレベルに `UNION`/`INTERSECT`/`EXCEPT` が
現れたら `None` を返します** — T-SQL の `TOP (n)` は自分が属する `SELECT` にしか効かず、
先頭ブランチだけを制限して残りを素通しするくらいなら何もしない方が安全なため (括弧の
深さを見るのでサブクエリ内の集合演算では諦めません)。

**キーワード許可リストでは原理的に見えない書き込み経路も拒否します。**
`SELECT * FROM OPENROWSET(..., 'UPDATE ...')` / `SELECT dblink_exec(..., 'DELETE ...')` /
`SELECT load_extension('...')` は、文全体が `SELECT` で始まり、実際の書き込み SQL は
**文字列リテラルの中** = マスクで空白化される領域に隠れるため、通常の書き込み
キーワード走査には一切引っかかりません。そこで `openrowset` / `openquery` /
`opendatasource` / `dblink` / `dblink_exec` / `load_extension` を全ドライバ共通で拒否
します (これらが読み取り専用クエリの識別子として正当に現れる可能性は極めて低く、
過検知のコストより見逃しのコストが桁違いに大きいため fail-closed)。

**マスクの前提を崩す設定は入口で塞ぎます。** `driver_backslash_escapes` は
「MySQL では `\` がエスケープ文字」という静的な前提を置くため、セッション初期化 SQL
(`is_session_init_sql`) が `SET sql_mode = 'NO_BACKSLASH_ESCAPES'` を通すとマスクと実
サーバの解釈が乖離します (`... WHERE x = '\' ; DROP TABLE users -- '` をマスクは「全部
文字列の中」と誤読)。そのため `sql_mode` への `NO_BACKSLASH_ESCAPES` 設定は
`InvalidInput` で拒否します。また MySQL の `/*! ... */` は**コメントではなく条件付き
実行構文**なので、マスクは中身を空白化せずキーワード走査の対象として残します
(「マスクされた領域 = 実行されない領域」という安全網の前提を保つため)。

読み取り専用判定は、バックの `is_read_only_sql` とフロントの `dangerousSql.ts`
`isReadOnlySql` で**独立に二重実装**されているため、両者の判定がズレないよう**共有
ゴールデンベクタ**で整合性を継続検証します (#444)。代表的な SQL とその期待値を
`src/__tests__/fixtures/readOnlySqlVectors.json` に 1 ファイルだけ置き、フロントは
Vitest (`readOnlyGolden.test.ts`) で import、バックは統合テスト
(`tests/read_only_golden.rs`) が `include_str!` で読み込んで `__test_api::is_read_only_sql`
に通します。スタック文・ロック付き SELECT・データ変更 CTE・マスク済みキーワードなどの
境界ケースを網羅しており、片方の実装だけ変えてズレるとどちらかのテストが落ちます。
**境界ケースを追加するときはこの JSON に追記**すれば両言語に反映されます。

ベクタは**ドライバ次元**を持ちます (#852)。`readOnly` は標準的な文字列リテラル解釈
(PostgreSQL / SQLite / DuckDB / MSSQL、およびドライバ非依存の呼び出し口) での期待値で、
MySQL のバックスラッシュエスケープ解釈で判定が変わるケースだけ `readOnlyMysql` を
併記します (省略時は `readOnly` と同じ)。MySQL のマスクは標準解釈より多くを文字列内へ
隠すため、`readOnlyMysql` が `readOnly` より厳しくなる (true→false) ことはありません。
両言語のテストは全ドライバでベクタを回し、加えて「MySQL だけ判定が分かれるケースが
最低 1 件は残っていること」も検証します (ドライバ次元の形骸化防止)。

**SQL 識別子引用 / リテラルエスケープも同じ方式で固定します (#880)。** 識別子引用は
Rust の `db::sync::quote_ident` (MySQL/SQLite ドライバの `quote_ident` はこれへ委譲する
薄いラッパー) と、フロントの `components/sqlDialect.ts::quoteIdentFor` /
`components/exportPreview.ts::quoteSqlIdent` に分散し、リテラルエスケープは
`db::data_diff::sql_literal` をフロントの `exportPreview.ts::sqlLiteral` がミラーします。
インジェクション隣接の安全性ロジックが方言分岐ごとコピーされているため、共有ベクタ
`src/__tests__/fixtures/sqlQuotingVectors.json` を `sqlQuotingGolden.test.ts` と
`tests/sql_quoting_golden.rs` の双方へ通して全実装の一致を固定しています (5 ドライバ ×
危険入力: 各方言の引用文字 / バックスラッシュ / NUL / マルチバイト / 非 BMP / 空文字列)。
BLOB だけはフロントが `Value::Bytes` を `Value::String` と区別できない (JSON 上はただの
16 進文字列) ため意図的に食い違い、その差分を `frontend` キーで明記しています。
`cargo-mutants` のスコープにも `src/db/sync.rs` / `src/db/data_diff.rs` を追加済み
(可視化のみ・fail させない既存方針)。

**自動行キャップ (LIMIT/TOP の挿入) も同じ方式で固定します (#990)。** `apply_auto_limit`
は末尾に `LIMIT n` を足す MySQL/PostgreSQL/SQLite/DuckDB 共有パス、`apply_auto_limit_mssql`
は `SELECT [DISTINCT]` の直後に `TOP (n)` を挿入する MSSQL 専用パスで、書き換え方式も
チェックするキーワード集合 (`limit`/`offset`/`fetch` vs `top`/`offset`/`fetch`) も異なる
ため、フロント側の実装が無いままバックのみで両パスの整合を固定する必要があります。共有
ベクタ `src/__tests__/fixtures/autoLimitVectors.json` を `tests/auto_limit_golden.rs` が
`include_str!` で読み込んで `__test_api::apply_auto_limit_for` の 5 ドライバ全てに通します。
各ケースの `expected` はドライバ名 → 期待書き換え結果 (または変更しないことを表す `null`)
のマップで、`FETCH FIRST … ROWS ONLY` (#969 の回帰ケース) / `WITH … SELECT` / `DISTINCT` /
ロッキング句 / 集約のみ / 既存の `LIMIT`・`OFFSET`・`TOP` / 末尾コメント・`;` /
トップレベル集合演算 (`UNION`/`INTERSECT`/`EXCEPT`) での MSSQL の `None` 返しなどを網羅
します。MSSQL は `limit` キーワードを、他 4 ドライバは `top` キーワードをそもそも
チェックしないため、互いの構文が紛れ込んだ入力ではどちらか一方だけが書き換えてしまう
非対称も意図的なケースとして固定しています (#852 の MySQL バックスラッシュマスク差分も
同様に個別ケースで固定)。

**ストリーミング実行器の fetch/execute 経路振り分け (`is_query_shape`) も同じ方式で
固定します (#971)。** `is_read_only_sql` (#444) や `quote_ident`/`sql_literal` (#880)
と異なり、こちらは共有関数ではなく `db/sqlite.rs` / `db/mysql.rs` / `db/postgres.rs` /
`db/duckdb.rs` / `db/mssql.rs` にそれぞれ private (`__test_api` から駆動できるよう
`pub(crate)` へ引き上げ済み) 関数として個別実装されています。5 実装が一致すべき境界
ケース (SELECT/SHOW/DESCRIBE/EXPLAIN/CALL/PRAGMA/SUMMARIZE/VALUES/TABLE の各ドライバ
固有分岐、データ変更 CTE の判定、コメント/文字列リテラル前置) を共有ベクタ
`src/__tests__/fixtures/queryShapeVectors.json` に集約し、`tests/query_shape_golden.rs`
が `include_str!` で読み込んで `__test_api::is_query_shape(driver, sql)` 経由で全ドライバへ
通します。`WITH` 分岐の「主文がデータ変更か」の判定 (`with_cte_is_mutation`) は
`db::mysql` に 1 つだけ実装され全ドライバが共有するため、**キーワード列挙の部分は**
原理的にドライバ間で割れません。**ただしコメント/リテラルのマスクだけはドライバ別
です (#1051)** — 呼び出し側の `is_query_shape` が自分の `DriverKind` を渡し、
`with_cte_is_mutation` は自前の走査をやめて `db::mask_for_driver` へ委譲します。
以前は方言に関わらず常に MySQL 流のバックスラッシュ解釈を使っていたため、
`WITH t AS (SELECT '\' AS x) DELETE FROM y` を PostgreSQL/SQLite/DuckDB/MSSQL でも
「文字列が閉じない」と誤読し、CTE の閉じ括弧ごとリテラルへ飲み込んで主文の `DELETE`
に到達せず、**データ変更を fetch 経路 (空の 0 件グリッド・`rows_affected` 消失) へ
流していました** — #852 が `is_read_only_sql_for` などに対して行った修正の横展開です。
なお**この不整合で読み取り専用ガードがフェイルオープンしたことはありません**:
`is_read_only_sql_for` は独立した安全網で、#852 で既にドライバ別マスクへ切り替え済み
であり、かつデータ変更 CTE を「主文の位置」ではなく「本文に書き込みキーワードが露出
しているか」で弾くためです (回帰テスト:
`db/mod.rs::read_only_guard_rejects_backslash_cte_on_standard_dialects`)。共有ベクタ
側もこのバックスラッシュケースをドライバ次元が実際に割れるケースとして固定しています。
フロント側に `is_query_shape` 相当の分類ロジックは存在しない
(バックエンドの実行経路振り分け専用) ため、対になる Vitest テストはありません。

**コメント/リテラルのマスキングそのものも同じ方式で固定します (#988)。**
read-only 判定・auto-limit・stacked 検出・危険 SQL 検出・preflight の COUNT
プローブ・flight recorder は、いずれも「まずコメント/リテラルをマスクしてから
キーワード走査する」という同一の土台の上に立ちますが、その土台自体
(バックの `mask_for_analysis_conservative` / `mask_for_driver`、フロントの
`dangerousSql.ts::maskLiterals`) を突き合わせるゴールデンが無く、#444 の
read-only ベクタがたまたま踏む範囲でしか間接的にカバーされていませんでした。
共有ベクタ `src/__tests__/fixtures/maskVectors.json` を `maskGolden.test.ts` と
`tests/mask_golden.rs` の双方へ通して固定します。ドル引用・入れ子/未終端ブロック
コメント (**入れ子は非対応で最初の `*/` で閉じる仕様**、内側の残りが露出する
ことを含めて固定)・二重引用符/バックティック識別子・EOF 直前のバックスラッシュ・
引用符付き識別子内バックスラッシュ・MySQL の `/*! ... */` 条件付き実行構文などの
分岐を網羅します。ドライバ次元 (#852) は `masked` / `maskedMysql` の対で表現し、
`mask_for_analysis_conservative` (ドライバ非依存の呼び出し口) も検証対象です。
本ゴールデンの整備中に **フロント `maskLiterals` の未終端リテラル (EOF まで
閉じ引用符が来ない文字列/識別子) の末尾 1 文字がマスクされずに露出する**バグを
発見し修正しました — `blank(i + 1, j - 1)` が「ループはいつも閉じ引用符の直後で
終わる」前提を置いていたため、EOF に達して `break` を経由せず終了したケースでは
`j - 1` が実際には EOF 直前の実文字の位置を指してしまい、そこだけ空白化されずに
残っていました。修正はループの終了経路 (`closed` フラグ) を見て、閉じていない
場合は `j` まで (実文字を含めて) マスクするようにしています (fail-closed 方向の
修正で、閉じている場合の挙動は変えていません)。

**安全網には「強制レベル」の違いがある点に注意してください。** 同じ「安全網」でも、
バックエンドで強制されるものと、UI 上の確認に留まるものがあります。

- `read_only` (プロファイル) は**バックエンド強制**です。`commands::query` の各
  エントリポイントが `ensure_allowed_for_session` 経由で `is_read_only_sql` を通し、
  `import_csv` も `session.read_only` を拒否します。IPC を直接呼んでも書き込みは
  通りません。
- **緊急クエリ実行モード** (`Session.emergency_write`) は read_only の唯一の
  ランタイム例外です。読み取り専用セッションで緊急対応の書き込みが必要なとき、
  クエリエディタのトグル → **接続先名のタイプ確認** (`ConfirmDialog` の
  `typedConfirmation`、#675 と同じパターン) を経て IPC `set_emergency_mode` で
  有効化すると、`ensure_allowed_for_session` が書き込み文を通します (通過は
  `tracing::warn!` でログに残る)。適用範囲は SQL 実行経路のみで、`import_csv` /
  `apply_sync_sql` / `kill_process` の read-only 拒否は変わりません。フラグは
  `AtomicBool` としてセッション在命中のみ有効で、切断・`reconnect` のセッション
  差し替えで必ずオフに戻ります (フロントの UI ミラー `emergencySessions` も同じ
  タイミングでリセット)。緊急モード中の書き込みは、フロントの実行ゲートが
  `confirm_writes` と同じ毎回の承認ダイアログを要求します。なお有効化の合意
  (名前タイプ) は UI レベルの安全網であり、IPC を直接呼べば確認なしに有効化
  できます — 確実な書き込み禁止には DB 側の権限設定を併用してください。
  読み書き可能なセッションでの有効化要求は `InvalidInput` で拒否されます
  (常時実行テスト: `tests/sqlite_integration.rs` の `emergency_mode_*`)。
- `is_production` の接続確認と `confirm_writes` (本番接続での書き込み承認) は
  **UI レベルの安全網 (UX ガード)** です。`confirm_writes` の判定はフロントの実行
  ゲート (`App.tsx` の `analyzeDangerousSql` / `isReadOnlySql`) でのみ行われ、
  バックエンドの `ensure_allowed_for_session` は `read_only` のみを強制し
  `confirm_writes` は参照しません。プロファイルには保持されますが (`profiles/mod.rs`)、
  IPC を直接呼べば承認なしに書き込めます。**誤操作防止が目的であり、権限強制では
  ありません。** 確実に書き込みを禁止したい場合は `read_only` か DB 側の権限設定を
  併用してください。この限界はアプリ内ヘルプ (`HelpView` の `helpConfirmWrites*`)
  と接続フォームのヘルプ文言 (`formConfirmWritesHelp`) にも明記しています。

なお、読み取り専用セッションでもドライランプレビュー (`preview_query_stream`) は
許可されます。これは「先頭 DML キーワード判定 + トランザクション内実行 + 必ず
ロールバック」で安全を担保しますが、加えて各ドライバの `preview_execute_with_limit`
は `db::has_stacked_statements` で**末尾以外にセミコロンを含む複数文を拒否**します
(MySQL の DDL 暗黙コミットでロールバックを逃れる積み重ねを防ぐため、sqlx の単一文
実行に依存せず明示的に弾く)。
