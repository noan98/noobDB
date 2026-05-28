import { chakra } from "@chakra-ui/react";

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
    px: "10px",
    py: "8px",
    borderBottom: "1px solid",
    borderColor: "app.borderSubtle",
    "& input": { px: "8px", py: "5px", fontSize: "sm" },
  },
});

export const Tree = chakra("div", {
  base: { flex: 1, overflowY: "auto", py: "4px", fontSize: "md", color: "app.text" },
});

export const TreeNode = chakra("div", {
  base: { display: "flex", flexDirection: "column" },
});

export const TreeRow = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    pt: "4px",
    pb: "4px",
    pr: "10px",
    pl: "6px",
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
    px: "6px",
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
    gap: "6px",
    margin: "6px 0 0",
    fontSize: "xs",
    fontWeight: 400,
    color: "app.textMuted",
    cursor: "pointer",
  },
});
