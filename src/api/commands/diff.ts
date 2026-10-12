// `src-tauri/src/commands/diff.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { SchemaDiff, DataDiffHandle } from "../tauri";

export const diffCommands = {
  compareSchema: (params: {
    sourceSessionId: string;
    sourceDatabase: string;
    targetSessionId: string;
    targetDatabase: string;
  }) =>
    invoke<SchemaDiff>("compare_schema", {
      sourceSessionId: params.sourceSessionId,
      sourceDatabase: params.sourceDatabase,
      targetSessionId: params.targetSessionId,
      targetDatabase: params.targetDatabase,
    }).then((r) => parseResponse(schemas.schemaDiff, r, "compare_schema")),
  compareTableData: (params: {
    sourceSessionId: string;
    sourceDatabase: string;
    targetSessionId: string;
    targetDatabase: string;
    table: string;
    limit?: number | null;
    /** true なら上限を使わず、主キーのキーセットページングで全行を比較する (#1539)。 */
    allRows?: boolean | null;
    /** 比較から外す列 (updated_at など環境ごとに値が違う列, #1539)。 */
    ignoreColumns?: string[] | null;
  }) =>
    invoke<DataDiffHandle>("compare_table_data", {
      sourceSessionId: params.sourceSessionId,
      sourceDatabase: params.sourceDatabase,
      targetSessionId: params.targetSessionId,
      targetDatabase: params.targetDatabase,
      table: params.table,
      limit: params.limit ?? null,
      allRows: params.allRows ?? null,
      ignoreColumns: params.ignoreColumns && params.ignoreColumns.length > 0 ? params.ignoreColumns : null,
    }).then((r) => parseResponse(schemas.dataDiffHandle, r, "compare_table_data")),
};
