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
    /** ソース側の表名。`targetTable` が無ければターゲットも同名。 */
    table: string;
    /** ターゲット側の表名 (#1880)。省略 / 空なら `table` と同じ。同期 SQL はこの表に対して生成される。 */
    targetTable?: string | null;
    limit?: number | null;
    /** true なら上限を使わず、主キーのキーセットページングで全行を比較する (#1539)。 */
    allRows?: boolean | null;
    /** 比較から外す列 (updated_at など環境ごとに値が違う列, #1539)。 */
    ignoreColumns?: string[] | null;
    /** 全行比較の進捗 (`listenDataDiffProgress`) と `cancelStream` による中止に使う ID (#1612)。 */
    streamId?: string | null;
  }) =>
    invoke<DataDiffHandle>("compare_table_data", {
      sourceSessionId: params.sourceSessionId,
      sourceDatabase: params.sourceDatabase,
      targetSessionId: params.targetSessionId,
      targetDatabase: params.targetDatabase,
      table: params.table,
      targetTable: params.targetTable ? params.targetTable : null,
      limit: params.limit ?? null,
      allRows: params.allRows ?? null,
      ignoreColumns: params.ignoreColumns && params.ignoreColumns.length > 0 ? params.ignoreColumns : null,
      streamId: params.streamId ?? null,
    }).then((r) => parseResponse(schemas.dataDiffHandle, r, "compare_table_data")),
};
