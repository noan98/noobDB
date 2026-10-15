// AI の修正案 SQL を、失敗した元の SQL と並べた差分で確認するための純ロジック (#1620)。
// マスクして送ったときは AI の提案中のリテラルが空になっているので、そのまま元の SQL と
// 比べると「値が消えた」差分だらけになる。リライトの提案 (`AiSqlPanel`) と同じく、個数と
// 並びが合うときだけ元の値を差し戻してから比べる。

import {
  diffLines,
  hasDiffChanges,
  restoreMaskedLiterals,
  type DiffLine,
  type RestoredLiterals,
} from "./sqlAssist";

export interface FixDiff {
  /** 差し戻し後の修正案。「エディタに反映」で入れるのもこの SQL (見ている差分と同じ)。 */
  sql: string;
  /** リテラルの差し戻し結果。`missing` なら空のリテラルが残っている (注意書きを出す)。 */
  restore: RestoredLiterals["status"];
  lines: DiffLine[];
  /** 元の SQL と 1 行でも違うか。 */
  changed: boolean;
}

export function buildFixDiff(original: string, suggested: string, masked: boolean): FixDiff {
  const restored: RestoredLiterals = masked
    ? restoreMaskedLiterals(original, suggested)
    : { sql: suggested, status: "none" };
  const lines = diffLines(original, restored.sql);
  return { sql: restored.sql, restore: restored.status, lines, changed: hasDiffChanges(lines) };
}
