import type { I18nKey } from "../i18n";
import { isSqliteMainDatabase } from "./sqlDialect";

/**
 * SQLite のアタッチ DB (`main` 以外) の表に対して、バックエンドが拒否する操作 (#2154)。
 *
 * Rust の `Connection::reject_if_attached_sqlite` の `what` と 1 対 1 で対応する
 * (`rebuildTable` = "table rebuild" / `syncApply` = "sync apply" /
 * `transferCreateReplace` = "data transfer (create / replace)")。追記 / upsert の転送は
 * 修飾した INSERT で動くので、ここには含めない。集合の一致は `sqliteAttachSupport.test.ts` が
 * Rust のソースを読んで固定する。
 */
export type AttachedRejectedOperation = "rebuildTable" | "syncApply" | "transferCreateReplace";

/** 操作 → バックエンドの `what` 文言 (パリティテスト用)。 */
export const ATTACHED_REJECTED_OPERATIONS: Record<AttachedRejectedOperation, string> = {
  rebuildTable: "table rebuild",
  syncApply: "sync apply",
  transferCreateReplace: "data transfer (create / replace)",
};

const REASON_KEYS: Record<AttachedRejectedOperation, I18nKey> = {
  rebuildTable: "attachedUnsupportedRebuild",
  syncApply: "schemaCompareApplyAttachedUnsupported",
  transferCreateReplace: "attachedUnsupportedTransfer",
};

/** `database` が SQLite のアタッチ別名 (`main` / 空以外) か。MySQL / PostgreSQL は常に false。 */
export function isSqliteAttachedDatabase(
  driver: string | null | undefined,
  database: string | null | undefined,
) {
  return driver === "sqlite" && !isSqliteMainDatabase(database);
}

/**
 * `operation` が (driver, database) で使えないときに理由の翻訳キーを返す。使えるなら null。
 * 判定はバックエンドの `reject_if_attached_sqlite` と一致させる。
 */
export function attachedUnsupportedReason(
  driver: string | null | undefined,
  database: string | null | undefined,
  operation: AttachedRejectedOperation,
): I18nKey | null {
  return isSqliteAttachedDatabase(driver, database) ? REASON_KEYS[operation] : null;
}
