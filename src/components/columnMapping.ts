/**
 * データ比較の列の対応付け (#2099) の純粋関数。Rust 側 `db/column_mapping.rs` の
 * `unmatched_source_columns` と同じ判定を共有ゴールデン
 * (`src/__tests__/fixtures/columnMappingVectors.json`) で固定する。
 */

/** ソース列名 → ターゲット列名。 */
export type ColumnMapping = Record<string, string>;

/** ASCII だけを小文字化して比べる (Rust の `eq_ignore_ascii_case` と同じ。`toLowerCase` は Unicode 全体を変えるのでずれる)。 */
function eqAscii(a: string, b: string): boolean {
  const lower = (x: string) => x.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return lower(a) === lower(b);
}

/**
 * 対応表がその列を「自分のキーとして」持つか。`constructor` / `toString` のような
 * `Object.prototype` と同名の列を、継承プロパティで割り当て済みと誤判定しないため `in` は使わない。
 */
export function hasMapping(mapping: ColumnMapping, column: string): boolean {
  return Object.prototype.hasOwnProperty.call(mapping, column);
}

/** 列の割り当て先 (未割り当てなら undefined)。継承プロパティは読まない。 */
export function mappedTarget(mapping: ColumnMapping, column: string): string | undefined {
  return hasMapping(mapping, column) ? mapping[column] : undefined;
}

/** 列の割り当てを変えた新しい対応表 (`target` が空なら外す)。`__proto__` も自前のキーとして持てるよう fromEntries で作る。 */
export function withMapping(mapping: ColumnMapping, column: string, target: string): ColumnMapping {
  const rest = Object.entries(mapping).filter(([k]) => k !== column);
  return Object.fromEntries(target === "" ? rest : [...rest, [column, target]]);
}

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
  const same = (a: string, b: string) => (caseInsensitive ? eqAscii(a, b) : a === b);
  return source.filter((s) => !hasMapping(mapping, s) && !target.some((t) => same(t, s)));
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
  const same = (a: string, b: string) => (caseInsensitive ? eqAscii(a, b) : a === b);
  const taken = new Set<string>(Object.values(mapping));
  return target.filter(
    (t) => t === current || (!taken.has(t) && !source.some((s) => !hasMapping(mapping, s) && same(s, t))),
  );
}
