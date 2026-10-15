// `src-tauri/src/commands/advisor.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { HealthFinding, SchemaHealthReport } from "../tauri";

export const advisorCommands = {
  /** スキーマ健全性を診断する (#741)。読み取りのみ。指摘リストと、前提を満たさず
   *  スキップしたルール (理由コード付き) を返す。 */
  analyzeSchemaHealth: (sessionId: string, database: string) =>
    invoke<SchemaHealthReport>("analyze_schema_health", { sessionId, database }).then((r) =>
      parseResponse(schemas.schemaHealthReport, r, "analyze_schema_health"),
    ),
  /**
   * 指摘を「対応しない」にする (#1621)。非秘密の JSON ストアに (プロファイル, データベース,
   * 指摘キー) を保存し、次回以降の診断では本表から外れて別枠に折りたたまれる。
   */
  ignoreAdvisorFinding: (sessionId: string, database: string, finding: HealthFinding) =>
    invoke<void>("ignore_advisor_finding", { sessionId, database, finding }),
  /** 「対応しない」を取り消して通常の指摘に戻す (#1621)。 */
  unignoreAdvisorFinding: (sessionId: string, database: string, finding: HealthFinding) =>
    invoke<void>("unignore_advisor_finding", { sessionId, database, finding }),
};
