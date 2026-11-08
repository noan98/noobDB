import type { I18nKey } from "../i18n";
import type { TaskMaintenanceKind } from "../api/tauri";
import { qualifiedTableName } from "./sqlDialect";
import type { IconName } from "./Icon";

/**
 * 定期メンテナンス (#2025) の純ロジック (#2096)。
 *
 * - `buildTaskMaintenanceStatements` は Rust の `tasks::maintenance::build_statements` の写し。
 *   タスク作成フォームのライブプレビューと保存前の組み合わせ検証の両方がこの 1 つの関数を通るので、
 *   表示と検証がずれない。Rust 側との食い違いは共有ゴールデンベクタ
 *   `fixtures/taskMaintenanceVectors.json` を両側のテストが読んで固定する。
 * - `maintenanceImpact` / `TASK_MAINTENANCE_INFO` は種別カードに出す効果とロックの重さ。
 */

/** `build_statements` のエラー分類。文言は呼び出し側 (i18n) が決める。 */
export type TaskMaintenanceError =
  | "unsupported"
  | "targetsRequiredMysql"
  | "targetsRequiredReindex"
  | "sqliteVacuumTargets"
  | "invalidTargets"
  | "invalidDatabase";

export type TaskMaintenanceBuild = { sql: string[] } | { error: TaskMaintenanceError };

/** 1 タスクの対象テーブル数の上限 (Rust の `MAX_TARGETS`)。 */
export const MAX_MAINTENANCE_TARGETS = 500;

/** ドライバがその種別に対応するか (Rust の `check_supported`)。 */
export function isMaintenanceSupported(driver: string, kind: TaskMaintenanceKind): boolean {
  if (driver === "postgres") return kind !== "optimize";
  if (driver === "sqlite") return kind === "analyze" || kind === "vacuum" || kind === "reindex";
  return kind === "analyze" || kind === "optimize";
}

function validTargets(targets: readonly string[]): boolean {
  if (targets.length > MAX_MAINTENANCE_TARGETS) return false;
  const seen = new Set<string>();
  for (const t of targets) {
    if (t.includes("\0") || t.trim() === "" || t !== t.trim() || seen.has(t)) return false;
    seen.add(t);
  }
  return true;
}

function validDatabase(driver: string, database: string | null): boolean {
  if (database == null) return true;
  if (database.includes("\0")) return false;
  if (driver === "mysql") return !database.includes("`");
  if (driver === "postgres") return !database.includes('"') && !database.includes("\\");
  return true;
}

/**
 * 保守タスクの `database` を正す (Rust の `tasks::maintenance::resolve_database` の写し, #2152)。
 * SQLite はアタッチした別名 (大文字小文字は区別しない) に当たるときだけ**設定の綴りの**別名を返し、
 * それ以外 (MySQL 用に入れた値の持ち越しなど) は `null` (= main、修飾なし)。MySQL / PostgreSQL は
 * 前後の空白を除いた値をそのまま返し、空なら `null`。
 */
export function resolveTaskDatabase(
  driver: string | undefined,
  database: string | null,
  attached: readonly string[],
): string | null {
  const db = database?.trim() ?? "";
  if (db === "") return null;
  if (driver !== "sqlite") return db;
  const lower = db.toLowerCase();
  return attached.find((a) => a.toLowerCase() === lower) ?? null;
}

/**
 * 実行される文を組み立てる。`driver` が不明 (プロファイル未選択) のときは MySQL 扱い
 * (`maintenanceKindsForDriver` と同じ)。
 */
export function buildTaskMaintenanceStatements(
  driverIn: string | undefined,
  database: string | null,
  targets: readonly string[],
  kind: TaskMaintenanceKind,
): TaskMaintenanceBuild {
  const driver = driverIn === "postgres" || driverIn === "sqlite" ? driverIn : "mysql";
  if (!isMaintenanceSupported(driver, kind)) return { error: "unsupported" };
  if (!validTargets(targets)) return { error: "invalidTargets" };
  if (!validDatabase(driver, database)) return { error: "invalidDatabase" };
  if (targets.length === 0) {
    if (driver === "mysql") return { error: "targetsRequiredMysql" };
    if (driver === "postgres" && kind === "reindex") return { error: "targetsRequiredReindex" };
    const sql =
      kind === "analyze"
        ? "ANALYZE;"
        : kind === "vacuum"
          ? "VACUUM;"
          : kind === "vacuum_analyze"
            ? "VACUUM (ANALYZE);"
            : "REINDEX;";
    return { sql: [sql] };
  }
  if (driver === "sqlite" && kind === "vacuum") return { error: "sqliteVacuumTargets" };
  const db = database?.trim() ?? "";
  return {
    sql: targets.map((table) => {
      const name = qualifiedTableName(driver, db, table);
      if (driver === "mysql")
        return kind === "analyze" ? `ANALYZE TABLE ${name};` : `OPTIMIZE TABLE ${name};`;
      if (kind === "analyze") return `ANALYZE ${name};`;
      if (driver === "postgres") {
        if (kind === "vacuum") return `VACUUM ${name};`;
        if (kind === "vacuum_analyze") return `VACUUM (ANALYZE) ${name};`;
        return `REINDEX TABLE ${name};`;
      }
      return `REINDEX ${name};`;
    }),
  };
}

/** 種別 × ドライバのロックの重さ。 */
export interface MaintenanceImpact {
  lock: "light" | "heavy";
  /** 実行中、対象への書き込みを待たせる (ブロックする) か。 */
  blocksWrites: boolean;
  /** 読み取りも待たせる (PostgreSQL の REINDEX は索引に ACCESS EXCLUSIVE、SQLite の VACUUM は排他ロック)。 */
  blocksReads: boolean;
}

export function maintenanceImpact(
  driverIn: string | undefined,
  kind: TaskMaintenanceKind,
): MaintenanceImpact {
  const sqlite = driverIn === "sqlite";
  switch (kind) {
    case "analyze":
      // PostgreSQL は SHARE UPDATE EXCLUSIVE で DML と衝突しない。
      // SQLite はデータベース全体の単一書き込みロック、MySQL の ANALYZE TABLE は解析中に表へ読み取りロック (書き込みは待つ) を取る。
      return { lock: "light", blocksWrites: driverIn !== "postgres", blocksReads: false };
    case "vacuum_analyze":
      return { lock: "light", blocksWrites: false, blocksReads: false };
    case "vacuum":
      // PostgreSQL の VACUUM は書き込みと並行して動く。SQLite はファイル全体を作り直す。
      return sqlite
        ? { lock: "heavy", blocksWrites: true, blocksReads: true }
        : { lock: "light", blocksWrites: false, blocksReads: false };
    case "optimize":
      return { lock: "heavy", blocksWrites: false, blocksReads: false };
    case "reindex":
      // CONCURRENTLY なしの PostgreSQL は表に SHARE・索引に ACCESS EXCLUSIVE でほぼ全クエリが待つ。
      return { lock: "heavy", blocksWrites: true, blocksReads: !sqlite };
  }
}

/** カードに出す効果 (アイコンと 1 行説明の i18n キー)。 */
export const TASK_MAINTENANCE_INFO: Record<TaskMaintenanceKind, { icon: IconName; effectKey: I18nKey }> = {
  analyze: { icon: "chart", effectKey: "taskMaintEffectAnalyze" },
  vacuum_analyze: { icon: "refresh", effectKey: "taskMaintEffectVacuumAnalyze" },
  vacuum: { icon: "trash", effectKey: "taskMaintEffectVacuum" },
  reindex: { icon: "key", effectKey: "taskMaintEffectReindex" },
  optimize: { icon: "tools", effectKey: "taskMaintEffectOptimize" },
};

/** 表示順 (統計 → 領域回収 → 再構築)。 */
export const TASK_MAINTENANCE_ORDER: readonly TaskMaintenanceKind[] = [
  "analyze",
  "vacuum_analyze",
  "vacuum",
  "optimize",
  "reindex",
];

/** 使えない種別の理由 (ドライバ別)。使えるなら null。 */
export function maintenanceUnsupportedReasonKey(
  driverIn: string | undefined,
  kind: TaskMaintenanceKind,
): I18nKey | null {
  const driver = driverIn === "postgres" || driverIn === "sqlite" ? driverIn : "mysql";
  if (isMaintenanceSupported(driver, kind)) return null;
  if (driver === "mysql") return "taskMaintUnsupportedMysql";
  if (kind === "optimize")
    return driver === "postgres" ? "taskMaintUnsupportedPgOptimize" : "taskMaintUnsupportedSqliteOptimize";
  return "taskMaintUnsupportedSqliteVacuumAnalyze";
}

/** ビルドエラー → フォームのエラー文キー。 */
export const TASK_MAINTENANCE_ERROR_KEYS: Record<TaskMaintenanceError, I18nKey> = {
  unsupported: "taskMaintUnsupportedKind",
  targetsRequiredMysql: "taskFormMaintenanceTargetsRequiredMysql",
  targetsRequiredReindex: "taskFormMaintenanceTargetsRequiredReindex",
  sqliteVacuumTargets: "taskFormMaintenanceSqliteVacuumTargets",
  invalidTargets: "taskMaintInvalidTargets",
  invalidDatabase: "taskMaintInvalidDatabase",
};
