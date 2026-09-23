import type { CellValue, Column } from "../api/tauri";
import { MASK_PLACEHOLDER } from "./columnMask";
import { parseJsonLossless, type JsonNode } from "./jsonTree";

/**
 * 結果パネルの JSON ビュー (#1113 / Epic #1110 Phase 3) の純ロジック。
 *
 * クエリ結果を「行オブジェクトの配列」として `JsonTreeView` (セル値ビューアの
 * ツリー表示、#1026) にそのまま渡せる `JsonNode` へ変換する。文字列化 → 再パースを
 * 経由せず直接ノードを組むので、64bit 整数を文字列で受け取っている値も丸めない。
 *
 * - キーは**列の並び順** (エクスポートの JSON はキーをソートするが、画面上は
 *   グリッドと同じ順で読める方が対応を取りやすい)。
 * - JSON / JSONB 型の列の値は、正しい JSON なら入れ子のノードとして展開する
 *   (文字列のまま出すと中身をツリーで辿れないため)。壊れていれば文字列のまま。
 * - 機微カラムのマスク (#1069) は常に伏せ字にする。JSON ビューには一時 reveal の
 *   導線が無いので、マスク対象の値は画面にも出さない (安全側)。
 * - 巨大な結果で固まらないよう、ノード化する行数に上限を設ける。
 */

/** JSON ビューでノード化する最大行数。これを超える分は省略を明示する。 */
export const RESULT_JSON_ROW_LIMIT = 5000;

export interface ResultJsonOptions {
  /** 列ごとのマスクフラグ (`resolveMaskedColumns` の戻り値)。null ならマスクなし。 */
  maskedCols?: readonly boolean[] | null;
  /** ノード化する最大行数。既定 `RESULT_JSON_ROW_LIMIT`。 */
  limit?: number;
}

export interface ResultJson {
  root: JsonNode;
  /** ノード化した行数。 */
  shown: number;
  /** 結果の総行数。 */
  total: number;
  truncated: boolean;
}

const JSON_TYPE_RE = /json/i;

/** 1 セルを JSON ノードへ。`jsonColumn` なら JSON 文字列を入れ子に展開する。 */
export function cellToJsonNode(value: CellValue, jsonColumn: boolean): JsonNode {
  if (value === null) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "number") {
    // NaN / Infinity は JSON の数値として表せないので文字列で見せる。
    return Number.isFinite(value) ? { kind: "number", raw: String(value) } : { kind: "string", value: String(value) };
  }
  if (jsonColumn) {
    const parsed = parseJsonLossless(value);
    if (parsed) return parsed;
  }
  return { kind: "string", value };
}

export function resultToJson(
  columns: readonly Column[],
  rows: readonly (readonly CellValue[])[],
  opts: ResultJsonOptions = {},
): ResultJson {
  const limit = Math.max(0, opts.limit ?? RESULT_JSON_ROW_LIMIT);
  const shown = Math.min(rows.length, limit);
  const jsonCols = columns.map((c) => JSON_TYPE_RE.test(c.type_name));
  const masked = opts.maskedCols ?? null;
  const items: JsonNode[] = [];
  for (let r = 0; r < shown; r++) {
    const row = rows[r];
    items.push({
      kind: "object",
      entries: columns.map((col, ci) => ({
        key: col.name,
        value: masked?.[ci]
          ? { kind: "string", value: MASK_PLACEHOLDER }
          : cellToJsonNode(row?.[ci] ?? null, jsonCols[ci] ?? false),
      })),
    });
  }
  return {
    root: { kind: "array", items },
    shown,
    total: rows.length,
    truncated: shown < rows.length,
  };
}
