# DML フライトレコーダーと Undo (#735)

書き込み文の before/after 行イメージをベストエフォートで捕捉し、ワンクリックで
取り消せるようにする**ローカルの保険**です。

## 安全網の階層における位置づけ (重要)

**バックエンド強制の保証ではありません。** 捕捉は静かに失敗しえます (対象テーブル/
主キーが解決できない、行数が上限を超える、認識できない文の形)。**そのとき書き込みは
そのまま通ります — 捕捉が書き込みを妨げてはいけない**、というのが設計方針です。

- 対象行数が行上限を超える UPDATE / DELETE は、`write_count_probe_sql` の件数見積もり
  (`COUNT(*) FROM (… LIMIT 上限+1)`) で先に判定して記録を辞退し、dry-run で文を 2 回
  走らせない (#1530)。PostgreSQL の `UPDATE … FROM` / `DELETE … USING` は見積もらない。
- **単一トランザクション (#1536)。** 記録対象の書き込みは `Connection::capture_write` が
  3 段 (`capture_prepare` → `capture_execute` → `capture_commit`) で行う。`capture_execute`
  は各ドライバの `execute_snapshot_uncommitted` で「対象行の取得 (MySQL / PostgreSQL は
  **ユーザの WHERE を引き継げたときだけ** `FOR UPDATE` で行ロック。固定窓にはロックを掛けない) →
  文の実行 (ちょうど 1 回) → 同じトランザクション内での after 取得」までを行い、**COMMIT せず**
  `PendingTx` を返す。`capture_commit` が記録の組み立て (純粋な判定) → COMMIT を行う。
  以前の dry-run + 本実行の 2 回実行は廃止したので、トリガ・非トランザクショナルな副作用の
  二重化、スナップショットのずれ、`NOW()` / `RANDOM()` / 採番値の取り違えは構造上起きない。
- **タイムアウト / キャンセル**: `commands::query::run_captured_write` は
  `capture_prepare` + `capture_execute` を `query_timeout` / ストリームの abort 配下に置く。
  ここで中断すると `PendingTx` の drop でロールバックされ書き込みは残らない (エラーで返る)。
  **COMMIT だけ**を `tokio::spawn` で切り離す (確定直前に呼び出し側が落ちても中断しない)。
- スナップショットの取得失敗は記録を辞退するだけで、文の実行と COMMIT は妨げない
  (PostgreSQL は SAVEPOINT で囲み、`SET LOCAL standard_conforming_strings` も同様)。MySQL は
  行ロックが 1213 / 1205 で競合したらトランザクションを張り直して記録を辞退し、書き込みは 1 回だけ。
  SQLite は `BEGIN IMMEDIATE`。`rows_affected` の照合に失敗したときも COMMIT して記録だけ辞退する。
- **INSERT の新規行の特定**: PK 降順の末尾窓で前後を撮り、後にだけ現れた PK を新規行とする。
  PostgreSQL は候補を PK で引き直して `xmin` が自トランザクションか確かめ、MySQL は単一行 +
  AUTO_INCREMENT 主キーなら OK パケットの `last_insert_id` で直接引く (`PreviewResult.new_rows_exact`)。
  これらで特定できず窓が打ち切られている場合、窓の末尾に現れた候補は既存行の繰り上がりと
  区別できないので辞退する。UPSERT (`ON CONFLICT` / `ON DUPLICATE KEY UPDATE` / `INSERT OR REPLACE`)
  も辞退。**PK が無い表・主キーを特定できない文・複数行 INSERT などは従来どおり「記録なしで
  1 回実行」にフォールバックする**。UPDATE の SET で主キーを非決定的な関数で書き換える文も辞退する。
- 対象は `INSERT` / `UPDATE` / `DELETE` **のみ**。DDL (`DROP` / `TRUNCATE` など) は
  完全にスコープ外です。
- トリガー・カスケードなどサーバ側の二次的な副作用は記録されません。ドライバが
  報告した「その文が直接触った行」だけが対象です。
- Undo は通常の書き込みと同じ `run_query_transaction` の all-or-nothing 経路を
  通るため、既存のガード (読み取り専用セッション、文ごとの検証、履歴記録) が
  逆方向 SQL にもそのまま効きます。

## モジュール構成 (`src-tauri/src/flight_recorder/`)

`history` と同じ分割です。

| モジュール | 役割 |
|---|---|
| `mod` | store と IPC 層が共有するデータ型 (`WriteCaptureRecord` / `NewWriteCapture`) |
| `store` | 遅延オープンのローカル SQLite (`flight_recorder.sqlite`。`history.sqlite` と同じ data_dir) |
| `undo` | **純粋な**逆方向 SQL 生成と競合検出。I/O 無し |

## 逆方向 SQL の生成

**新しいリテラルエスケープや SQL レンダリングを書きません。** 捕捉した before/after
イメージを一度きりの `DataDiff` へ翻訳し、Diff/Sync が既に使っている
`db::data_diff::generate_data_sync_sql` にレンダリングさせます。これにより逆方向 SQL は
スキーマ/データ同期とまったく同じ方言安全性を持ちます。

| 元の書き込み | Undo の意図 | `RowDiff` の形 |
|---|---|---|
| `INSERT` | `DELETE` | `TargetOnly { target: <捕捉した行> }` |
| `DELETE` | `INSERT` | `SourceOnly { source: <捕捉した行> }` |
| `UPDATE` | `UPDATE` | `Different { source: <before>, target: <current> }` |

## 競合検出

適用前に、ライブ DB の現在値が捕捉時と食い違う行を `UndoConflict` として返します
(`expected` = 元の書き込み直後にあるはずの行、`current` = 実際に今ある行)。
ユーザは Undo 全体をスキップするか、承知のうえで強行するかを選べます。

## 保存と上限

- `column_types` を保存するのは、JSON ラウンドトリップで `Value::Bytes` が
  `Value::String` として再シリアライズされてしまうため、BLOB 列を復元する必要が
  あるからです (`DataDiff::column_types` と同じ用途)。
- 保持期間の既定は 30 日 (`DEFAULT_RETENTION_DAYS`)。フロントの
  `settings.ts` の `DEFAULT_FLIGHT_RECORDER_RETENTION_DAYS` と対で、ここを
  単一の情報源にして 2 つの捕捉入口がドリフトしないようにしています。
- 件数上限 `MAX_FLIGHT_RECORDS` = 10,000、サイズ上限
  `MAX_FLIGHT_RECORDER_BYTES` = 64 MiB。

## 捕捉の入口

書き込み記録は **`run_query_stream({ capture: true })` に一本化**されています
(#907 で `run_captured_write` / `precheck_captured_write` の IPC は削除。共通コアの
`run_captured_write_inner` は残存)。

## IPC / フロント

`list_flight_records` / `clear_flight_records` / `preview_undo` /
`undo_flight_record` / `preview_redo` / `redo_flight_record`。UI は `components/FlightRecorderPanel.tsx`、純ロジックは
`flightRecorder.ts`。

## Redo (#1536)

取り消し済み (`undone`) の記録を再適用する。`undo::invert_for_redo` が記録を反転
(`INSERT` ⇔ `DELETE`、UPDATE は before ⇔ after) し、同じ `build_undo_plan` に通すだけなので
新しい SQL 生成は無い。`plan_flight` 経由で Undo と同一の衝突検出・`force`・ドライバ/
プロファイル照合・`run_query_transaction_inner` (read_only ガード・履歴記録) を通り、
成功すると `mark_redone` で `undone` を解除する (再度 Undo できる)。取り消し済みでない記録の
Redo は `InvalidInput`。UI は `FlightRecorderPanel` の「取り消し済み」行の「やり直す」ボタン。
