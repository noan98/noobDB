# エクスポート / ダンプ / インポート

## エクスポート / ダンプ / インポート

- `commands/export.rs`: 結果グリッドの内容を CSV / JSON / NDJSON / Markdown /
  SQL INSERT へ書き出します (`export_query_result`)。CSV は RFC4180 風のクオート、
  BLOB は `0x...` で出力。NDJSON (`ExportFormat::Ndjson`) は 1 行 1 オブジェクトの
  改行区切り JSON で、値エンコードは JSON 配列経路 (`row_to_json_object`) と共有します。
  **Markdown** (`ExportFormat::Markdown`) は GFM テーブル (ヘッダ + 区切り行 +
  データ行) で、セル内の `|` を `\|`・改行を `<br>` にエスケープします (空結果でも
  ヘッダは出力)。**SQL INSERT** (`ExportFormat::Sql`) は対象テーブル・ドライバ・
  バッチサイズ (`SqlExportOpts`) を受け取り、`db::data_diff::sql_literal` と
  `db::sync::quote_ident` を共有したドライバ別エスケープで
  `INSERT INTO ... VALUES (...), (...);` を生成します (バッチサイズ単位で 1 文へ
  まとめ、空テーブル名は `exported_table` にフォールバック。在グリッド経路は
  ドライバを引数で受け取り、ストリーミング経路はセッションの方言を使う)。
  加えて `export_query_stream` は、グリッドに載っていない大きな結果セットを
  メモリに溜めず**ストリーミングで直接ファイルへ書き出す**経路です (`run_query_stream`
  と同じバッチ列を消費)。5 形式とも通常 / ストリーミングの両経路に対応します。
  **JSON 形式のときは実行クエリを出力に同梱**できます (`export_query_result` の
  `query` 引数 / `export_query_stream` は `sql` を流用)。同梱時は配列ではなく
  `{ "query": <sql>, "rows": [...] }` でラップします (キーは serde_json 既定の
  `BTreeMap` 出力に従いアルファベット順)。`query` が None/空、または CSV/NDJSON では
  従来どおり配列のまま (後方互換)。`ExportModal` (フロント) は出力内容のプレビュー欄
  (純ロジックは `components/exportPreview.ts` がバックエンドの書式をミラー) と、在
  グリッド全行を全文コピーするコピーアイコンを備えます。
  **「プレビュー = 実出力」は共有ゴールデンで固定します (#879)。**
  `exportPreview.ts::buildExportContent` は 5 書式をバックエンドと**バイト一致**する
  よう独立に再実装しているため、`src/__tests__/fixtures/exportFormatVectors.json` の
  同一入力を両実装へ通して突き合わせます (フロントは `exportFormatGolden.test.ts`、
  バックは `tests/export_format_golden.rs` が `__test_api::export_bytes` 経由で
  **実ファイル出力と同じ** `write_export_to` を `Vec<u8>` 相手に走らせる)。ベクタは
  #879 が名指しする既知のドリフト源 — 浮動小数の書式・JSON キーのソート順 (serde_json
  の `BTreeMap` = UTF-8 バイト順。非 BMP 絵文字は JS の素の文字列比較だとズレるので
  `compareCodePoints` が要る)・CSV インジェクション緩和 (`mitigate_formula_injection`)・
  空結果・クエリ同梱・SQL のバッチ分割 — をケース名で固定しています。BLOB だけは
  フロントが `Value::Bytes` を区別できないため意図的に食い違い、`frontendExpected` に
  明記します。
- `commands/dump.rs`: `mysqldump` を呼ぶ DB ダンプ (MySQL 専用)。資格情報は
  プロセス引数や環境変数に出さないよう、一時オプションファイル (unix では mode 0600)
  経由で渡し、終了後に削除します。`mysqldump` が PATH にない場合は分かりやすい
  エラーを返します。`DumpOptions.format_sql` (既定オフ) を立てると、書き出した
  SQL を `db::format::format_sql` (`sqlformat` クレートの薄いラッパ) で整形して
  保存し直します — フロントの sql-formatter と方針 (2 スペース字下げ・キーワードの
  ケース保持) を揃えた可読性向上オプションです。
  **進捗・キャンセル・SQLite ストリーミング (#686)**: ダンプはストリーミングコマンド
  (`register_stream`/`forget_stream`/`stream_id` の 3 点セット) で、`dump-stream:progress`
  (バイト数・経過秒・SQLite はテーブル数) と `:done` / `:error` を emit します。外部
  クライアント (`mysqldump` / `pg_dump`) は stdout をファイルへ逐次パイプしながらバイト数を
  計測し、`kill_on_drop(true)` + `PartialFileCleanup` で `cancel_stream` の abort 時に
  子プロセスを kill し書きかけファイルを削除します (エクスポート #494 と同じ後始末方針)。
  SQLite 経路はテーブル単位の逐次書き出しで、在メモリの全文字列構築をやめています。
  `DumpModal` は進捗表示 (バイト/テーブル数・経過時間) とキャンセルボタンを持ちます。
  **一時ファイルは `create_new` (`O_CREAT|O_EXCL`) で予約します** — 素の `create` は
  シンボリックリンクを辿るため、ダンプ先ディレクトリに書ける攻撃者が
  `.<name>.dumping.<pid>.<seq>` (PID から予測可能) をリンクとして仕込むと、ダンプ内容が
  任意のファイルへ書き込まれます (資格情報ファイル側は元から `create_new`。同じ防御に
  揃えました)。`AlreadyExists` なら候補名を進めて有限回リトライします。後始末の
  `PartialFileCleanup` は `run_dump` が一元的に所有し、rename 成功時にだけ commit
  します (途中の関数で commit すると整形や rename の失敗で書きかけが残る)。
  加えて、`DefaultsFile` / `PgPassFile` は `Drop` でしか消えず SIGKILL / OOM では
  **平文パスワードを含む `noobdb-dump-*.cnf` / `.pgpass` が一時領域に残る**ため、
  起動時に `cleanup_stale_dump_credential_files` が自分たちの命名規約に一致する
  ものだけを掃除します (`commands::local::cleanup_stale_local_files` と同じ位置・
  同じベストエフォート方針で `lib.rs` から呼びます)。
- `commands/import.rs`: CSV / JSON / NDJSON を `import_rows` でテーブルへ一括投入
  します (`encoding_rs` でエンコーディング指定可、NULL トークン・列マッピング対応)。
  読み取り専用セッションでは拒否されます。進捗は `csv-import:*` イベントで通知します。
  フォーマットは `ImportOptions.format` (`ImportFormat`: `csv` / `json` / `ndjson`、
  既定 `csv` で後方互換) で選択し、`parse_preview` / `parse_rows` がフォーマットで
  分岐します (#521)。JSON はトップレベル配列のオブジェクト (単一オブジェクトは 1 行)、
  NDJSON は 1 行 1 オブジェクトをパースし、`csv_index` は全レコードのキー和集合から
  作る**ヘッダ列 (first-seen 順、各オブジェクト内は BTreeMap でソート)** を指します
  (プレビューとインポートで同じ順序になり列対応がズレない)。ネスト値 (オブジェクト/
  配列) はコンパクトな JSON テキストに文字列化、`null`・欠損キーは SQL NULL、NULL
  トークンも CSV と同じく適用します。コマンド名 (`parse_csv_preview` / `import_csv`) と
  `CsvPreview` 型名は IPC 安定のため CSV 時代のまま据え置き、全フォーマットを扱います。
  `ImportModal` はフォーマット選択 (拡張子から既定推定) を持ち、JSON/NDJSON では
  CSV 専用フィールド (区切り/クオート/ヘッダ行) を隠します。
  **エラー行の扱い (#687)**: `ImportOptions.error_mode` (`ImportErrorMode`: `abort`
  既定 / `skip`) を持ちます。`abort` は従来どおり単一トランザクションの all-or-nothing で、
  失敗時は `Connection::probe_failing_row` (ロールバックする tx で 1 行ずつ再試行) が
  **副作用なしで先頭の不良レコードを特定**し、エラーに「レコード N (CSV は行 L)」を添えます。
  `skip` は `Connection::import_rows_skipping` (チャンク投入 → 失敗チャンクのみ 1 行ずつ
  再試行、良い行はコミット) で不良行を飛ばして続行し、スキップ行 (レコード番号 + CSV 行 +
  理由) を `csv-import:done` の `skipped` で返します。行番号は `parse_rows_with_lines` が
  CSV は `csv::Reader` の position から**引用符付き複数行フィールドも考慮した実ファイル行**を
  取得します (JSON/NDJSON はレコード番号のみ)。各ドライバは `try_insert_chunk` (auto-commit) と
  `probe_failing_row` (tx ロールバック) の 2 プリミティブを実装し、orchestration は
  `db/mod.rs` に集約します。`ImportModal` はモード選択とスキップ行一覧 (コピー可) を持ちます。
  **非トランザクションエンジン (MyISAM 等) の扱い**: probe/retry はロールバックを前提とする
  ため、`Connection::table_is_transactional` (MySQL のみ `information_schema` の `ENGINE` を
  参照。他ドライバは常に true) で判定し、非トランザクションなら `import_rows_skipping` は
  **バッチを 1 行に落とし** (1 行 INSERT は MyISAM でも原子的なので、失敗チャンクの再試行で
  行を重複させない)、MySQL の `probe_failing_row` は **probe をスキップ**して副作用を残さない
  (エラーはレコード特定なしで報告)。判定に失敗したときは InnoDB 既定とみなし従来のバッチ経路
  を維持します。**skip モードのキャンセル整合**: skip はチャンクごとに auto-commit するため
  途中キャンセルで一部行が残りうる。コミット済み件数を `StreamHandle.delivered_rows` に反映し、
  `cancel_stream` は `csv-import:cancelled` を emit して `deliveredRows` (= コミット済み行数) を
  返します (`abort` はロールバックするので 0)。`ImportModal` はキャンセル時にこの件数を表示。
  読み込みは `read_import_file` が空パス拒否 + `MAX_IMPORT_FILE_BYTES` (512 MiB) 上限を
  `commands::file` と同じく metadata + `take` の二段で強制します。
