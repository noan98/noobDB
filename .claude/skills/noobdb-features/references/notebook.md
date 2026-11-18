# SQL ノートブック (#2380)

全画面サーフェス (`NotebookView.tsx`、`workspaceView.ts` の `"notebook"`)。Markdown セルと SQL セルを並べ、
SQL セルの結果をスナップショットとして `.noobnb` (JSON) に保存・再実行・書き出し (Markdown / 自己完結 HTML) できる。
**フロントエンドだけで完結する** (新しい IPC・Rust コマンド・capabilities は無い)。

| ファイル | 役割 |
|---|---|
| `notebook.ts` | 文書モデル・セル操作・スナップショット (`buildSnapshot`: 保存行数の上限 + マスク)・`serializeNotebook` / `parseNotebook` |
| `notebookStore.ts` | 現在の文書 (keep-alive で画面が捨てられても未保存の編集を残す) |
| `notebookExec.ts` | `api.runQueryStream` の結果を Promise に集める (先頭 N 行だけ保持) |
| `notebookExport.ts` | Markdown / HTML 書き出し (HTML は `escapeHtml` + CSP `default-src 'none'`、色はシステムカラーのみ) |
| `markdownLite.ts` / `components/MarkdownView.tsx` | 依存を足さない最小 Markdown (HTML は常にエスケープ、リンクは http(s)/mailto のみ、画像なし) |

- **実行経路**: `App.tsx` の `runNotebookSql` が `runGuardedDdl` (危険クエリ確認 / 本番 confirm_writes / 緊急モード) を通し、
  `run_query_stream` (履歴・フライトレコーダ `capture`・read_only のバックエンド強制・自動 LIMIT・タイムアウト) へ流す。
  明示トランザクション中は `runInTransaction`。複数文のセルは 1 文ずつ順に流し、最後の結果セットをセルの結果にする。
  失敗・確認の取りやめ・中止で、「すべて実行」/「ここから下」はそこで止まる。
- **保存**: `readTextFile` / `writeTextFile` + `plugin-dialog` の open / save (既存の経路)。接続は `profileId` と表示名だけ。
  シリアライズはホワイトリスト (`notebook.test.ts` が秘密らしきプロパティの混入を固定)。
- **マスキング**: 設定の機微カラムマスク (`columnMask.ts`) が有効なら、スナップショット作成時と書き出し時の両方で伏せ字にする。
- **セル単位の接続 (#2396)**: SQL セルは `connection` (`{ profileId, name }` だけ。null = 文書の既定 = 現在の接続) を持ち、
  セルのヘッダの `ListboxSelect` で選ぶ。実行先の解決は純関数 `resolveCellTarget` (`current` / `open` / `closed` / `missing`)。
  - **実行できるのは「開いている接続」(アクティブ + 背景 = `openConnections`) だけ。** ノートブックから接続は張らない
    (閉じている / プロファイルが無いセルは理由をセルに出して実行を止め、「すべて実行」は 1 つも流さない)。
  - **実行先は「接続 + セッション」の組で固定する**: `NotebookRunRequest.connection` は常に明示 (`{ profileId, sessionId, name }`。
    既定のセルも省略しない)。`runCells` が実行開始時に組を決め (確認も実行もその組)、`runNotebookSql` は
    `resolveNotebookRunTarget` で組が `openConnections` に実在するか検証する (無ければ拒否。プロファイルは開いているが
    セッションが違う = 再接続は別メッセージ)。実行中にアクティブ接続が切り替わっても別の接続では流れない。
    アクティブかどうかは各コールバックでその都度 `sessionIdRef` と比べる。
  - **実行中はセルの接続を選べない** (`ListboxSelect` を disabled)。さらにループ内で、開始時と接続が変わったセルがあれば停止する。
  - **安全網はセルの接続の設定で効く**: 判定に使うプロファイルは最新の設定 (アクティブ接続は `selectedProfile`、背景は保存済み
    `profiles`。`openConnections` のプロファイルは接続時点のままなので、派生接続など保存一覧に無いときだけ使う) で、
    `runGuardedDdl` に緊急モードと一緒に渡して確認ゲート (`is_production` / `confirm_writes` / `read_only` / 危険クエリ) を判定する。
    `read_only` のサーバ側強制は、そのセッション自身の接続設定による。明示トランザクションは接続ごと (`notebookInTransaction`)。
  - 現在と違う接続を指すセルは、この文書で初めて実行するときに接続名 (本番は danger) の確認を出す (承認は文書の世代ごと)。
  - 別の接続のセルは、文書の実行先 DB (`doc.database`) を持ち込まず接続の既定 DB へ寄せる。履歴ナビ・スキーマドリフト記録は
    アクティブな接続のものなので、背景接続のセルでは触らない (スキーマキャッシュは丸ごと破棄)。
  - エラー文のスナップショットは `redactErrorText` で資格情報リテラルを伏せてから残す。
  - 設定 `batchWrapInTransaction` には揃えていない (ノートブックはセルの結果を 1 文ずつ集めるため、`run_sql_batch` へ
    寄せると結果の取り扱いが変わる。複数文のセルは 1 文ずつ・失敗で停止、で従来どおり)。
