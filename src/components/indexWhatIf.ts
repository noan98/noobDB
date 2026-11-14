import type {
  IndexWhatIfAction,
  IndexWhatIfModeSupport,
  IndexWhatIfRequest,
  IndexWhatIfSupport,
  IndexWhatIfUnavailable,
} from "../api/tauri";
import type { I18nKey } from "../i18n";

/**
 * インデックス試算 (#2326) の純ロジック。可否の判定と強制 (`read_only` の拒否・ロックの確認) は
 * バックエンドが行い、ここは画面の出し分けと依頼の組み立てだけを持つ。
 */

/** 試算できない理由 → 文言キー。 */
export const WHATIF_UNAVAILABLE_KEY: Record<IndexWhatIfUnavailable, I18nKey> = {
  readOnly: "indexWhatIfUnavailableReadOnly",
  needsHypopg: "indexWhatIfUnavailableNeedsHypopg",
  noVirtualIndex: "indexWhatIfUnavailableNoVirtualIndex",
};

/** 試算の種類に対応する可否。 */
export function whatIfModeSupport(
  support: IndexWhatIfSupport | null,
  action: IndexWhatIfAction,
): IndexWhatIfModeSupport | null {
  if (!support) return null;
  return action === "disable" ? support.disable : support.add;
}

/** 追加するインデックスの列の選択をトグルする (選んだ順がキーの順)。 */
export function toggleWhatIfColumn(selected: readonly string[], column: string): string[] {
  return selected.includes(column) ? selected.filter((c) => c !== column) : [...selected, column];
}

export interface WhatIfFormState {
  /** インデックスの対象の表の名前空間。 */
  database: string | null;
  /** SQL 本来の文脈 (タブの DB / スキーマ)。 */
  queryDatabase: string | null;
  table: string;
  sql: string;
  action: IndexWhatIfAction;
  index: string;
  columns: readonly string[];
  /** ロックを取る経路への同意。 */
  confirmed: boolean;
}

/** 実行できるか (対象の指定が揃い、使える方法があり、ロックを取る経路は同意済み)。 */
export function canRunWhatIf(form: WhatIfFormState, mode: IndexWhatIfModeSupport | null): boolean {
  if (!mode || mode.method === null) return false;
  if (form.sql.trim() === "" || form.table === "") return false;
  if (mode.locksTable && !form.confirmed) return false;
  return form.action === "disable" ? form.index !== "" : form.columns.length > 0;
}

/** IPC の依頼を組み立てる。 */
export function buildWhatIfRequest(form: WhatIfFormState, mode: IndexWhatIfModeSupport): IndexWhatIfRequest {
  return {
    database: form.database,
    queryDatabase: form.queryDatabase,
    table: form.table,
    sql: form.sql,
    action: form.action,
    index: form.action === "disable" ? form.index : null,
    columns: form.action === "add" ? [...form.columns] : [],
    confirmLocking: mode.locksTable && form.confirmed,
  };
}
