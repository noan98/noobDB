// 破壊的操作の前の退避コピー (#2448) の実行。メタデータを集め (`tableClone.ts` と同じ読み取り)、
// `backupBeforeDestructive.ts` が組み立てた文を既存の書き込み経路 `run_query_transaction` で流す。
// 失敗したら例外を投げる (呼び出し側は本操作を実行しない)。新しい IPC は増やさない。

import type { api as Api } from "./api/tauri";
import { buildBackupPlan, type BackupKind } from "./backupBeforeDestructive";
import {
  buildPgColumnFlagsSql,
  insertableColumns,
  isPartialCloneFailure,
  parsePgColumnFlags,
  type PgColumnFlags,
} from "./tableClone";

export type BackupApi = Pick<
  typeof Api,
  "getObjectDefinition" | "describeTable" | "runLookupQuery" | "listTables" | "runQueryTransaction"
>;

export interface BackupResult {
  /** 作った退避テーブルの名前。 */
  backupName: string;
  /** 本操作のあとに戻すための SQL。 */
  restoreSql: string;
}

export interface BackupRequest {
  sessionId: string;
  driver: string;
  database: string;
  table: string;
  kind: BackupKind;
  now?: Date;
}

/**
 * 退避コピーを作る。対象テーブルが存在しなければ (`DROP TABLE IF EXISTS` など) 何も作らず null。
 * 失敗は例外 (MySQL は DDL が暗黙コミットなので、途中で失敗すると空の退避テーブルが残りうる。その旨をメッセージに含める)。
 */
export async function runBackup(api: BackupApi, req: BackupRequest): Promise<BackupResult | null> {
  const { sessionId, driver, database, table } = req;
  const existing = await api.listTables(sessionId, database);
  const want = driver === "postgres" ? table : table.toLowerCase();
  if (!existing.some((t) => (driver === "postgres" ? t : t.toLowerCase()) === want)) return null;

  const ddl = await api.getObjectDefinition(sessionId, database, "table", table);
  const cols = await api.describeTable(sessionId, database, table);
  let pgColumns: PgColumnFlags | null = null;
  let generated: string[] = [];
  if (driver === "postgres") {
    const flags = await api.runLookupQuery({
      sessionId,
      sql: buildPgColumnFlagsSql(database, table),
      database,
    });
    pgColumns = parsePgColumnFlags(flags.rows as unknown[][]);
    generated = pgColumns.generated;
  }
  const plan = buildBackupPlan({
    driver,
    database,
    table,
    kind: req.kind,
    now: req.now ?? new Date(),
    existingTables: existing,
    ddl,
    columns: insertableColumns(driver, cols, generated),
    pgColumns,
  });
  if (plan.statements.length === 0 || plan.errors.length > 0) {
    throw new Error(
      `cannot build a backup copy of ${table}${plan.errors.length ? `: ${plan.errors.join(" / ")}` : ""}`,
    );
  }
  try {
    await api.runQueryTransaction(sessionId, plan.statements, database);
  } catch (e) {
    let partial = false;
    try {
      partial = isPartialCloneFailure(
        driver,
        plan.statements.length,
        await api.listTables(sessionId, database),
        plan.backupName,
      );
    } catch {
      // 一覧が取れなければ残骸の有無は不明のまま (本来のエラーだけを返す)
    }
    throw new Error(
      partial ? `${String(e)} (partial backup table "${plan.backupName}" may remain)` : String(e),
    );
  }
  return { backupName: plan.backupName, restoreSql: plan.restoreSql };
}
