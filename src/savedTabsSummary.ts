// 接続ごとの保存済みワークスペース (タブ) の一覧表示用の要約 (#1630)。保存内容そのものは
// `tabPersistence.ts` が持つ。ここは「何個のタブが、どのペインに、どんな SQL で」入っているかを
// 人が読める形に畳む純関数だけ。

import type { PersistedWorkspace } from "./tabPersistence";

export interface SavedTabSummary {
  title: string;
  kind: "table" | "query" | "explain";
  /** `database.table` / `database` / null。 */
  target: string | null;
  /** SQL の先頭の空でない 1 行 (長いものは省略記号付きで切る)。SQL が空なら空文字。 */
  sqlHead: string;
}

export interface SavedPaneSummary {
  tabs: SavedTabSummary[];
}

export interface SavedWorkspaceSummary {
  total: number;
  panes: SavedPaneSummary[];
}

/** SQL の先頭の空でない行を、`max` 文字までに切って返す。 */
export function sqlHeadLine(sql: string, max = 80): string {
  const first = sql
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!first) return "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

export function summarizeSavedWorkspace(ws: PersistedWorkspace, maxSqlChars = 80): SavedWorkspaceSummary {
  const panes = ws.panes.map((pane) => ({
    tabs: pane.tabs.map((tab) => ({
      title: tab.title,
      kind: tab.kind,
      target: tab.database
        ? tab.table
          ? `${tab.database}.${tab.table}`
          : tab.database
        : (tab.table ?? null),
      sqlHead: sqlHeadLine(tab.sql, maxSqlChars),
    })),
  }));
  return { total: panes.reduce((n, p) => n + p.tabs.length, 0), panes };
}
