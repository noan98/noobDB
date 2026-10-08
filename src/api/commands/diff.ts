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
  }) =>
    invoke<DataDiffHandle>("compare_table_data", {
      sourceSessionId: params.sourceSessionId,
      sourceDatabase: params.sourceDatabase,
      targetSessionId: params.targetSessionId,
      targetDatabase: params.targetDatabase,
      table: params.table,
      limit: params.limit ?? null,
    }).then((r) => parseResponse(schemas.dataDiffHandle, r, "compare_table_data")),
};
