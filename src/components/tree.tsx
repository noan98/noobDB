import { chakra } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";

/**
 * サイドパネルのツリー表示で共有する Chakra プリミティブ群。
 *
 * 接続ツリー本体 (`ConnectionList`) に加え、`HistoryList` / `SnippetList` のように
 * 接続ツリーと同じ見た目を再利用する複数のパネルで共通利用する。
 */

/** ツリー行・メニュー項目などで共有する微トランジション。 */
const TREE_ROW_TRANSITION = {
  transitionProperty: "background, color, border-color, box-shadow",
  transitionDuration: "var(--dur-fast)",
  transitionTimingFunction: "var(--ease)",
} as const;

/** キーボードフォーカスリング。単一ソースの `--focus-ring` (App.css) をそのまま使う。
 *  行内の操作要素 (`TreeChevronButton`) も同じリングを共有する。 */
const TREE_FOCUS_RING = "var(--focus-ring)";

/**
 * グループ / フォルダ見出し行 (接続グループ・スニペットフォルダ) の縦余白 (#1188)。
 * 通常のツリー行より一段ゆったりさせるため `--density-tree-py` の 1.5 倍を使う
 * (既定値は従来の `space-1-5` = 6px と等価な no-op)。見出し自体も密度設定に
 * 追従させ、`TreeRow` と同じ比率で伸縮させる。`ConnectionList` / `SnippetList` の
 * グループ見出し行で共有する。
 */
export const TREE_GROUP_HEADING_PY = "calc(var(--density-tree-py) * 1.5)";

export const TreePane = chakra("div", {
  base: { display: "flex", flexDirection: "column", overflow: "hidden", flex: 1 },
});

/** 検索ボックス行。内側の入力欄はやや小さめのサイズに揃える。 */
export const TreeSearch = chakra("div", {
  base: {
    px: "2.5",
    py: "2",
    borderBottom: "1px solid",
    borderColor: "app.borderSubtle",
    "& input": { px: "2", py: "5px", fontSize: "sm" },
  },
});

export const Tree = chakra("div", {
  base: { flex: 1, overflowY: "auto", py: "1", fontSize: "md", color: "app.text" },
});

export const TreeNode = chakra("div", {
  base: { display: "flex", flexDirection: "column" },
});

/** 縦余白 (`pt`/`pb`) は `--density-tree-py` (App.css) 経由で表示密度設定に追従する
 *  (#1188)。既定 (comfortable) は `--space-1` と等価な no-op。 */
export const TreeRow = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "1",
    pt: "var(--density-tree-py)",
    pb: "var(--density-tree-py)",
    pr: "2.5",
    pl: "1.5",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    borderLeft: "2px solid transparent",
    ...TREE_ROW_TRANSITION,
    _hover: { bg: "app.hover" },
    _focusVisible: { outline: "none", boxShadow: TREE_FOCUS_RING },
    // 行内の「…」ボタン (`TreeMoreButton`) はホバー / フォーカス中の行でだけ見せる (#1269)。
    "&:hover [data-tree-more], &:focus-within [data-tree-more]": { opacity: 1 },
  },
});

/**
 * Motion 化したツリー行。`TreeRow` と同じ見た目 (base スタイルを共有) を持つ
 * `motion.div` で、`whileHover` などのジェスチャプロップを受け付ける。接続プロファイル
 * 行のホバー演出 (scale + 影) に使う。`prefers-reduced-motion` は
 * ルートの `<MotionConfig reducedMotion="user">` (src/main.tsx) が自動で抑制する。
 *
 * motion の `transition` プロップは Chakra のスタイルプロップ名と衝突するため
 * `forwardProps` で明示転送する (`MotionTreeNode` と同方式)。
 */
export const MotionTreeRow = chakra(
  motion.div,
  {
    base: {
      display: "flex",
      alignItems: "center",
      gap: "1",
      pt: "var(--density-tree-py)",
      pb: "var(--density-tree-py)",
      pr: "2.5",
      pl: "1.5",
      cursor: "pointer",
      userSelect: "none",
      whiteSpace: "nowrap",
      overflow: "hidden",
      borderLeft: "2px solid transparent",
      ...TREE_ROW_TRANSITION,
      _hover: { bg: "app.hover" },
      _focusVisible: { outline: "none", boxShadow: TREE_FOCUS_RING },
    },
  },
  { forwardProps: ["transition"] },
);

const TREE_CHEVRON_BASE = {
  display: "inline-block",
  width: "14px",
  textAlign: "center",
  color: "app.textMuted",
  fontSize: "2xs",
  flexShrink: 0,
  transitionProperty: "transform",
  transitionDuration: "var(--dur-fast)",
  transitionTimingFunction: "var(--ease)",
} as const;

export const TreeChevron = chakra("span", { base: TREE_CHEVRON_BASE });

/**
 * 操作可能なチェブロン。見た目は `TreeChevron` と同じだが、ネイティブ `button` として
 * 描画してキーボード (Enter/Space) と支援技術から開閉トグルを実行できるようにする。
 * テーブル行のようにトグルがチェブロンに限定される場所で使い、利用側は
 * `aria-label` / `aria-expanded` を必ず渡すこと (装飾のみの `TreeChevron` と違い
 * `aria-hidden` にしない)。
 */
export const TreeChevronButton = chakra("button", {
  base: {
    ...TREE_CHEVRON_BASE,
    bg: "transparent",
    border: "none",
    p: "0",
    cursor: "pointer",
    _hover: { color: "app.text" },
    _focusVisible: { outline: "none", boxShadow: TREE_FOCUS_RING },
  },
});

/**
 * ツリー行末の「…」ボタン (#1269)。右クリックでしか開けなかった行メニューに、
 * マウス / タッチからの可視の入口を足す。ホバー・フォーカス中の行でだけ表示し
 * (`TreeRow` の `[data-tree-more]` ルール)、ホバーできない環境 (タッチ) では常時表示する。
 * 利用側は `aria-label` を必ず渡し、メニューは右クリックと同じ関数で開くこと。
 * 行の roving tabindex を増やさないよう `tabIndex={-1}` で使う (キーボードは
 * Shift+F10 / ContextMenu キーが同じメニューを開く)。
 */
export const TreeMoreButton = chakra("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    bg: "transparent",
    border: "none",
    borderRadius: "sm",
    p: "0.5",
    color: "app.textMuted",
    cursor: "pointer",
    opacity: 0,
    "@media (hover: none)": { opacity: 1 },
    transitionProperty: "opacity, color, background",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
    _hover: { color: "app.text", bg: "app.hover" },
    _focusVisible: { outline: "none", boxShadow: TREE_FOCUS_RING, opacity: 1 },
  },
});

export const TreeIcon = chakra("span", {
  base: {
    display: "inline-block",
    width: "16px",
    textAlign: "center",
    fontSize: "md",
    flexShrink: 0,
  },
});

export const TreeLabel = chakra("span", {
  base: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", fontWeight: 500 },
});

export const TreeBadge = chakra("span", {
  // タイポグラフィ (fontSize/fontWeight/letterSpacing/textTransform/color) は
  // `textStyles.overline` (#817) に一本化。背景・枠線・余白などのバッジ固有装飾は
  // ここに残す。個々の呼び出し側 (数値カウント等) が `textTransform="none"` /
  // `letterSpacing="0"` で上書きする既存の慣習はそのまま有効。
  base: {
    textStyle: "overline",
    px: "1.5",
    py: "1px",
    borderRadius: "pill",
    bg: "app.surfaceMuted",
    border: "1px solid",
    borderColor: "app.borderSubtle",
    flexShrink: 0,
  },
});

/** 検索ボックス下の「すべて表示」トグル (履歴 / スニペット一覧で共有)。 */
export const ScopeToggle = chakra("label", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "1.5",
    margin: "var(--space-1-5) 0 0",
    fontSize: "xs",
    fontWeight: 400,
    color: "app.textMuted",
    cursor: "pointer",
  },
});

/**
 * Motion 化したツリーノード。`TreeNode` と同じ縦積みレイアウトを持つ `motion.div`
 * で、`AnimatePresence` 配下に置くと項目の追加/削除が enter/exit でアニメーション
 * する。性能のため利用側は `variants.fade` (opacity のみ) を渡す運用とし、検索
 * フィルタ入力中に多数項目の height を毎フレーム測り直す負荷を避ける。
 *
 * motion の `transition` プロップは Chakra のスタイルプロップ名と衝突するため
 * `forwardProps` で明示的に転送する (`TabBar` / `Modal` と同方式)。`initial` /
 * `animate` / `exit` はスタイルプロップではないので既定で転送される。利用側は
 * `key` と `variants.collapse` (または `initial`/`animate` のみ) を渡す。
 */
export const MotionTreeNode = chakra(
  motion.div,
  { base: { display: "flex", flexDirection: "column" } },
  { forwardProps: ["transition"] },
);

const MotionCollapse = chakra(
  motion.div,
  { base: { display: "flex", flexDirection: "column" } },
  { forwardProps: ["transition"] },
);

/**
 * ツリーノードの展開/折りたたみコンテナ。`open` の間だけ子をマウントし、
 * `AnimatePresence initial={false}` で **opacity のみ**を補間する
 * (`variants.fade`)。`initial={false}` なので初期表示で既に開いている
 * ノードは enter アニメせず、クリックによる開閉のみが動く。子の中身 (破線
 * インデントの `TreeChildren` 等) はそのまま渡す。
 *
 * **性能上の注意:** `height: 0 ↔ auto` を補間すると、大きな DB を展開するたびに
 * 配下の数百行のレイアウトを毎フレーム測り直すことになり、スキーマ操作が体感で
 * 重くなる。height は補間せず opacity だけを
 * フェードすることで、ブラウザのレイアウト/リフローを起こさず (合成のみで)
 * 軽量に開閉する。隣接項目はアニメーションせず即座に詰まる。
 */
export function TreeCollapse({
  open,
  children,
  initial = false,
  onExitComplete,
}: {
  open: boolean;
  children: ReactNode;
  /** マウント時点で既に開いている場合も enter アニメを再生するか。閉じている間は
   *  `TreeCollapse` 自体をマウントしない呼び出し側 (スキーマツリーのテーブル行、#1314) が、
   *  開く操作でマウントされたときだけ true にする。 */
  initial?: boolean;
  /** 退場アニメが終わった (子が外れた) とき。呼び出し側が `TreeCollapse` ごと
   *  アンマウントする合図に使う。 */
  onExitComplete?: () => void;
}) {
  return (
    <AnimatePresence initial={initial} onExitComplete={onExitComplete}>
      {open && (
        <MotionCollapse {...variants.fade} transition={transitions.crossfade}>
          {children}
        </MotionCollapse>
      )}
    </AnimatePresence>
  );
}
