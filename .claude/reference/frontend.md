# フロントエンド構成 (`src/`)

React 19 + Chakra UI の構成、各モジュールの責務と設計判断。

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
  `sandbox.ts`、詳細は `.claude/reference/diff-sync-sandbox.md` を参照)、
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
- セル整形ユーティリティ — `cellTypeMeta.ts` (カラム型を 9 種の `CellKind` へ分類)、
  `cellFormat.ts` (JSON コンパクト表記・日時のロケール整形。**表示専用**で実値は不変)、
  `cellConditionalFormat.ts` (データバー/ヒートマップ。表示専用。色は下記
  `colorScale.ts` を参照)。
- セル値のクイックフィルタ (#914) — `quickFilter.ts`。結果グリッドのセル右クリックに
  出る「この値で絞り込む (= value)」「この値を除外する (≠ value)」の**純ロジック**。
  **新しいフィルタモデルは増やさず**、クリックしたセルの値を既存の 2 経路 — table
  タブのサーバ側 WHERE (`onSetServerFilter` → `serverBrowse.ts` の `ServerFilter`) と、
  クエリ結果タブのクライアント側 `ColumnFilter` (TanStack の `ColumnFiltersState`) —
  のどちらかへ変換するだけで、絞り込みの実行・表示 (フィルタチップ / ヘッダーの
  アクティブ表示 / 解除ボタン) は既存の仕組みがそのまま担う。実装として `≠` の
  演算子を両モデルへ追加した (`ServerFilterOp` の `ne` = `<>`、`ColumnFilter` の
  `notEquals` / `ne`)。これらは列ヘッダのフィルタポップアップからも選べる。
  **NULL セルは値比較ではなく NULL 判定に倒す** (`IS NULL` / `IS NOT NULL`、
  クライアントは `nullMode: only / exclude`)。非 NULL 値の「除外」は両経路とも
  NULL 行にマッチしない — SQL の `col <> 'x'` が三値論理で NULL を落とすのと、
  クライアント側 `columnFilter` が値条件のある行で NULL を弾くのが一致するため、
  テーブルブラウズとクエリ結果で見え方が変わらない (意図的に揃えてある)。BLOB 列は
  手元に 16 進表現しか無く一致比較が意味を成さないので項目自体を出さない。
- セル値のクイックセット — `quickSetValues.ts`。結果グリッドのセル右クリックに出る
  「NULL をセット」「空文字をセット」「0 をセット」「true/false をセット」「現在日時を
  セット」の**純ロジック** (どの列にどの候補を出すか + 生成する生文字列)。生成値は
  「ユーザが編集ボックスに手で打てたはずの文字列」に限定してあるため、下流の
  `validateCellInput` / `literalFromInput` / `cellValueFromInput` がそのまま効き、
  **DB への新しい経路を一切増やさない** (既存のインラインセル編集バッファに載るだけで、
  確定は従来どおり Apply)。適用範囲は一括編集ダイアログ (#596) と同じ判定で、クリック
  したセルが矩形選択の内側なら選択範囲全体 (`planBulkCellEdit` 経由)、そうでなければ
  そのセル 1 つ。時刻系の候補は**クリック時点**の時計で組み直す (メニューを開いたまま
  時間が経っても古い値を書かない)。NOT NULL 列では NULL の項目を「消す」のではなく
  **理由付きで無効化**して制約を可視化する。`BIT` はドライバで意味が変わる唯一の型で、
  MSSQL では真偽型そのもの (MySQL/SQLite も 1/0 が有効) だが PostgreSQL / DuckDB では
  ビット列 (`'10110000'`) なので `true`/`false` も空文字も不正なリテラルになる。
  `classifyEditType` は型名しか見られないためこの分岐は `quickSetOptions` 側に置き、
  ビット列ドライバでは NULL 以外を出さない (必ず Apply で失敗する候補を出すくらいなら
  出さない)。
  「すでにその値」のセットは `cellEdit.ts` の **`editIsNoop`** が検出し、保留編集を積む
  代わりに解除する。この判定は単一セル経路と `planBulkCellEdit` (矩形選択・一括編集
  ダイアログ #596) の**両方**が共有し、後者は該当セルを `applied` ではなく
  `unchanged` (`value: null` = 解除) へ回す。`BulkEditTarget.value` の `null` は
  「値ではなく解除」を意味し、App の `setBulkCellEditsForTab` が単一セルの
  `setCellEditForTab` と同じ削除処理を行う — 無変更の `SET col = <同じ値>` を Apply で
  発行せず、保留編集の件数表示も実際に変わるセルだけを数えるため。
- クリップボード貼り付けによる一括編集 (#793) — `pasteEdit.ts`。結果グリッドの
  矩形選択 TSV コピー (`copySelection`) と対称の取り込み経路で、`DataGrid` の
  `<table>` に付けた `onPaste` が Excel/スプレッドシート由来の TSV (タブ区切り・
  改行区切り、`"` で囲んだフィールドのタブ/改行/二重引用符も復元) を
  `parseClipboardGrid` で解析し、選択の左上 (矩形選択が無ければアクティブセル) を
  アンカーに貼り付け範囲を展開する。1×1 の単一値貼り付けは既存の矩形選択があれば
  `planBulkCellEdit` (#596) にそのまま委譲し (二重実装しない)、2 セル以上の矩形
  貼り付けだけが新設の `planPasteEdit` を通る — 編集不可列・型不正値のスキップは
  `planBulkCellEdit` と同じ `isColEditable`/`validate` を共有し、加えて貼り付け
  範囲が現在表示中の行/列数を超えた分は `skippedOutOfBounds` としてスキップ計上
  する (行の自動 INSERT 化はこの Issue のスコープ外)。生成される変更は既存の
  `PendingEdits`/`BulkEditTarget` バッファに積まれるだけで、確定は従来どおり
  Apply — **DB への新しい書き込み経路を増やさない**点は `quickSetValues.ts` と
  同じ方針。副次的に、グリッドセルにフォーカスがある状態 (インライン編集中は
  対象外) での Delete/Backspace は選択範囲 (または アクティブセル) を NULL へ
  一括セットする `clearSelectedCells` を追加し、既存の「値をセット」経路
  (`applyValueToCells`) をそのまま再利用するため NOT NULL 制約のスキップ挙動も
  一括編集ダイアログと揃う。
- データ可視化カラースケール (#525) — `colorScale.ts` が、データを色で符号化する表面
  (チャート系列・ヒートマップ・データバー・将来のコスト/NULL 率ミニバー) が共有する
  **単一のスケール体系**を純ロジックとして定義する。**sequential** (単一色相の連続、CB
  セーフ) / **categorical** (CB 配慮の順序付き離散色、チャート系列用) / **diverging**
  (中央が淡い発散) の 3 系統と、値 → 色の純関数 (`sampleRamp` / `categoricalColor`) ・
  塗り面上の可読インク (`readableInk`) を公開する。`ChartView` (系列/値の配色は
  `chartData.ts` の `CHART_PALETTES` 経由。#916) と `cellConditionalFormat.ts` は
  ここを参照し色を二重定義しない (`colorScale.test.ts` が
  最小/最大/NaN などの境界を固定)。`ChartView` の系列描画/出現アニメーションは
  `motion.ts` の共有プリセットに沿い、reduced-motion で自動抑制される (#526)。
- 結果グリッドの分析サマリ — `gridStats.ts` (#523/#524)。`selectionSummary` が矩形範囲
  選択セルの件数/非NULL数/数値数/合計/平均/最小/最大を集計し `ResultGrid` の
  ステータスバーへ表示 (#523)。`columnStats` が在メモリ (取得済み行) の列値から件数/
  NULL率/DISTINCT/数値レンジ/文字列長/代表値を計算し、ヘッダーメニューの「列の統計」
  ポップオーバー (`ColumnStatsMenu`) へ表示 (#524)。`buildColumnStatsSql` がドライバ方言で
  識別子をクオートした全件集計 SQL を生成し、`parseFullColumnStats` が単一行結果を位置で
  構造化する (全件集計ボタンは `App` から `api.runQuery` を束ねた `onRunStatsQuery` が
  渡るときだけ出る)。すべて副作用なしの純関数で `gridStats.test.ts` がテスト。数値化は
  `cellConditionalFormat.toNumber` を共有。
- 結果グリッドの集計フッター行 — `gridFooter.ts` (#645)。表計算ソフトのフッターに相当し、
  各列の要約を「選択や操作なしに常に一覧で把握する」。`ResultGrid` (内側 `DataGrid`) の
  `<tfoot>` に、縦スクロールで最下部スティッキー・横スクロール追従・ピン留め列整合で
  列ごとの集計値を 1 つ表示する。集計値算出は `gridStats.columnStats` を**再利用**し
  (二重定義しない)、`gridFooter.ts` は列種別ごとの選択可能な関数 (`availableFooterFns`:
  数値列 SUM/AVG/MIN/MAX + COUNT/DISTINCT/NULL率、非数値列 COUNT/DISTINCT/NULL率)・
  既定 (`defaultFooterFn`: 数値=SUM / 他=COUNT)・`ColumnStats` からの表示値取り出し
  (`computeFooterCell`)・破損耐性つきのテーブル単位永続化 (`footerStateKeyFrom` は
  `colStateKeyFrom` と同型で `noobdb.gridfooter.v1` 名前空間、`read/writeStoredFooterState`)
  を担う純ロジック。表示 ON/OFF は列ヘッダーメニュー、列ごとの関数切替は「列の統計」
  ポップオーバー (`ColumnStatsMenu`) のセレクタから。値更新は `motion.ts` の crossfade で
  控えめにアニメーションし reduced-motion で抑制。`gridFooter.test.ts` (純ロジック) と
  `ResultGrid.test.tsx` (描画/切替/永続化) がテスト。全件集計が要る場合は #524 の
  `buildColumnStatsSql` / 全件集計ボタンに乗る (フッター自体は在メモリ対象)。
- 結果グリッド列ヘッダの NULL 率ミニバー — `gridStats.ts` の `columnNullRates` /
  `nullRatePercentOf` (#911)。列統計ポップオーバー (`ColumnStatsMenu`) を開かなくても
  各列の欠損の偏りを一望できるよう、ヘッダ下端に細いバーを**常時表示**する。率の式は
  `nullRatePercentOf` に一本化し、ポップオーバーの NULL 率バー・集計フッターの
  `nullRate` (#645)・このミニバーが同じ値になることを保証する。全列ぶん再計算される
  経路なので、DISTINCT/代表値の頻度マップまで作る `columnStats` ではなく、NULL の
  数え上げだけを行う軽量な `columnNullRates` を使う (「fetch all」後の数万行 × 列数で
  効く)。塗りは `colorScale.ts` の `accentFill(ACCENT_FILL_STOPS.nullRate)` を
  `.cell-databar` / ポップオーバーと共有し色を新規定義せず、幅は width ではなく
  `scaleX` で表現する (データバーと同じくレイアウトを誘発しない)。バーはヘッダの
  **高さを変えない絶対配置**で下端に重ねるため、密度設定 (Compact/Normal/Spacious) や
  フォント拡大でも列間の整列が崩れない。0% の列にも薄い「地」を敷いて計測済みで
  あることを示す。表示専用で実値・ソート・編集・エクスポートには影響しない
  (`cellConditionalFormat` と同方針)。設定 `columnNullBars` (既定オン) でオフにできる。
  装飾要素にタブストップを増やさないよう、ホバー時の説明はセルと同じ委譲ツールチップ
  (hover 専用) に載せ、読み上げ向けには `role="img"` + `aria-label` を持たせる。
- アプリ内アクティビティ / 通知センター — `activityLog.ts` + `components/ActivityCenter.tsx`
  (#912)。トーストは自動で消える一過性の通知なので、インポート結果・同期の成否・実行
  計画ウォッチ (#743) のアラートを見逃すと二度と確認できなかった。`ToastProvider` の
  `notify` が発火時に `pushActivity` へ流し込み、タイトルバーのベルアイコン →
  ポップオーバーで時系列に再閲覧できるようにする (**記録の入口は 1 か所**なので、
  通知を出す側は従来どおり `toast.*` を呼ぶだけでよい)。ストアは在メモリで**セッション
  内のみ揮発**し (通知は「今このアプリで何が起きたか」の記録で、再起動をまたぐと文脈が
  失われるため)、`ACTIVITY_LIMIT` (200) を超えたら古いものから捨てる。未読はエントリ
  ごとのフラグではなく「最後に読んだ id」の水位で表し、`countUnread` で数える。重大度
  (`ActivitySeverity`) は `semanticColors.ts` の `SemanticRole` と 1 対 1 で対応させて
  状態色を二重管理しない (`danger` に相当する語だけトーストの tone に合わせて `error`)。
  トーストの tone は 3 種しか無いため、見た目は変えずセンター側でだけ「警告」として
  分類したい通知 (スキーマドリフト検知・実行計画の変化) は `ToastOptions.severity` で
  明示する。a11y: パネルは `role="dialog"` + フォーカストラップ (開くとパネル自身へ
  フォーカス、閉じるとベルへ復帰) で、**`aria-live` は付けない** — 通知そのものは
  トースト側 (`aria-live="polite"`) が既に読み上げており、二重読み上げを避けるための
  意図的な設計。追加/ローテーション・絞り込み・未読数・相対時刻はすべて純関数として
  公開し `activityLog.test.ts` が、UI 結線は `ActivityCenter.test.tsx` が固定する。
- 基盤モジュール — `shortcuts.ts` (全ショートカット定義の単一ソース)、`keyboardNav.ts`
  (`useFocusTrap` / `useRovingFocus` / `useReturnFocus` の a11y フック)、
  `tableQuickAccess.ts` (お気に入り + 最近使ったテーブルを localStorage 永続化)、
  `queryHistoryNav.ts` (エディタの ↑/↓ 履歴ナビ)、`clipboard.ts`、
  `tableMaintenance.ts` (TRUNCATE/DROP/RENAME の方言別 SQL 生成)、`rowEstimate.ts`
  (`~1.2K` 形式の概算行数表示)、`components/paneLayout.ts` (エディタ⇔結果スプリット
  ペインの配分クランプ/正規化と、レイアウトモード `normal`/`result`/`editor` の
  正規化・トグルの純ロジック。#618。`Splitter` と `App` が共有し `paneLayout.test.ts`
  が境界を固定)。エディタ集中/結果最大化はワークスペース単位 (`noobdb.layout.mode`) で
  永続化し、全画面オーバーレイは `App.css` の `pane-overlay-in` で出現させ
  reduced-motion で静止化する。
- アイコン — `components/Icon.tsx` が唯一の実装で、グリフの実体は
  **Tabler Icons (`@tabler/icons-react`、MIT)** から供給する。Tabler の既定属性
  (24x24 viewBox / `fill="none"` + `stroke="currentColor"` / stroke-width 2 / 丸い
  キャップとジョイン) がこのアイコンセットの規約とそのまま一致するため、以前まで
  本ファイルに手写ししていたパスデータを置き換えた。**呼び出し側の API
  (`<Icon name="table" size={ICON_SIZES.md} />`) は変えていない。**
  **各コンポーネントが `@tabler/icons-react` から直接 import しないこと** — 同じ
  意味に別々のグリフが割り当たり、サイズ/ストロークのトークン規約も呼び出し側ごとに
  崩れる。新しいアイコンが要るときは、まず `Icon.tsx` のセマンティック・レキシコン
  (意味 → `IconName`) に意味を足し、`GLYPHS` へ Tabler コンポーネントを 1 つ束縛
  する (「意味 → グリフ」の唯一の情報源は `GLYPHS`)。サイズは `ICON_SIZES`
  (`sm`/`md`/`lg`/`xl`/`2xl`。#818/#886)、ストロークは `ICON_STROKE` のトークンのみ
  で、**ピクセル直値は使わない**。寸法は SVG の `width`/`height` 属性 (= Tabler の
  `size` prop) ではなく**インラインスタイル**で与える — `ICON_SIZES` の値は
  `calc(13px * var(--font-scale))` のような CSS 式で、プレゼンテーション属性としては
  不正だが CSS プロパティとしては有効なため (この経路が #818 の font-scale 追従)。
  例外はドライバのブランドロゴ (`mysql` / `postgres` / `sqlite`) だけで、Tabler には
  `brand-mysql` しか無く 3 つ並ぶドライバ選択で描き味が割れるため、simple-icons 由来
  (CC0) の塗り単一パスを `BRAND_GLYPHS` に残している。
- ツールチップ (#814/#884) — `components/Tooltip.tsx` が唯一の実装で、位置決めの
  純ロジックは `components/tooltipPosition.ts` (`computeTooltipPosition`。測定 →
  クランプ → フリップ) に分離してテストする。**新しい UI で native `title=` を
  書かないこと** — native title は表示まで約 1 秒・**キーボードフォーカスでは
  一切表示されない (a11y 欠陥)**・テーマ非追従・すぐ消える、という弱点がある。
  使い分けは 2 つ:
  - `<Tooltip label={...}>` — 通常のボタン/アイコン/ラベル。`cloneElement` で
    hover/focus ハンドラ・ref・`aria-describedby` を注入するので DOM 構造は
    変わらない。`label` が falsy なら何もせず `children` をそのまま返すため、
    条件付きラベルを分岐なしで渡せる。**無効 (`disabled`) なトリガーにだけ**
    `focusableWrapper` を付ける (ブラウザが無効要素をタブ順序から外すため)。
    通常のフォーカス可能要素に付けると余計なタブストップが増える。
  - `useDelegatedTooltip()` + `<TooltipBubble>` — 行/列/セル数に比例して大量に
    描画される一覧 (`ResultGrid` のセル、`ConnectionList` のスキーマツリー行、
    `ERDiagramView` の PK/FK アイコン)。共有状態 1 つ + `bind(label)` が返す
    軽量なハンドラだけを各要素に付け、`Tooltip` インスタンスを増やさない。
    hover 専用 (focus 非対応) なので、**キーボードで到達できる要素には使わない**。
    単純テキストではない hover カード (`ConnectionList` のカラム詳細
    `ColumnTooltip` など) は、任意の値を運べる一般形 `useDelegatedHover<T>()` に
    載せる — `bind(value)` の戻り値を行に展開するだけで、遅延・単一表示の登録簿・
    スクロール連動非表示が揃う。**hover 状態を自前の `useState` +
    `onMouseEnter`/`onMouseLeave` で持たないこと** (遅延と登録簿から外れる)。
  **hover での出現には遅延を入れる (`TOOLTIP_OPEN_DELAY_MS` = 400ms)。** 即時
  表示だとポインタが目的地へ向かう途中で通過しただけの要素が次々に吹き出しを
  開き、画面がちらつく。この定数は `Tooltip` と `useDelegatedHover` /
  `useDelegatedTooltip` の**共通の既定値**で、表面ごとに速さが変わらないように
  する (呼び出し側が `openDelay` で上書きするのは、遅延が邪魔になる特殊な場合
  だけに留める)。**フォーカス起因の表示は遅延なし** — キーボードユーザには
  「まず hover して気付く」段階が無く、遅延はただの待ち時間になるため。
  同時に見える吹き出しは常に高々 1 つで、新しく開いたものが直前のものを閉じる
  (`claimTooltip`/`releaseTooltip`)。行のツールチップの中にボタンのツールチップを
  入れ子にしても native title と同じ「最も内側だけ」の見え方になる。複数行ラベル
  (`ヒント\n\nSQL` など) は `white-space: pre-wrap` で改行を保つ。**唯一の例外は
  `TabBar` のタブ本体**で、`AnimatePresence` の直接の子である必要があり `Tooltip`
  の Fragment を挟むと退出アニメーションが壊れるため、意図的に native title の
  ままにしている (理由はコード内コメントに明記)。挙動は `tooltip.test.tsx`
  (開閉・hover 遅延・a11y 結線・入れ子) が固定する。
- コンテキストメニュー (#213/#815/#1018) — 全画面の右クリックメニューは
  `components/ContextMenu.tsx` の 1 実装で、項目は `ContextMenuEntry`
  (項目 / セパレータ / **サブメニュー**) の配列として呼び出し側が組み立てる。
  位置決めの純ロジックは `components/menuPosition.ts` (`computeMenuPosition`。
  クリック点起点と親項目起点の 2 通りで測定 → フリップ → クランプ) に分離して
  テストする (`tooltipPosition.ts` と同じ形)。
  **サブメニュー (#1018)**: 項目数が状況によって膨らむグループは
  `submenuOrFlat(label, items, opts)` を通してから差し込む — 0 件なら何も出さず、
  `SUBMENU_THRESHOLD` (既定 2) 未満ならフラットのまま、それ以上なら 1 項目へ
  畳む。1 件のためにホバー 1 手を増やさないための共通基準で、**畳む/畳まないの
  判定を各メニューで独自に書かないこと**。現在の適用先は結果グリッドのセル
  メニュー (コピーの派生・値のクイックセット・「参照元を表示」— 参照元は子
  テーブルの数だけ増え、実際に画面高を縦断していた) と、接続ツリーのテーブル /
  DB 保守コマンド。子パネルは**ポータルで body へ出す** — 親パネルの DOM に
  入れると親の roving focus のクエリ (`[role=menuitem]`) に子項目まで混ざって
  矢印移動が壊れるため。ポータルでも React ツリー上は親の子なのでキーイベントは
  親へ伝播する点に注意 (パネル内で処理したキーは `stopPropagation` する。
  サブメニュー内の Escape が**メニュー全体ではなくサブメニューだけ**を閉じるのも
  これによる)。ホバーで開いた子は通常項目を通過しても閉じず、別のサブメニュー
  項目へホバーしたときだけ開き先が入れ替わる (親項目から斜めに子パネルへ
  移動しても取りこぼさないため)。キーボードは ArrowRight / Enter で開いて先頭の
  子項目へフォーカス、ArrowLeft / Escape で親へ戻る。挙動は
  `contextMenu.test.tsx`、算術は `menuPosition.test.ts`、実 CSS 上の配置は
  `browser/screens.browser.test.tsx` が固定する。
- `settings.ts` — `useSyncExternalStore` ベースの設定ストア。シンタックスカラー
  (`syntaxColors` light/dark)・プレビューハイライト色・表示行数 (`defaultDisplayCount` /
  `streamPrefetchSize`)・自動 LIMIT (`autoLimitEnabled` / `autoLimitCount`)・SQL 構文
  チェック (`sqlLintEnabled`。#704)・本番接続確認
  (`confirmProductionConnect`)・危険クエリ確認 (`confirmDangerousQueries`)・新規タブ実行
  (`resultsInNewTab`)・タブ復元 (`tabRestoreMode`)・クエリタイムアウト
  (`queryTimeoutSecs`)・フォントサイズ (`fontSizePx`) / フォントファミリ
  (`monoFontFamily` / `uiFontFamily`)・アクセント色 (`accentColor`)・UI 密度
  (`density`)・自動リフレッシュ間隔 (`autoRefreshDefaultSecs`)・グリッド表示モード
  (`resultGridMode` scroll/paginate, `resultGridPageSize`)・セル編集の blur 挙動
  (`cellEditOnBlur`)・リッチセル描画 (`richCellRendering`)・列ヘッダの NULL 率
  ミニバー (`columnNullBars`。#911)・テーマプリセット
  (`themePreset` default/dracula/high-contrast/colorblind。後者 2 つは light/dark
  追従でアクセシビリティ向け。#558) などを保持します。
- `dangerousSql.ts` — WHERE なし UPDATE/DELETE・DROP・TRUNCATE を検出する
  フロント側の安全網 (バックエンド `is_read_only_sql` と同じくリテラル/コメントを
  マスクするベストエフォート判定)。`DangerousQueryDialog` の確認に使われます。
- `components/sqlLint.ts` — クエリエディタのリアルタイム SQL 構文チェック (#704) の
  純ロジック。`@codemirror/lang-sql` が既に構築した **Lezer パースツリーを再利用**し
  (`syntaxTree(state)`)、エラーノード (`node.type.isError` = 括弧不整合など) と、
  クオートで始まり閉じられていないトークン (未終端の文字列/引用符付き識別子。Lezer は
  未終端文字列をエラーにせず EOF まで伸びる 1 トークンにするためツリーから別途拾う) を
  `@codemirror/lint` の `Diagnostic[]` へ変換する。加えて、未終端のブロックコメント
  (`/*` 未クローズ) と、**文の先頭キーワードのタイポ** (`SELEC` など。各 `Statement`
  の先頭トークンが `Keyword` 系でなく素の `Identifier` の文を warning で報告。
  `STATEMENT_START_EXTRA` の許可リストが方言キーワード表の載り漏れに対する安全弁)、
  **句の順序ミス** (`ORDER BY` の後の `WHERE` など。文直下の `Keyword` 列を
  `WHERE → GROUP BY → HAVING → ORDER BY → LIMIT` のランクで走査し、違反句を warning
  で報告。サブクエリ / `OVER (...)` 内は `Parens` に包まれるため対象外。報告対象は
  3 方言で完全予約語の句のみで、非予約語 `OFFSET` は列名と区別できないため判定に
  使わない。SELECT / 集合演算でランクをリセットし `INSERT ... SELECT` も誤検出
  しない) も検出する。エディタの `closeBrackets()` が括弧/クオートをタイプ中に自動で閉じるため
  括弧系の検出は主に貼り付け・削除後に効き、タイプ中の主戦力は文頭キーワード判定。
  見た目判定はリーフトークン限定 (コンテナノードに適用するとクオートで始まる文全体を
  未終端と誤検出する)。`QueryEditor` が `lintGutter()` +
  `linter()` (デバウンス 500ms) を Compartment 越しに追加し、設定 `sqlLintEnabled`
  (既定オン) のオン/オフと言語切替で再構成する。方言追従は共有ツリー経由で自動 (別途
  dialect を渡さない)。診断メッセージは `i18n` (`editorLint*`) で日英対応。**編集支援
  (ベストエフォート) であって安全判定ではない**: 文法が寛容なため文中のタイポ
  (`FORM` 等) やカンマ抜けは検出できず、`apply_auto_limit` と同じく誤検出より見逃しを
  優先する保守的方針 (打ちかけの先頭単語 = 後続トークンなしも flag しない)。安全網
  (`dangerousSql.ts` / `is_read_only_sql`) とは目的も経路も別物で判定
  ロジックを共有しない。`sqlLint.test.ts` が正常 SQL の非検出・未終端/括弧/文頭
  タイポの検出・方言差を固定する。
- `i18n.ts` — 日本語/英語の文字列テーブルと `useT` フック。
- `tabPersistence.ts` — プロファイルごとの開きタブを localStorage に保存/復元。
- `errorHints.ts` — DB エラー文字列を人間向けのヒントに対応付け。
