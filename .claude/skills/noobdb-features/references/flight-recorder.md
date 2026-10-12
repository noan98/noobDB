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
- **単一トランザクション (#1536)。** 記録対象の書き込みは `Connection::capture_write`
  (`capture_prepare` → `capture_finish`) が、各ドライバの `execute_committing_snapshot`
  で「対象行の取得 (MySQL / PostgreSQL は `FOR UPDATE` で行ロック。取れなければロック無し)
  → 文の実行 (ちょうど 1 回) → 同じトランザクション内での after 取得 → COMMIT」を行う。
  以前の dry-run (別トランザクション) + 本実行の 2 回実行は廃止したので、トリガ・
  非トランザクショナルな副作用の二重化、スナップショットのずれ、`NOW()` / `RANDOM()` /
  採番値の取り違えは構造上起きない (after-image はコミットされた値そのもの)。
  `capture_prepare` は書き込みを一切しない事前チェック (文種・MyISAM・行数上限の見積もり)
  だけで、`capture_finish` 以降はタイムアウト/キャンセルの外で走る。
  スナップショットの取得失敗は記録を辞退するだけで、文の実行と COMMIT は妨げない
  (PostgreSQL はスナップショットごとに SAVEPOINT で囲み、失敗でトランザクション全体が
  中断扱いにならないようにしている)。
- INSERT は PK 降順の末尾窓で前後を撮り、後にだけ現れた PK を新規行とする (採番で末尾に
  付く行が窓の外にならない)。**PK が無い表・主キーを特定できない文・複数行 INSERT などは従来
  どおり「記録なしで 1 回実行」にフォールバックする**。UPDATE の SET で主キーを非決定的な
  関数 (`RANDOM()` 等) で書き換える文も、前後を対応付けられないので辞退する。
- 本実行より後 (本実行と after-image の取得) はタイムアウト/キャンセルの外で
  走る (`commands::query::run_captured_write`)。
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
