// `src-tauri/src/commands/table_open.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import { applyLogicalToColumns } from "../../logicalRelations";
import type { OpenTableResult, OpenTableEntry } from "../tauri";
import { listLogicalRelationsOrEmpty } from "./logicalRelations";

export const tableOpenCommands = {
  /**
   * テーブルタブを開くのに必要な情報 (列・行識別・初回 SELECT・行数推定) を 1 回で
   * 取得する (#1263)。列の取得失敗は reject、行識別・行数推定の失敗は null。
   * `withEstimate` が偽のときは行数推定を取りに行かない。
   */
  openTable: (sessionId: string, database: string, table: string, limit: number, withEstimate: boolean) =>
    invoke<OpenTableResult>("open_table", {
      sessionId,
      database,
      table,
      limit,
      withEstimate,
    })
      .then((r) => parseResponse(schemas.openTableResult, r, "open_table"))
      // 論理リレーション (仮想 FK, #2356) を列の参照先に重ねる。FK セルのジャンプはこの列を使う。
      .then(async (r) => ({
        ...r,
        columns: applyLogicalToColumns(
          table,
          r.columns,
          await listLogicalRelationsOrEmpty(sessionId, database),
        ),
      })),
  /**
   * セッション復元用の一括版 (#1263)。要求順に、テーブルごとの成功 / 失敗を返す
   * (行数推定は取得しない)。
   */
  openTables: (sessionId: string, tables: [string, string][], limit: number) =>
    invoke<OpenTableEntry[]>("open_tables", { sessionId, tables, limit })
      .then((r) => parseResponse(schemas.openTableEntryArray, r, "open_tables"))
      .then(async (entries) => {
        const dbs = [...new Set(entries.filter((e) => e.result).map((e) => e.database))];
        const byDb = new Map(
          await Promise.all(
            dbs.map(async (db) => [db, await listLogicalRelationsOrEmpty(sessionId, db)] as const),
          ),
        );
        return entries.map((e) =>
          e.result
            ? {
                ...e,
                result: {
                  ...e.result,
                  columns: applyLogicalToColumns(e.table, e.result.columns, byDb.get(e.database) ?? []),
                },
              }
            : e,
        );
      }),
};
