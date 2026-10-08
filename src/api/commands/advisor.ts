// `src-tauri/src/commands/advisor.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { SchemaHealthReport } from "../tauri";

export const advisorCommands = {
  /** スキーマ健全性を診断する (#741)。読み取りのみ。指摘リストと、前提を満たさず
   *  スキップしたルール (理由コード付き) を返す。 */
  analyzeSchemaHealth: (sessionId: string, database: string) =>
    invoke<SchemaHealthReport>("analyze_schema_health", { sessionId, database }).then((r) =>
      parseResponse(schemas.schemaHealthReport, r, "analyze_schema_health"),
    ),
};
