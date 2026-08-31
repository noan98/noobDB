# UI 基盤 (アイコン / ツールチップ / コンテキストメニュー / 配色)

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
