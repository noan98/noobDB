# DML フライトレコーダーと Undo (#735)

書き込み文の before/after 行イメージをベストエフォートで捕捉し、ワンクリックで
取り消せるようにする**ローカルの保険**です。

## 安全網の階層における位置づけ (重要)

**バックエンド強制の保証ではありません。** 捕捉は静かに失敗しえます (対象テーブル/
主キーが解決できない、行数が上限を超える、認識できない文の形)。**そのとき書き込みは
そのまま通ります — 捕捉が書き込みを妨げてはいけない**、というのが設計方針です。

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
`undo_flight_record`。UI は `components/FlightRecorderPanel.tsx`、純ロジックは
`flightRecorder.ts`。
