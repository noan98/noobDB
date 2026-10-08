// `src-tauri/src/commands/profile.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ColumnProfile } from "../tauri";

export const profileCommands = {
  /**
   * 列データプロファイル (#974)。単一 SELECT の集計だけなので read_only セッション
   * でも動く。`approximate` は PostgreSQL (統計情報) で DISTINCT を近似する
   * (他ドライバは正確値に縮退し `notes` に理由が入る)。
   */
  profileColumn: (
    sessionId: string,
    database: string,
    table: string,
    column: string,
    approximate: boolean,
    topN?: number | null,
  ) =>
    invoke<ColumnProfile>("profile_column", {
      sessionId,
      database,
      table,
      column,
      approximate,
      topN: topN ?? null,
    }).then((r) => parseResponse(schemas.columnProfile, r, "profile_column")),
};
