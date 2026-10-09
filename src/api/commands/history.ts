// `src-tauri/src/commands/history.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { HistoryEntry } from "../tauri";

export const historyCommands = {

  listHistory: (params: {
    profileId?: string | null;
    limit?: number | null;
    search?: string | null;
    /** `"ok"` or `"error"`; omit/`null` for no status filter (#822). */
    status?: string | null;
    /** RFC3339 inclusive lower bound on `executed_at` (#822). */
    from?: string | null;
    /** RFC3339 inclusive upper bound on `executed_at` (#822). */
    to?: string | null;
  } = {}) =>
    invoke<HistoryEntry[]>("list_history", {
      profileId: params.profileId ?? null,
      limit: params.limit ?? null,
      search: params.search ?? null,
      status: params.status ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
    }).then((r) => parseResponse(schemas.historyEntryArray, r, "list_history")),
  /** 履歴 1 件の SQL 全文 (#1256)。一覧 (`listHistory`) は要約しか運ばない。 */
  getHistorySql: (id: number) =>
    invoke<string>("get_history_sql", { id }).then((r) =>
      parseResponse(schemas.stringResponse, r, "get_history_sql"),
    ),
  /** 直近の実行 SQL 全文だけを新しい順に返す (↑/↓ 履歴ナビ・コマンドパレット用、#1256)。 */
  listHistorySql: (params: { profileId?: string | null; limit?: number | null } = {}) =>
    invoke<string[]>("list_history_sql", {
      profileId: params.profileId ?? null,
      limit: params.limit ?? null,
    }).then((r) => parseResponse(schemas.stringArray, r, "list_history_sql")),
  clearHistory: (profileId?: string | null) =>
    invoke<number>("clear_history", { profileId: profileId ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "clear_history"),
    ),
};
