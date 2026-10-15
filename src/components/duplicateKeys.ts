import type { CellValue, ResultDuplicateKeys } from "../api/tauri";

/**
 * 結果の重複キー検出 (#1628)。指定した列の組み合わせで同じ値を持つ行のグループ数・行数と
 * 上位グループ、重複行のインデックスを返す。バックエンドの結果ハンドル
 * (`db/result_ops.rs::duplicate_keys`) と同じ意味論で、ハンドルが無い結果 (小さい結果・
 * 編集後・load-more 後など) のフォールバックに使う。共有ゴールデン
 * (`fixtures/resultOpsVectors.json` の `duplicateKeys`) で両実装を突き合わせている。
 *
 * - 値は文字列表現で比べる (数値 1 と "1" は同一視。`columnStats` と同じ)。
 * - キー列のどれかが NULL の行は対象外 (UNIQUE 制約と同じく NULL は互いに別物)。
 */

/** `rowIndices` に載せる行数の上限 (バックエンドの `DUPLICATE_INDEX_LIMIT` と同じ)。 */
export const DUPLICATE_INDEX_LIMIT = 100_000;
/** 上位グループの件数の上限 (バックエンドの `DUPLICATE_TOP_MAX` と同じ)。 */
export const DUPLICATE_TOP_MAX = 100;

function isNullish(v: CellValue | undefined): v is null | undefined {
  return v === null || v === undefined;
}

/** キー列を「長さ:値」で連結した 1 本の文字列にする。NULL を含むなら null。 */
function keyOf(row: CellValue[], cols: readonly number[]): string | null {
  let key = "";
  for (const c of cols) {
    const v = row[c];
    if (isNullish(v)) return null;
    const s = String(v);
    // 長さは UTF-8 バイト数ではなく文字列長でよい (区切りの曖昧さを避けるだけの用途)。
    key += `${s.length}:${s}`;
  }
  return key;
}

export function findDuplicateKeys(
  rows: readonly CellValue[][],
  cols: readonly number[],
  top = 10,
  indexLimit = DUPLICATE_INDEX_LIMIT,
): ResultDuplicateKeys {
  const topN = Math.min(Math.max(1, top), DUPLICATE_TOP_MAX);
  const groups = new Map<string, { count: number; first: number }>();
  let nullKeyRows = 0;
  rows.forEach((row, r) => {
    const k = keyOf(row, cols);
    if (k === null) {
      nullKeyRows++;
      return;
    }
    const g = groups.get(k);
    if (g) g.count++;
    else groups.set(k, { count: 1, first: r });
  });
  const dup = [...groups.values()].filter((g) => g.count >= 2);
  const groupCount = dup.length;
  const duplicateRows = dup.reduce((n, g) => n + g.count, 0);
  dup.sort((a, b) => b.count - a.count || a.first - b.first);
  const topGroups = dup.slice(0, topN).map((g) => ({
    values: cols.map((c) => {
      const v = rows[g.first]?.[c];
      return isNullish(v) ? "" : String(v);
    }),
    count: g.count,
    firstRow: g.first,
  }));
  const rowIndices: number[] = [];
  let indicesTruncated = false;
  if (groupCount > 0) {
    for (let r = 0; r < rows.length; r++) {
      const k = keyOf(rows[r], cols);
      if (k === null || (groups.get(k)?.count ?? 0) < 2) continue;
      if (rowIndices.length < indexLimit) rowIndices.push(r);
      else {
        indicesTruncated = true;
        break;
      }
    }
  }
  return {
    rowCount: rows.length,
    nullKeyRows,
    distinctKeys: groups.size,
    groupCount,
    duplicateRows,
    extraRows: duplicateRows - groupCount,
    top: topGroups,
    rowIndices,
    indicesTruncated,
  };
}
