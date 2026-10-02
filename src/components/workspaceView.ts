/**
 * メイン領域が「今どの全画面サーフェスを表示しているか」の判別子 (#1020)。
 *
 * `App.tsx` の `<main>` 直下は、スキーマ比較 / ER 図 / ユーザ管理 / Server Info /
 * テーブル統計 / 結果比較 / 接続フォーム / スニペットフォーム / 通常ワークスペース
 * という**互いに排他な全画面サーフェス**の三項チェーンになっている。
 *
 * プロセス監視 / クエリインスペクタ / アドバイザは #1112 (Epic #1110 Phase 2) で
 * **ボトムパネル**へ移した — ワークスペースを置き換えず同時に見えるため、全画面
 * サーフェスの排他集合には属さない (状態は `bottomPanelTabs.ts` が持つ)。この関数はそのチェーンと同順・同条件で
 * 「今どれか」を 1 つの文字列へ畳み、ワークスペース (常駐) の上に重ねるサーフェスの
 * 出し分け (#1311) とフォームのフェードの `key` として使う判別子である。
 *
 * ここに切り出しているのは、判定順序 (= どのサーフェスが優先されるか) が
 * ワークスペース切替の見え方を直接決めるにもかかわらず、`App.tsx` の巨大な JSX の
 * 中に埋めると単体で固定できないため。**`App.tsx` のチェーンに条件を足す/並べ
 * 替えるときは必ずこちらも揃えること** — ズレると「別ビューなのに key が同じ
 * (= 切替が瞬間的に戻る)」か「同じビューなのに key が変わる (= 無駄な再マウント)」
 * のどちらかになる。
 *
 * 表示そのものの責務は持たない (副作用なしの純関数)。
 */

/** 全画面サーフェスの識別子。`AnimatePresence` の `key` に使う。 */
export type WorkspaceViewKey =
  | "compare"
  | "erd"
  | "users"
  | "serverInfo"
  | "sizes"
  | "compareResults"
  | "form"
  | "snippetForm"
  | "workspace";

/** `workspaceViewKey` の入力。`App.tsx` の該当 state をそのまま写したもの。 */
export type WorkspaceViewInput = {
  showCompare: boolean;
  showErd: boolean;
  showUsers: boolean;
  showServerInfo: boolean;
  showSizes: boolean;
  showCompareResults: boolean;
  showForm: boolean;
  showSnippetForm: boolean;
  /**
   * 接続中セッション。接続スコープのサーフェス (ER 図 / ユーザ管理 / Server Info /
   * テーブル統計) はこれが無いと開けない。
   */
  sessionId: string | null;
  /** テーブル統計パネルの対象 DB。 */
  sizesTarget: string | null;
};

/**
 * 現在の全画面サーフェスを 1 つ返す。`App.tsx` の三項チェーンと同順で判定する。
 * どのフラグも立っていなければ通常のワークスペース (`"workspace"`)。
 */
export function workspaceViewKey(input: WorkspaceViewInput): WorkspaceViewKey {
  const connected = !!input.sessionId;
  if (input.showCompare) return "compare";
  if (input.showErd && connected) return "erd";
  if (input.showUsers && connected) return "users";
  if (input.showServerInfo && connected) return "serverInfo";
  if (input.showSizes && !!input.sizesTarget && connected) return "sizes";
  if (input.showCompareResults) return "compareResults";
  if (input.showForm) return "form";
  if (input.showSnippetForm) return "snippetForm";
  return "workspace";
}

/**
 * 保持 (keep-alive) するサーフェスの数の上限 (#1311)。ER 図・スキーマ比較などは重い
 * ので、よく使う数個だけを残し、古いものから捨てる。
 */
export const WORKSPACE_SURFACE_KEEP_ALIVE_LIMIT = 3;

/** `workspaceSurfaceKey` の入力。 */
export type WorkspaceSurfaceKeyInput = {
  sessionId: string | null;
  /** ER 図 / ユーザ管理が初期値として使う DB (アクティブタブ → プロファイル既定)。 */
  database: string | null;
  /** テーブル統計の対象 DB。 */
  sizesTarget: string | null;
};

/**
 * 全画面サーフェスを keep-alive で保持するときのインスタンスキー。
 *
 * 接続スコープのサーフェスは接続 (`sessionId`) と、開くときに渡す対象 DB をキーに
 * 含める: 接続や対象が変わったのに前のインスタンスを見せないため。接続を持たない
 * スキーマ比較 / 結果比較は view 名のまま。フォーム 2 種と通常のワークスペースは
 * 保持の対象外 (フォームは未保存の入力を持つ・ワークスペースは常駐) なので null。
 */
export function workspaceSurfaceKey(
  view: WorkspaceViewKey,
  input: WorkspaceSurfaceKeyInput,
): string | null {
  const sid = input.sessionId ?? "";
  switch (view) {
    case "compare":
    case "compareResults":
      return view;
    case "erd":
    case "users":
      return `${view}:${sid}:${input.database ?? ""}`;
    case "serverInfo":
      return `serverInfo:${sid}`;
    case "sizes":
      return `sizes:${sid}:${input.sizesTarget ?? ""}`;
    case "form":
    case "snippetForm":
    case "workspace":
      return null;
  }
}
