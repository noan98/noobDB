import type { Transition, Variants } from "motion/react";

/**
 * 共有モーションプリセット。
 *
 * UI 全体のアニメーション (duration / easing / spring / variants) をここに集約し、
 * 各コンポーネントがインラインで数値を散らかさないようにする。値は CSS のモーション
 * トークン (`src/App.css` の `--ease` / `--ease-out` / `--dur-*`) と思想を揃えており、
 * JS (motion) と CSS のどちらで書いても動きの印象が一致するようにしている。
 *
 * ## reducedMotion 方針
 *
 * `prefers-reduced-motion: reduce` への対応は **2 系統で自動的に効く**ため、個々の
 * アニメーションで分岐を書く必要はない。
 *
 * - **motion (JS):** ルートの `<MotionConfig reducedMotion="user">` (`src/main.tsx`)
 *   が `motion/react` ツリー全体へ伝播する。OS 設定が「動きを減らす」のとき、
 *   ここで定義した transition / spring は自動的に即時切替 (実質 0 秒) になる。
 *   → **新規アニメは MotionConfig 配下 (=通常の React ツリー内) で書けば自動で抑制される。**
 * - **CSS:** `src/App.css` 末尾の `@media (prefers-reduced-motion: reduce)` が
 *   全要素の transition / animation を実質無効化する。
 *
 * **アプリ内モーション量コントロール (#787、`settings.motionPreference`):**
 * OS 設定を変えられない/変えたくないユーザ向けに、上記 2 系統を OS 設定に
 * 関わらず強制できる。`"reduced"` は常に抑制、`"full"` は常に有効化、`"system"`
 * (既定) は上記のとおり OS 追従のまま。JS 側は `main.tsx` の `MotionRoot` が
 * `MotionConfig reducedMotion` を `"always"`/`"never"`/`"user"` に切り替え、CSS
 * 側は `App.tsx` が `document.documentElement` に反映する `data-motion` 属性を
 * `App.css` の `:root[data-motion="reduced"]` / `:root[data-motion="full"]` が
 * 参照する。個々のコンポーネントはこれまでどおり何も分岐を書く必要はない。
 *
 * ## 「CSS のまま残す / Motion 化する」の境界
 *
 * - **CSS のまま残す:** 単純な hover / focus / active の色・影・枠線などの
 *   transition。状態を 1 プロパティの補間で表現でき、要素の出入り (mount/unmount)
 *   を伴わないもの。例: ボタンやタブの `transitionProperty="background, ..."`。
 *   これらを motion 化しても利点が薄く、レンダリングコストが増えるだけなので
 *   CSS (`--dur-*` / `--ease`) に任せる。
 * - **Motion 化する:** 要素の出入り (`AnimatePresence`)、レイアウト遷移
 *   (`layout` / `layoutId`)、複数プロパティの協調 (フェード + スケール + 移動)、
 *   spring など、CSS transition だけでは表現が難しい/煩雑になるもの。
 *
 * ### 具体的に CSS transition のまま残すもの (Motion 化しない確定リスト)
 *
 * - `TitleBar` のウィンドウ操作ボタン (最小化/最大化/閉じる) の hover/active 配色。
 * - `ConnectionForm` をはじめとするフォーム入力の focus/hover の枠線・影。
 * - 共通ボタン (`ui.tsx` の `Button`)、タブ・ツリー行・コンテキストメニュー項目・
 *   ツールバーボタンの hover/focus 配色とフォーカスリング (box-shadow)。
 * - キャレット (▸) の回転 (`tree.tsx` の `TreeChevron` の `transform` transition)。
 * - 接続ステータスドットの色/影遷移、`connecting` の脈動 (`@keyframes pulse`)、
 *   スピナー回転 (`@keyframes spinner-rotate`) などの CSS アニメーション。
 * - 接続確立のステータスドットのリング bloom (`@keyframes tunnel-open-bloom`、#1866)。
 *
 * ### 具体的に Motion 化したもの
 *
 * - サイドバーのタブ切替の中身 (`KeepAlive` の `slideDirection` / `App` の接続タブ — `directionalSlide`、
 *   #1830)。滑るインジケータと同じ向きに、表示へ切り替わる側だけスライド + フェードで入る
 *   (再マウントしない)。reduced-motion では x 移動が止まり、opacity の短いフェードは残る。
 * - モーダル/ダイアログの開閉 (`Modal` — `variants.dialog` / `fade`)。
 * - タブの追加/削除とアクティブインジケータ (`TabBar` — `layout` / `layoutId`)。
 * - トースト通知の出入り (`Toast` — `transitions.emphasized`)。
 * - ツリーの展開/折りたたみとリスト項目の出入り (`ConnectionList` /
 *   `SnippetList` / `HistoryList` — `TreeCollapse` / `MotionTreeNode` /
 *   `variants.collapse`)。
 * - コンテキストメニューの出現 (`ContextMenu` — 軽い fade + scale、enter のみ)。
 * - 空/オンボーディング表示の fade-in (`EmptyState`)。
 * - `Switch` のつまみ (`springs.snappy`)、アイコン/バッジのクロスフェード
 *   (`MultiStateBadge` / `QueryEditor` / `ImportModal` / `App`)。
 * - 結果グリッドの列ドラッグ並べ替えの確定 (`ResultGrid` — `useColumnReorderFlip`、
 *   #1021)。`TabBar` と同じ「定位置へ滑る」動きだが、ヘッダは全列ぶん常に描画され
 *   頻繁に再レンダーされるため `layout` は使わず、ドロップ確定の 1 回だけ計測する
 *   手書き FLIP (Web Animations API) で `durations.base` / `easings.out` を再利用する。
 *   Motion の外なので reduced-motion は `useReducedMotionConfig` で明示的に見る。
 * - 結果グリッドのクライアント側ソート / フィルタ適用 (`ResultGrid` — `useRowCrossfade`、
 *   #1416)。行方向の per-row FLIP は仮想化グリッドで重いため避け、`<tbody>` 1 要素の
 *   opacity だけを Web Animations API で 1 回再生する (`transitions.crossfade` 相当の
 *   `durations.quick`)。key で再マウントしないのでスクロール・選択・編集状態は保たれ、
 *   reduced-motion は `useReducedMotionConfig` で見る。
 * - ピボットの再集計 (`PivotView` — `useRowCrossfade` を再利用、#1862)。行/列/値/集計/ヒートマップの
 *   確定で `<tbody>` を 1 回クロスフェードし、集計セルは `CountUpText` で前値→新値を補間、ヒートの
 *   背景色は CSS transition で色補間する。key で再マウントしないのでスクロールは保たれる。
 * - 結果グリッドの初回バッチ着弾リビール (`ResultGrid` — `useFirstBatchReveal`、#1579)。
 *   ストリーミング中のスケルトンの次に最初の行が届いたコミットで、画面内の行 (遅延は 12 段で頭打ち) の
 *   `<tr>` だけを Web Animations API で 1 回 stagger フェード / slide-up する。per-row FLIP
 *   ではなく「入場 1 回・可視行限定・計測は上端座標の読み取りのみ」で、追加バッチ / スクロール /
 *   ソートでは再生しない。遅延は `staggerTiming.each` を再利用。reduced-motion・ハイコントラストは即時。
 * - 読み取り専用メタデータパネル (構造 / 統計 / アドバイザ / サーバ情報 / インスペクタ) の初回ロード行
 *   リビール (`RevealTbody`、#1886)。スケルトンの `<tbody>` と実データの `<tbody>` を別要素にし、実データ側が
 *   マウントされた 1 回だけ、画面内の行を `useFirstBatchReveal` と同じ Web Animations API・同じ段数上限
 *   (`firstBatchReveal.ts` を共有) で stagger フェード / slide-up する。再フェッチ・フィルタ・ソートは即時。
 *   reduced-motion・ハイコントラストは何も再生しない。
 * - 結果グリッドの滑って追従する選択枠 (`ResultGrid` — `useGlideFrame`、#1578)。アクティブセル /
 *   範囲選択 / 現在の検索ヒットごとに絶対配置の枠 1 枚を置き、対象が変わった確定コミットの 1 回だけ
 *   セルを計測して前の位置から left/top/width/height を Web Animations API で滑らせる
 *   (`transitions.emphasized` 相当の `durations.med` + `easings.out`)。per-row の `layout` は使わない。
 *   スクロール中は計測せず、固定列・描画窓の外では枠を出さず元のセル単位のリングに任せる。
 *   reduced-motion・ハイコントラストは即座に置く。
 * - 設定「表示」のライブ・アピアランス・プレビューのデモ (`AppearancePreview` — `useAnimate`、#1781)。
 *   マウント後と、確定した設定値 (`replayKey`) が変わるたびに 1 回ずつ
 *   (連打は 250ms でまとめる)、RunButton の押下 → 選択下地が 1 行下へ滑る → 枠が一瞬光る。画面内・タブ可視に
 *   なってから始め、`useAnimate` で DOM を直接動かす (React の再描画なし)。尺・イージングは `durations` / `easings` を再利用。
 *   reduced-motion (`useReducedMotionConfig`)・ハイコントラストは最初から終了状態、再生中に reduced へ
 *   変わったら止めて終了状態にする。
 * - 結果パネルの種類切替 (`App` — exit 無しの `AnimatePresence` + `variants.fade` で入場だけ、#1311)。
 *   グリッド ⇔ EXPLAIN / チャート / ピボット / プレビュー / バッチのように「軽量
 *   パネルの種類が変わる」ときだけ控えめにクロスフェードする。key を表示内容の
 *   種類 (contentMode) にしているため、table ⇔ query タブ切替のように両者とも
 *   グリッドのままなら再生されず、重い `ResultGrid` をフェードのために再マウント
 *   しない (#788)。設定 / ヘルプ画面の開閉は `Modal` (上記) 経由で既にフェードする。
 * - ワークスペースの全画面ビュー切替 (`App` — 常駐ワークスペースの上に重ねる。
 *   サーフェスは `KeepAlive` が保持し再表示で `variants.fade` 入場、退場は待たない, #1311)。スキーマ比較 / ER 図 / プロセス監視 / ユーザ管理 /
 *   Server Info / クエリインスペクタ / Advisor / 接続フォームのように「メイン
 *   領域を丸ごと占有するサーフェス」が入れ替わるとき、上記 #788 と**同じ尺**
 *   (`transitions.enter`) でクロスフェードする (#1020)。key は `workspaceView`
 *   判別子で、同じビューのまま props だけが変わるケースでは再生されない。
 *   遅延ロード (`React.lazy`) されたビューがサスペンドしても退出中の旧ビューを
 *   巻き込まないよう、`Suspense` は `AnimatePresence` の外ではなく各
 *   `motion.div` の内側に置く。
 * - サイドバーのテーブル行 → 新規テーブルタブのアイコンの morph (`FlightIcon` /
 *   `sharedElement.ts` — コンポーネント境界を跨ぐ `layoutId`, #1415)。頻度の低い
 *   「タブ生成」1 箇所に限定し、IPC の間から morph が終わるまでの飛行中だけ起点に
 *   ID を付ける。`transitions.emphasized` を再利用し、reduced-motion は MotionConfig に従う。
 * - バッチ実行結果の文カード入場 (`BatchResultsView` — `AnimatePresence initial={false}` + `variants.collapse`、増えた分だけ
 *   `staggerTiming.each` でずらす)・件数サマリの `CountUpText`・成否ドットの `variants.fadeScale` + `springs.gentle` pop (#1873)。
 *   静止 (reduced-motion / `prefersStaticMotion`) では transition を 0 秒にする。
 * - JSON ツリーの展開 / 一括展開 (`JsonTreeView` — `useJsonTreeReveal`、#1863)。状態変更の直前に行を記録し、
 *   反映後に新しく現れた行のうち可視範囲のものだけを Web Animations API で 1 回 opacity + slide-up
 *   (`firstBatchReveal.offsetY`、`durations.quick`、遅延は 12 段で頭打ち) する。per-node の height
 *   補間や常駐 Motion コンポーネントは使わない。reduced-motion・ハイコントラストは即時。
 * - ライブ監視パネルの行の出入りと値変化フラッシュ (`ProcessListPanel` /
 *   `PlanWatchPanel` — `LiveRows.tsx` の `LiveRowsPresence` + `variants.collapse`、
 *   フラッシュは既存の `@keyframes apply-flash`、数値は `CountUp`) (#1022)。
 *   `height` / `opacity` の補間は `MotionConfig reducedMotion` では止まらないため、
 *   `LiveRowsPresence` が `useReducedMotion()` を見て transition を即時化する。
 * - クエリビルダーの WHERE 条件行の追加/削除 (`QueryBuilder` — `LiveRowsPresence` +
 *   `LiveCollapse` の `variants.collapse`、#1936)。行ごとに安定キーを持たせ、行間の gap は
 *   各行の内側 padding に移して畳み終わりに隙間が残らないようにする。
 */

/** cubic-bezier カーブ。CSS の `--ease` / `--ease-out` と同じ値。 */
export const easings = {
  /** material standard。CSS `--ease` と一致。 */
  standard: [0.4, 0, 0.2, 1] as [number, number, number, number],
  /** decel (出現・移動の上品な減速)。CSS `--ease-out` と一致。 */
  out: [0.16, 1, 0.3, 1] as [number, number, number, number],
} as const;

/**
 * アニメーション時間 (秒)。`fast` / `base` / `slow` を基本トリオとし、
 * 実利用に合わせた中間値 (`quick` / `med`) も用意する。CSS の `--dur-*` と揃える。
 */
export const durations = {
  /** 最小のフェード/クロスフェード。CSS `--dur-fast` (120ms) と一致。 */
  fast: 0.12,
  /** 小さなクロスフェード (アイコン/テキストの差し替え)。 */
  quick: 0.15,
  /** 既定。layout・タブ開閉・プログレス出現など。 */
  base: 0.18,
  /** 中速の移動 (トースト・スライドインジケータ)。 */
  med: 0.22,
  /** 大きめの移動・プログレスの伸長。 */
  slow: 0.3,
} as const;

/** spring プリセット。 */
export const springs = {
  /** キビキビした切替 (Switch の thumb など)。 */
  snappy: { type: "spring", stiffness: 700, damping: 30 } as const,
  /** 軽い押下フィードバック (ボタンの hover/tap など)。 */
  gentle: { type: "spring", stiffness: 600, damping: 25 } as const,
} satisfies Record<string, Transition>;

/** よく使う transition プリセット。`transition={...}` にそのまま渡す。 */
export const transitions = {
  /** 透明度などの単純フェード (既定 ease + base)。 */
  fade: { duration: durations.base },
  /** 短いクロスフェード (既定 ease + quick)。 */
  crossfade: { duration: durations.quick },
  /** layout の伸縮 (standard ease + base)。 */
  layout: { duration: durations.base, ease: easings.standard },
  /** 要素の出入り (out ease + base)。 */
  enter: { duration: durations.base, ease: easings.out },
  /** 強調したい移動 (out ease + med)。 */
  emphasized: { duration: durations.med, ease: easings.out },
  /** プログレスの伸長など大きめの移動 (out ease + slow)。 */
  progress: { duration: durations.slow, ease: easings.out },
} satisfies Record<string, Transition>;

/**
 * stagger (協調した順次出現) の間隔トークン (#875)。リストの一括出現で
 * 子アイテムを何秒刻みでずらすか / 先頭を何秒待たせるかの単一ソース。
 * 各リストがインラインで数値を持たないよう、必ずここを参照する。
 */
export const staggerTiming = {
  /** 子アイテム間の出現間隔 (秒)。 */
  each: 0.035,
  /** コンテナ出現から最初の子までの待ち (秒)。 */
  delay: 0.04,
} as const;

/**
 * stagger コンテナの variants を返す (#875)。子要素には `variants.staggerItem`
 * を渡し、コンテナ側で `initial="initial" animate="animate"` を指定すると
 * 子へ variant が伝播して順次出現する。
 *
 * `reduced` に true を渡すと stagger を無効化し全子要素を同時表示へフォール
 * バックする。`MotionConfig reducedMotion` は transform を自動抑制するが
 * **stagger の遅延そのものは打ち消さない**ため、適用側が
 * `useReducedMotion()` (MotionConfig の設定も反映される) の値を渡すこと。
 */
export function staggerContainer(reduced: boolean): Variants {
  return {
    initial: {},
    animate: {
      transition: reduced
        ? { staggerChildren: 0, delayChildren: 0 }
        : { staggerChildren: staggerTiming.each, delayChildren: staggerTiming.delay },
    },
  };
}

/** よく使う variants。`AnimatePresence` と組み合わせて使う。 */
export const variants = {
  /** 透明度のみ。 */
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  /** 透明度 + スケール (アイコンのクロスフェード等)。 */
  fadeScale: {
    initial: { opacity: 0, scale: 0.7 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.7 },
  },
  /**
   * 透明度 + 横方向のスケール (タブの追加/削除、#1322)。`width` の補間は隣の要素の
   * 再配置を毎フレーム起こすため、レイアウトに関与しない transform で表す。
   * 使う側は `transformOrigin` を出入りの起点側 (左端など) に指定する。
   */
  fadeScaleX: {
    initial: { opacity: 0, scaleX: 0.6 },
    animate: { opacity: 1, scaleX: 1 },
    exit: { opacity: 0, scaleX: 0.6 },
  },
  /** 下から少し上げて出し、上へ抜ける (テキストの差し替え等)。 */
  slideUp: {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
  },
  /**
   * モーダル本体 (ダイアログ) の出入り。フェード + 控えめなスケール + 微小な
   * 上下スライドを enter/exit 対称にする。バックドロップ側は `fade` を使う。
   * `Modal.tsx` が `AnimatePresence` 配下で利用する。
   */
  dialog: {
    initial: { opacity: 0, scale: 0.96, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.96, y: 8 },
  },
  /**
   * 展開/折りたたみ (アコーディオン)。`height` を 0 ↔ auto に補間し opacity も
   * 連動させる。`AnimatePresence initial={false}` 配下でツリーノードの開閉や、
   * リスト項目の追加/削除 (高さ収縮で隣接項目が滑らかに詰まる) に使う。
   *
   * height アニメには `overflow: hidden` が必須だが、定常状態でそのままだと
   * 先頭/末尾行のフォーカスリング (box-shadow) が 2px 切れてしまう。そこで
   * `transitionEnd` で enter 完了後に `overflow: visible` へ戻し、収縮 (exit) 中
   * だけ hidden にすることで、見た目の退行なくクリッピングを両立する。
   * reduced-motion 時は `MotionConfig reducedMotion="user"` により即時化される。
   */
  collapse: {
    initial: { height: 0, opacity: 0, overflow: "hidden" },
    animate: { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } },
    exit: { height: 0, opacity: 0, overflow: "hidden" },
  },
  /**
   * stagger コンテナの子アイテム (#875)。`staggerContainer()` を variants に
   * 持つ親の配下に置くと、variant 伝播で順次フェードインする。y の微小移動は
   * reduced-motion 時に MotionConfig が自動で抑制する。
   */
  staggerItem: {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0, transition: transitions.enter },
  },
} satisfies Record<string, Variants>;

/**
 * 結果グリッドの初回バッチ着弾リビール (#1579, `useFirstBatchReveal`) の slide-up 量 (px)。
 * `variants.staggerItem` の y と揃えた控えめな値。
 */
export const firstBatchReveal = { offsetY: 4 } as const;

/** 結果グリッドの行クロスフェード (#1416) の開始 opacity。控えめに暗転するだけの値。 */
export const rowCrossfadeFrom = 0.35;

/**
 * 方向付きスライドの移動量 (px)。行送りのように「隣へ移った」空間的手がかりを
 * 出す控えめなスライドで使う (#1234)。コンポーネントに数値を直書きしない。
 */
export const slideOffsets = {
  /** Row Inspector の行送り。ドロワー開閉 (28) より小さく、本体だけ動かす。 */
  row: 16,
  /** 結果グリッドのページ送り (#1752)。`<tbody>` 全体が動くので行送りよりやや大きく。 */
  page: 24,
} as const;

/**
 * 方向付きスライド + フェードの variants (#1234)。`AnimatePresence custom={dir}` と
 * 子の `custom={dir}` に同じ向き (`-1` | `0` | `1`) を渡して使う。`dir` が正のとき
 * 右から入って左へ抜け、負のとき左から入って右へ抜ける。0 は x 移動なしのフェード。
 * reduced-motion 時の x 抑制は `MotionConfig` が担う。
 */
export const directionalSlide = {
  initial: (dir: number) => ({ opacity: 0, x: dir * slideOffsets.row }),
  animate: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -slideOffsets.row }),
} satisfies Variants;

/** reduced-motion (OS / アプリ設定 #787) が有効か。`data-motion` が OS 設定より優先する。 */
export function reducedMotionActive(): boolean {
  const motion = document.documentElement.getAttribute("data-motion");
  if (motion === "reduced") return true;
  if (motion === "full") return false;
  return (
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * `directionalSlide` の入場を、開始値を明示したキーフレームで返す (#1830)。keep-alive の
 * ように要素を残したまま表示を切り替える場合は `initial` が使えず、非表示中の値 (前回の
 * 向き) から始まってしまうため、毎回今回の向きから入らせる。
 */
export function directionalSlideKeyframes(dir: number) {
  const from = directionalSlide.initial(dir);
  return { opacity: [from.opacity, 1], x: [from.x, 0] };
}
