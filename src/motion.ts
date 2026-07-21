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
 *
 * ### 具体的に Motion 化したもの
 *
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
 * - 結果パネルの種類切替 (`App` — `AnimatePresence mode="wait"` + `variants.fade`)。
 *   グリッド ⇔ EXPLAIN / チャート / ピボット / プレビュー / バッチのように「軽量
 *   パネルの種類が変わる」ときだけ控えめにクロスフェードする。key を表示内容の
 *   種類 (contentMode) にしているため、table ⇔ query タブ切替のように両者とも
 *   グリッドのままなら再生されず、重い `ResultGrid` をフェードのために再マウント
 *   しない (#788)。設定 / ヘルプ画面の開閉は `Modal` (上記) 経由で既にフェードする。
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
} satisfies Record<string, Variants>;
