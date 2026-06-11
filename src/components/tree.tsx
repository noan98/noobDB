import { chakra } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";

/**
 * サイドパネルのツリー表示で共有する Chakra プリミティブ群。
 *
 * 元々は `App.css` の `.tree-*` クラスで描画していたものを、style props を持つ
 * Chakra コンポーネントへ移植したもの。`HistoryList` / `SnippetList` のように
 * 接続ツリーと同じ見た目を再利用する複数のパネルで共通利用する。
 *
 * 接続ツリー本体 (`ConnectionList`) もこれらのプリミティブへ移行済みで、profile /
 * db / table / column 行は `TreeRow` などに style props を重ねて描画している。
 * 対応する `App.css` の `.tree-*` ルールは撤去済み。
 */

/** ツリー行・メニュー項目などで共有する微トランジション (旧 App.css の共通ルール)。 */
const TREE_ROW_TRANSITION = {
  transitionProperty: "background, color, border-color, box-shadow",
  transitionDuration: "var(--dur-fast)",
  transitionTimingFunction: "var(--ease)",
} as const;

/** キーボードフォーカスリング。動的アクセントへ追従させるため CSS 変数を直接参照。 */
const FOCUS_RING = "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)";

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

export const TreeRow = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "1",
    pt: "1",
    pb: "1",
    pr: "2.5",
    pl: "1.5",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    borderLeft: "2px solid transparent",
    ...TREE_ROW_TRANSITION,
    _hover: { bg: "app.hover" },
    _focusVisible: { outline: "none", boxShadow: FOCUS_RING },
  },
});

/**
 * Motion 化したツリー行。`TreeRow` と同じ見た目 (base スタイルを共有) を持つ
 * `motion.div` で、`whileHover` などのジェスチャプロップを受け付ける。接続プロファイル
 * 行のホバー演出 (scale + 影、Epic #370 準拠) に使う。`prefers-reduced-motion` は
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
      pt: "1",
      pb: "1",
      pr: "2.5",
      pl: "1.5",
      cursor: "pointer",
      userSelect: "none",
      whiteSpace: "nowrap",
      overflow: "hidden",
      borderLeft: "2px solid transparent",
      ...TREE_ROW_TRANSITION,
      _hover: { bg: "app.hover" },
      _focusVisible: { outline: "none", boxShadow: FOCUS_RING },
    },
  },
  { forwardProps: ["transition"] },
);

export const TreeChevron = chakra("span", {
  base: {
    display: "inline-block",
    width: "14px",
    textAlign: "center",
    color: "app.textMuted",
    fontSize: "2xs",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionDuration: "var(--dur-fast)",
    transitionTimingFunction: "var(--ease)",
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
  base: {
    fontSize: "2xs",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    px: "1.5",
    py: "1px",
    borderRadius: "pill",
    bg: "app.surfaceMuted",
    color: "app.textMuted",
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
    margin: "6px 0 0",
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
 * フィルタ入力中に多数項目の height を毎フレーム測り直す負荷を避ける (#403)。
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
 * **性能上の注意 (#403):** 以前は `height: 0 ↔ auto` を補間していたが、これは
 * 大きな DB を展開するたびに配下の数百行のレイアウトを毎フレーム測り直すため、
 * スキーマ操作が体感で重くなる原因だった。height は補間せず opacity だけを
 * フェードすることで、ブラウザのレイアウト/リフローを起こさず (合成のみで)
 * 軽量に開閉する。隣接項目はアニメーションせず即座に詰まる。
 */
export function TreeCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <MotionCollapse {...variants.fade} transition={transitions.crossfade}>
          {children}
        </MotionCollapse>
      )}
    </AnimatePresence>
  );
}
