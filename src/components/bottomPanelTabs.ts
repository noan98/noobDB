/**
 * ボトムパネル (#1112 / Epic #1110 Phase 2) の純ロジック。副作用なし
 * (DOM / localStorage に触れない) なので Vitest で単体テストできる。
 *
 * ## なぜボトムパネルを置くのか
 *
 * #1112 以前、アドバイザ・クエリインスペクタ・プロセスモニタは **`<main>` を丸ごと
 * 置き換える全画面サーフェス**だった。つまり「アドバイザの指摘を見ながら SQL を直す」
 * 「実行中のクエリを見ながら次を書く」ができず、参照のたびに作業画面が消えていた。
 *
 * これらは **継続的に参照する情報** なので、Epic の狙い (SQL Editor → Result Grid を
 * 主役にする) に従ってワークスペースの下に並べる。逆に ER 図・スキーマ比較・ユーザ
 * 管理・結果比較は「広い面積を占有して、それ自体が作業対象になる」ため全画面のまま。
 * この線引きは `.claude/rules/ui-design-system.md` の §7.1 に記述している。
 */

/** ボトムパネルに並ぶタブ。表示順もこの配列の順。 */
export const BOTTOM_PANEL_TABS = ["advisor", "inspector", "processes"] as const;

export type BottomPanelTab = (typeof BOTTOM_PANEL_TABS)[number];

/** タブを開けるかどうかの判定材料。`App.tsx` の該当 state を写したもの。 */
export interface BottomPanelContext {
  /** 接続中セッション。すべてのタブが接続を要求する。 */
  sessionId: string | null;
  /**
   * アドバイザの対象データベース (アクティブタブ → プロファイル既定の順で解決済み)。
   * 診断はデータベース単位なので、これが無いとアドバイザだけ開けない。
   */
  advisorDatabase: string | null | undefined;
}

/** 与えられた文脈で実際に開けるタブ (表示順を保つ)。 */
export function availableBottomPanelTabs(ctx: BottomPanelContext): BottomPanelTab[] {
  if (!ctx.sessionId) return [];
  return BOTTOM_PANEL_TABS.filter((tab) => tab !== "advisor" || !!ctx.advisorDatabase);
}

/**
 * 開いているタブを文脈に合わせて解決する。切断したり、対象データベースが外れて
 * 開けなくなったタブは閉じる (`null`)。**描画側はこの関数の戻り値だけを見る**ことで、
 * 「state は advisor のままだが開けない」という宙ぶらりんな状態を作らない。
 */
export function resolveBottomPanelTab(
  tab: BottomPanelTab | null,
  ctx: BottomPanelContext,
): BottomPanelTab | null {
  if (!tab) return null;
  return availableBottomPanelTabs(ctx).includes(tab) ? tab : null;
}

/**
 * タブを選んだときの次状態。**開いているタブをもう一度選ぶと閉じる** (トグル) —
 * ツールメニューやコマンドパレットから同じ項目を続けて選んだときに、開きっぱなしに
 * ならず「行って戻る」ができる。`paneLayout.ts` の `toggleLayoutMode` と同じ流儀。
 */
export function toggleBottomPanelTab(
  current: BottomPanelTab | null,
  next: BottomPanelTab,
): BottomPanelTab | null {
  return current === next ? null : next;
}

/**
 * 矢印キーでのタブ移動先。端で折り返す (サイドバーのタブ移動と同じ挙動)。
 * `tabs` が空、または `current` が含まれないときは `null` を返し、呼び出し側は
 * フォーカス移動を行わない。
 */
export function nextBottomPanelTab(
  tabs: readonly BottomPanelTab[],
  current: BottomPanelTab,
  delta: 1 | -1,
): BottomPanelTab | null {
  const i = tabs.indexOf(current);
  if (i < 0 || tabs.length === 0) return null;
  return tabs[(i + delta + tabs.length) % tabs.length];
}
