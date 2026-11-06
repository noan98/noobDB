/**
 * データ比較の列の対応付け (#2099) の純粋関数。Rust 側 `db/column_mapping.rs` の
 * `unmatched_source_columns` と同じ判定を共有ゴールデン
 * (`src/__tests__/fixtures/columnMappingVectors.json`) で固定する。
 */

/** ソース列名 → ターゲット列名。 */
export type ColumnMapping = Record<string, string>;

/**
 * 対応表に無く、ターゲットに同名の列も無いソース列 (「手動で割り当てる」候補)。
 * `caseInsensitive` は同名の照合規則 (MySQL / SQLite とクロスドライバは true、PostgreSQL 同士は false)。
 */
export function unmatchedSourceColumns(
  source: readonly string[],
  target: readonly string[],
  mapping: ColumnMapping,
  caseInsensitive: boolean,
): string[] {
  const same = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  return source.filter((s) => !(s in mapping) && !target.some((t) => same(t, s)));
}

/**
 * 割り当て先として選べるターゲット列。同名で対応済みの列と、他のソース列に割り当て済みの列は除く
 * (`current` は自分自身の現在の割り当てで、選択肢に残す)。
 */
export function assignableTargetColumns(
  source: readonly string[],
  target: readonly string[],
  mapping: ColumnMapping,
  caseInsensitive: boolean,
  current: string | undefined,
): string[] {
  const same = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  const taken = new Set<string>(Object.values(mapping));
  return target.filter(
    (t) => t === current || (!taken.has(t) && !source.some((s) => !(s in mapping) && same(s, t))),
  );
}
