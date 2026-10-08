// `src-tauri/src/commands/table_open.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { OpenTableResult, OpenTableEntry } from "../tauri";

export const tableOpenCommands = {
  /**
   * テーブルタブを開くのに必要な情報 (列・行識別・初回 SELECT・行数推定) を 1 回で
   * 取得する (#1263)。列の取得失敗は reject、行識別・行数推定の失敗は null。
   * `withEstimate` が偽のときは行数推定を取りに行かない。
   */
  openTable: (
    sessionId: string,
    database: string,
    table: string,
    limit: number,
    withEstimate: boolean,
  ) =>
    invoke<OpenTableResult>("open_table", {
      sessionId,
      database,
      table,
      limit,
      withEstimate,
    }).then((r) => parseResponse(schemas.openTableResult, r, "open_table")),
  /**
   * セッション復元用の一括版 (#1263)。要求順に、テーブルごとの成功 / 失敗を返す
   * (行数推定は取得しない)。
   */
  openTables: (sessionId: string, tables: [string, string][], limit: number) =>
    invoke<OpenTableEntry[]>("open_tables", { sessionId, tables, limit }).then((r) =>
      parseResponse(schemas.openTableEntryArray, r, "open_tables"),
    ),
};
