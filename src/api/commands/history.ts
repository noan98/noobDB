// `src-tauri/src/commands/history.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { HistoryEntry } from "../tauri";

/** `invoke` のジェネリックに `(` を含めない (IPC パリティテストの正規表現が読めなくなるため)。 */
type NullableStrings = Array<string | null>;

export const historyCommands = {
  listHistory: (
    params: {
      profileId?: string | null;
      limit?: number | null;
      search?: string | null;
      /** `"ok"` or `"error"`; omit/`null` for no status filter (#822). */
      status?: string | null;
      /** RFC3339 inclusive lower bound on `executed_at` (#822). */
      from?: string | null;
      /** RFC3339 inclusive upper bound on `executed_at` (#822). */
      to?: string | null;
    } = {},
  ) =>
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
  /**
   * 履歴の複数 id の SQL 全文をまとめて取る。`ids` と同じ順・同じ長さで、削除済みなどで取れない行は
   * `null` (履歴 AI 検索の候補取得用。1 件ずつ IPC を往復しない)。
   */
  getHistorySqls: (ids: number[]) =>
    invoke<NullableStrings>("get_history_sqls", { ids }).then((r) =>
      parseResponse(schemas.nullableStringArrayResponse, r, "get_history_sqls"),
    ),
  /** 直近の実行 SQL 全文だけを新しい順に返す (↑/↓ 履歴ナビ・コマンドパレット用、#1256)。 */
  listHistorySql: (params: { profileId?: string | null; limit?: number | null } = {}) =>
    invoke<string[]>("list_history_sql", {
      profileId: params.profileId ?? null,
      limit: params.limit ?? null,
    }).then((r) => parseResponse(schemas.stringArray, r, "list_history_sql")),
  /** 履歴の保持日数 (#1539)。0 は無効 (行数上限だけが効く)。 */
  getHistoryRetentionDays: () =>
    invoke<number>("get_history_retention_days").then((r) =>
      parseResponse(schemas.numberResponse, r, "get_history_retention_days"),
    ),
  /** 履歴の保持日数を保存し、期限切れの行をすぐ削除する。削除した行数を返す。 */
  setHistoryRetentionDays: (days: number) =>
    invoke<number>("set_history_retention_days", { days }).then((r) =>
      parseResponse(schemas.numberResponse, r, "set_history_retention_days"),
    ),
  /**
   * 履歴の指定 id の行だけを削除し、消えた件数を返す (#1627)。一覧で選択した行や、絞り込みで
   * 表示中の行の一括削除用。存在しない id は無視する。上限 10,000 件。
   */
  deleteHistoryEntries: (ids: number[]) =>
    invoke<number>("delete_history_entries", { ids }).then((r) =>
      parseResponse(schemas.numberResponse, r, "delete_history_entries"),
    ),
  clearHistory: (profileId?: string | null) =>
    invoke<number>("clear_history", { profileId: profileId ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "clear_history"),
    ),
};
