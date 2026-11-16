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
- **セル単位の接続切替は未実装** (ノートブックの既定接続 = 現在の接続のみ。`runNotebookSql` が現在のセッションを使う)。
