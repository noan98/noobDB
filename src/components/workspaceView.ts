/**
 * メイン領域が「今どの全画面サーフェスを表示しているか」の判別子 (#1020)。
 *
 * `App.tsx` の `<main>` 直下は、スキーマ比較 / ER 図 / プロセス監視 / ユーザ管理 /
 * Server Info / クエリインスペクタ / Advisor / テーブル統計 / 結果比較 / 接続
 * フォーム / スニペットフォーム / 通常ワークスペースという**互いに排他な全画面
 * サーフェス**の三項チェーンになっている。この関数はそのチェーンと同順・同条件で
 * 「今どれか」を 1 つの文字列へ畳み、`AnimatePresence mode="wait"` の `key` として
 * 使う — 結果パネル側のクロスフェード (#788 の `contentMode`) と同じ発想で、
 * ビューが入れ替わるときだけ控えめにフェードを添えるための判別子である。
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
  | "processes"
  | "users"
  | "serverInfo"
  | "queryInspector"
  | "advisor"
  | "sizes"
  | "compareResults"
  | "form"
  | "snippetForm"
  | "workspace";

/** `workspaceViewKey` の入力。`App.tsx` の該当 state をそのまま写したもの。 */
export type WorkspaceViewInput = {
  showCompare: boolean;
  showErd: boolean;
  showProcesses: boolean;
  showUsers: boolean;
  showServerInfo: boolean;
  showQueryInspector: boolean;
  showAdvisor: boolean;
  showSizes: boolean;
  showCompareResults: boolean;
  showForm: boolean;
  showSnippetForm: boolean;
  /**
   * 接続中セッション。接続スコープのパネル (ER 図 / プロセス監視 / ユーザ管理 /
   * Server Info / インスペクタ / Advisor / テーブル統計) はこれが無いと開けない。
   */
  sessionId: string | null;
  /** Advisor の対象 DB (アクティブタブ → プロファイル既定の順で解決済み)。 */
  advisorDatabase: string | null | undefined;
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
  if (input.showProcesses && connected) return "processes";
  if (input.showUsers && connected) return "users";
  if (input.showServerInfo && connected) return "serverInfo";
  if (input.showQueryInspector && connected) return "queryInspector";
  if (input.showAdvisor && connected && !!input.advisorDatabase) return "advisor";
  if (input.showSizes && !!input.sizesTarget && connected) return "sizes";
  if (input.showCompareResults) return "compareResults";
  if (input.showForm) return "form";
  if (input.showSnippetForm) return "snippetForm";
  return "workspace";
}
