// 破壊的操作の前の退避コピー (#2448) の実行。メタデータを集め (`tableClone.ts` と同じ読み取り)、
// `backupBeforeDestructive.ts` が組み立てた文を既存の書き込み経路 `run_query_transaction` で流す。
// 失敗したら例外を投げる (呼び出し側は本操作を実行しない)。新しい IPC は増やさない。

import type { api as Api } from "./api/tauri";
import { t as translate } from "./i18n";
import { quoteIdentFor } from "./components/sqlDialect";
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
  /**
   * 表が実在しなくても退避なしで続けてよいか。`DROP TABLE IF EXISTS` のときだけ true にする。
   * false (既定) で表が見つからなければエラー (別の表を退避したり、退避なしで本操作に進んだりしない)。
   */
  missingOk?: boolean;
}

/**
 * 文にスキーマ / データベースが書かれていないときの、本操作が実際に触る場所を特定する。
 *   - MySQL: 現在のデータベース (タブの選択 → 接続の既定)
 *   - PostgreSQL: `to_regclass` で本操作と同じ search_path から実体のスキーマを引く (public 決め打ちにしない)
 *   - SQLite: `main` (タブで別のデータベースを選んでいればそちら) に実在するテーブル
 * 特定できなければ null (呼び出し側は退避オプションを出さない)。
 */
export async function resolveBackupDatabase(
  api: BackupApi,
  req: {
    sessionId: string;
    driver: string;
    table: string;
    /** 文に書かれたスキーマ。あればそのまま返す。 */
    explicit: string | null;
    /** タブで選んでいるデータベース / スキーマ。 */
    tabDatabase: string | null;
    /** 接続の既定のデータベース (MySQL)。 */
    profileDatabase: string | null;
  },
): Promise<string | null> {
  if (req.explicit) return req.explicit;
  const { sessionId, driver, table } = req;
  if (driver === "mysql") return req.tabDatabase ?? req.profileDatabase ?? null;
  if (driver === "postgres") {
    const rel = quoteIdentFor("postgres", table).replace(/'/g, "''");
    const res = await api.runLookupQuery({
      sessionId,
      sql:
        "SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        `WHERE c.oid = to_regclass('${rel}')`,
      database: req.tabDatabase,
    });
    const first = (res.rows as unknown[][])[0]?.[0];
    return typeof first === "string" && first.length > 0 ? first : null;
  }
  for (const db of [req.tabDatabase, "main"]) {
    if (!db) continue;
    const tables = await api.listTables(sessionId, db);
    if (tables.some((t) => t.toLowerCase() === table.toLowerCase())) return db;
  }
  return null;
}

/**
 * 退避コピーを作る。対象テーブルが存在しなければ (`DROP TABLE IF EXISTS` など) 何も作らず null。
 * 失敗は例外 (MySQL は DDL が暗黙コミットなので、途中で失敗すると空の退避テーブルが残りうる。その旨をメッセージに含める)。
 */
export async function runBackup(api: BackupApi, req: BackupRequest): Promise<BackupResult | null> {
  const { sessionId, driver, database, table } = req;
  const existing = await api.listTables(sessionId, database);
  const want = driver === "postgres" ? table : table.toLowerCase();
  // 実在する名前 (MySQL / SQLite は大文字小文字を無視して一致させ、実際の綴りを使う)。
  const actual = existing.find((t) => (driver === "postgres" ? t : t.toLowerCase()) === want);
  if (actual === undefined) {
    if (req.missingOk) return null;
    throw new Error(translate("backupTableMissing", { table }));
  }

  const ddl = await api.getObjectDefinition(sessionId, database, "table", actual);
  const cols = await api.describeTable(sessionId, database, actual);
  let pgColumns: PgColumnFlags | null = null;
  let generated: string[] = [];
  if (driver === "postgres") {
    const flags = await api.runLookupQuery({
      sessionId,
      sql: buildPgColumnFlagsSql(database, actual),
      database,
    });
    pgColumns = parsePgColumnFlags(flags.rows as unknown[][]);
    generated = pgColumns.generated;
  }
  const plan = buildBackupPlan({
    driver,
    database,
    table: actual,
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
