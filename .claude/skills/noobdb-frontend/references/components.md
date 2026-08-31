# コンポーネント構成

UI は Chakra UI に全面移行済み (#271)。ルートは `App.tsx`、Chakra システム設定は
`theme.ts`、実行時アクセント色は `accent.ts`、アニメーションは `motion.ts` が司ります。

- `App.tsx` — 全体のシェル。タブ (table / query / explain)、接続状態、ストリーミング
  購読、インラインセル編集 (`components/cellEdit.ts`)、テーマを束ねるルート。
- `api/tauri.ts` — 全 IPC の型付きラッパーとイベント購読ヘルパー (上述)。各 `invoke`
  ラッパーは `api/schemas.ts` の **zod スキーマ**でレスポンスを実行時検証し、Rust の
  serde 構造体と TS 型のズレを早期検出します (未知フィールドは破棄で前方互換)。
- `components/` (接続・クエリ) — `ConnectionList`/`ConnectionForm` (接続)、`QueryEditor`
  (CodeMirror 6 + スキーマ補完 + リアルタイム構文チェック。後述の #704 lint 統合。
  ツールバーは**主要アクションのみ常時表示**で、副次アクション (Explain・スニペット
  保存・`.sql` の開く/保存・一括実行・Query Builder) は「…」オーバーフローメニュー
  (共有 `ContextMenu`) へ畳む #915 — 以前は狭幅で `flexWrap` により 2〜3 段へ折り返し、
  多機能タブほどエディタの縦領域が削られていた。畳まないのは Run / Preview /
  Format と**緊急クエリ実行モードのトグル**で、後者は「状態が常に見えていること
  自体が安全網」だから。無効時の理由 (`disabledReason` 等) はメニュー項目の
  `title` に持ち込むので、ボタンだったときと同じ説明がそのまま読める)、
  `QueryBuilder`、`ResultGrid`/`PreviewGrid`
  (TanStack Table)、`ResultViewSwitch` (結果パネルの表示切替セグメント。グリッド /
  ピボット / チャートの 3 択排他で、`ResultGrid`・`PivotView`・`ChartView` の各
  ツールバー先頭に同じものを置き「今どれを見ているか」と往復導線を 1 か所に集約
  する。App 側の受け口は `setResultView` で、`showPivot`/`showChart` の 2 フラグを
  常に同時に確定させる)、`TabBar`、`HistoryList`、`SnippetList`/`SnippetForm`、
  `ExportModal`/`DumpModal`/`ImportModal`、`ExplainViewer`、`SettingsView`、
  `HelpView`、`DangerousQueryDialog`、`CellValueViewer`、`ERDiagramView`
  (`@xyflow/react` + `@dagrejs/dagre` による ER 図。レイアウト/グラフ構築の純ロジックは
  `erDiagram.ts` に分離してテスト)、`SchemaExportModal` (DB スキーマを AI に貼れる
  Markdown としてコピー/保存。既定は DB 全体で、テーブル選択時は FK で紐付く関連
  テーブルを推移的に自動追加できる。Markdown 生成と FK 閉包の純ロジックは
  `schemaExport.ts` に分離してテスト。出力はロケール非依存の英語固定で、既存 IPC
  のみで完結しバックエンド変更なし)。
- `components/` (発展機能) — `ChartView` (結果のグラフ化。チャートライブラリ非依存で
  SVG 描画、純ロジックは `chartData.ts`。**配色はユーザが選べる** #916 — 既定の
  カテゴリスケールに加えて `colorScale.ts` の連続 (blue/teal) / 発散 (coolWarm/
  blueOrange) ランプを選べ、グリッドの条件付き書式 (`HEAT_PALETTES`) と「値 → 色」の
  体系が揃う。選択肢とサンプリング位置の決め方だけを `chartData.ts` の
  `CHART_PALETTES` / `chartSeriesColors` / `chartValueColors` / `chartRampGradient` が
  持ち、色そのものは `colorScale.ts` を単一の情報源にする。ランプ選択時は単一系列の
  棒グラフと円グラフを**値の大小で着色**し (折れ線/面は形状を追いやすいよう系列色
  1 色のまま)、そのとき凡例の見本は単色ではなくランプの勾配にする。設定は既存の
  チャート設定と同じ localStorage 永続化に相乗りし、このフィールドを持たない
  保存済み設定は縮退させず既定へ埋める)、`CommandPalette` (Cmd/Ctrl+K の横断検索。
  `commandPaletteSearch.ts`)、`ObjectSearchModal` (スキーマ全体のオブジェクト検索。
  `objectSearch.ts`)、`ParameterInputModal` (`{{name}}` プレースホルダのパラメータ化
  クエリ。`queryParams.ts` が型別に安全なリテラル/識別子へ展開)、`BatchResultsView`
  (複数文スクリプトのバッチ実行結果。文分割は `sqlScript.ts`)、`CreateTableModal`
  (CREATE TABLE ウィザード。`createTable.ts`)、`RowInsertModal` / `RowInspector` /
  `RenameTableDialog` (行追加・行インスペクタ・テーブル名変更)、`SchemaCompareView`
  (スキーマ/データ比較 → 同期 SQL 生成 UI。バックの Diff/Sync コマンドを駆動)、
  `SandboxCreateModal` / `SandboxSection` / `SandboxReviewModal` (壊せる砂場・ブランチ
  #747。作成・サイドバー専用セクション・変更確認 → 書き戻し。純ロジックは
  `sandbox.ts`、詳細は `noobdb-features` スキルの `references/sandbox.md` を参照)、
  `ProcessListPanel` (プロセス監視・KILL。`processList.ts`)、`UsersPanel` (ユーザ /
  権限管理 #732。MySQL ユーザ・PostgreSQL ロールの一覧とテーブル単位権限マトリクスの
  閲覧・GRANT/REVOKE 編集。SQL 生成 → プレビュー → 確認 → 適用のフロー)、`ProfileImportDialog`
  (プロファイルインポートの ID 衝突解決)、`ShortcutCheatSheet` (`?` キーのチートシート。
  `shortcuts.ts` が単一ソース)、`TitleBar` (Tauri `decorations: false` のカスタム
  ウィンドウクローム。色決定は `titleBarContext.ts`)、`PlanWatchPanel` (実行計画
  ウォッチ #743。スニペット単位で EXPLAIN 計画をローカルに世代管理し、任意の 2 世代を
  `ExplainViewer` の並置 + 変化点リストで比較する。計画の正規化・フィンガープリント・
  構造比較の純ロジックは `components/planDiff.ts`、世代ストア (localStorage・同一
  フィンガープリントは世代を増やさない・`MAX_GENERATIONS` ローテーション・
  プロファイル単位) は `planWatch.ts`。取得は `run_query` (非ストリーミング) 経由なので
  クエリ履歴を汚さず、EXPLAIN は読み取り専用セッションでも動作する。接続時の自動
  チェックは設定 `planWatchOnConnect` (既定オン) で切替でき、アクセス方式・使用
  インデックス・結合方式・推定行数の桁違いの変化をトーストで通知する)。
