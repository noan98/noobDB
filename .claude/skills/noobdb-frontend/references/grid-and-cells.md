# 結果グリッドとセル操作の純ロジック

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
