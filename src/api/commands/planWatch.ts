// `src-tauri/src/commands/plan_watch.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { PlanWatchEntry, PlanWatchRefreshResult } from "../tauri";

export const planWatchCommands = {

  // --- 実行計画ウォッチ (#743 / #1260) ---

  /** プロファイルのウォッチ一覧 (世代つき)。セッション不要。 */
  planWatchList: (profileId: string) =>
    invoke<PlanWatchEntry[]>("plan_watch_list", { profileId }).then((r) =>
      parseResponse(schemas.planWatchEntryArray, r, "plan_watch_list"),
    ),

  /** ウォッチの登録 / 解除。解除時は蓄積した世代ごと削除する。 */
  planWatchSet: (profileId: string, snippetId: string, watched: boolean) =>
    invoke<void>("plan_watch_set", { profileId, snippetId, watched }),

  /**
   * ウォッチ中スニペット (`snippetIds` 指定時はその部分集合) の EXPLAIN を Rust 内でまとめて
   * 実行し、世代を記録する。クエリ履歴には記録されない。
   */
  planWatchRefresh: (sessionId: string, profileId: string, snippetIds?: string[]) =>
    invoke<PlanWatchRefreshResult>("plan_watch_refresh", {
      sessionId,
      profileId,
      snippetIds: snippetIds ?? null,
    }).then((r) => parseResponse(schemas.planWatchRefreshResult, r, "plan_watch_refresh")),

  /** 旧 localStorage のウォッチを一度だけ取り込む。取り込んだウォッチ数を返す。 */
  planWatchImportLegacy: (profileId: string, watches: PlanWatchEntry[]) =>
    invoke<number>("plan_watch_import_legacy", { profileId, watches }).then((r) =>
      parseResponse(schemas.numberResponse, r, "plan_watch_import_legacy"),
    ),
};
