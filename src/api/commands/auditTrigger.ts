// `src-tauri/src/commands/audit_trigger.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { AuditDdl, AuditOptions, AuditStatus } from "../tauri";

export const auditTriggerCommands = {
  /**
   * 変更履歴 (監査) テーブルと INSERT / UPDATE / DELETE トリガーの DDL を生成する (#2305)。
   * 何も書かない (実行は通常の DDL 経路)。`regenerate` ならトリガーの作り直しだけを返す。
   */
  generateAuditDdl: (
    sessionId: string,
    database: string,
    table: string,
    options: AuditOptions,
    regenerate: boolean,
  ) =>
    invoke<AuditDdl>("generate_audit_ddl", { sessionId, database, table, options, regenerate }).then((r) =>
      parseResponse(schemas.auditDdl, r, "generate_audit_ddl"),
    ),

  /** 表の監査トリガーの有無と、記録中の列と現在の列の差 (再生成が必要か) を返す (#2305)。読み取りのみ。 */
  getAuditStatus: (sessionId: string, database: string, table: string) =>
    invoke<AuditStatus>("get_audit_status", { sessionId, database, table }).then((r) =>
      parseResponse(schemas.auditStatus, r, "get_audit_status"),
    ),
};
