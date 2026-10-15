import type { CellValue } from "./api/tauri";

/**
 * 同一クエリの連続実行における結果差分 (#597)。
 *
 * 同じ SQL を再実行したとき「前回から何が変わったか」を、前回結果スナップショットと
 * 今回結果を**プライマリキーでペアリング**して算出する純ロジック。ドライランプレビュー
 * (`PreviewGrid` の before/after ペアリング) と同じ発想を「同一クエリの再実行」へ
 * 応用したもので、DOM 非依存・副作用なしなので Vitest で値→差分のマッピングを直接
 * 検証する (`__tests__/resultDiff.test.ts`)。
 *
 * ## 保守的な方針
 *
 * - **PK が解決できないときは差分を出さない。** PK なしでは行を安定にペアリングできず、
 *   1 セルでも変われば「削除 + 追加」に化けて誤った赤/緑が出る。受け入れ条件
 *   「PK 不明の場合は差分を出さず通常描画にフォールバック」に従い、`pkIndices` が空なら
 *   変化なしの空差分を返す (呼び出し側は通常描画する)。
 * - クエリ本文が変わった場合のフォールバックは呼び出し側の責務 (前回 SQL と今回 SQL が
 *   一致するときだけ本関数を呼ぶ)。
 */
export interface ResultRowDiff {
  /**
   * `changedCells[rowIdx][colIdx]` が true のとき、今回結果の当該セルが PK ペアの
   * 前回行と異なる。**今回結果の行位置**で添字付けする。前回ペアを持たない行
   * (追加行) は全 false。
   */
  changedCells: boolean[][];
  /** 今回結果で前回ペアを持たない行 (前回以降に追加された行) の行位置集合。 */
  addedRows: Set<number>;
  /**
   * 前回行のうち今回ペアを持たないものの件数 (前回以降に削除された行)。削除行は
   * 今回結果に存在せずグリッドに描けないため、サマリ表示用の件数として返す。
   */
  removedCount: number;
  /** いずれかのセル変化・行追加・行削除があれば true。 */
  hasChanges: boolean;
}

/**
 * 2 つのセル値が「等しい」か。NULL/undefined を同一視し、それ以外は型を跨いで
 * 文字列化して比較する。両スナップショットは同じ列型でデコードされるため、
 * BIGINT/DECIMAL の精度保持で数値が文字列で来るケースや Int(1) vs Bool(true) の
 * 往復を偽の差分にしない (`PreviewGrid` の `valuesEqual` と同方針)。
 */
export function valuesEqual(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
}

/** 単一列 PK は値そのものを Map のキーにする (null は undefined と同一視)。 */
type PkKey = string | number | boolean | null;

/** 複合 PK でも曖昧にならない安定キー。複合のときだけ JSON 配列で join する (#1610)。 */
function pkKey(row: CellValue[], pkIndices: number[]): PkKey {
  if (pkIndices.length === 1) return row[pkIndices[0]] ?? null;
  return JSON.stringify(pkIndices.map((i) => row[i] ?? null));
}

/**
 * 前回結果 `prev` と今回結果 `next` を PK でペアリングし、変化セル・追加行・削除行を
 * 算出する。`colCount` は比較対象の列数 (両結果で同じ前提)。`pkIndices` が空なら
 * 変化なしの空差分を返す (保守的フォールバック)。
 */
export function diffResultRows(
  prev: CellValue[][],
  next: CellValue[][],
  pkIndices: number[],
  colCount: number,
): ResultRowDiff {
  // 変化の無い行は全行で共有する読み取り専用の全 false 配列を使い、変化した行だけ遅延確保する
  // (10 万行 × 20 列でも毎回 200 万要素を確保しない)。
  const noChange = new Array<boolean>(colCount).fill(false);
  const changedCells: boolean[][] = new Array<boolean[]>(next.length).fill(noChange);
  // PK が無ければペアリング不能 — 差分を出さない。
  if (pkIndices.length === 0) {
    return { changedCells, addedRows: new Set(), removedCount: 0, hasChanges: false };
  }

  // 前回行を PK → 行位置で索引する。重複 PK は通常起きないが、起きても後勝ちで
  // 安全側に倒す (誤検出を避ける方向)。
  const prevByPk = new Map<PkKey, number>();
  prev.forEach((row, i) => {
    prevByPk.set(pkKey(row, pkIndices), i);
  });

  const addedRows = new Set<number>();
  const matchedPrev = new Set<number>();
  let anyCellChanged = false;

  next.forEach((row, ni) => {
    const pi = prevByPk.get(pkKey(row, pkIndices));
    if (pi === undefined) {
      addedRows.add(ni);
      return;
    }
    matchedPrev.add(pi);
    const prevRow = prev[pi];
    let flags: boolean[] | null = null;
    for (let c = 0; c < colCount; c++) {
      if (!valuesEqual(prevRow[c], row[c])) {
        if (flags === null) {
          flags = new Array<boolean>(colCount).fill(false);
          changedCells[ni] = flags;
        }
        flags[c] = true;
        anyCellChanged = true;
      }
    }
  });

  let removedCount = 0;
  prev.forEach((_, i) => {
    if (!matchedPrev.has(i)) removedCount++;
  });

  return {
    changedCells,
    addedRows,
    removedCount,
    hasChanges: anyCellChanged || addedRows.size > 0 || removedCount > 0,
  };
}

/**
 * 事前計算済みの差分 (#1257)。自動リフレッシュのパッチ適用 (`refreshPatch.ts`) や
 * ブロードキャスト比較 (バックエンド計算) は、差分を行配列と一緒に作るので、
 * `ResultGrid` が `diffResultRows` で全行を突き合わせ直す必要がない。行配列の
 * 同一性をキーにするため、行が別配列に置き換わる (セル編集の適用など) と自動的に
 * 外れて従来の計算へ戻る。
 */
const precomputedDiffs = new WeakMap<object, ResultRowDiff>();

export function attachRowDiff(rows: CellValue[][], diff: ResultRowDiff): void {
  precomputedDiffs.set(rows, diff);
}

export function rowDiffFor(rows: CellValue[][] | null | undefined): ResultRowDiff | null {
  return rows ? (precomputedDiffs.get(rows) ?? null) : null;
}

/**
 * 前回結果のうち今回結果に PK ペアを持たない行 (= 削除された行) を、前回の並び順で返す
 * (#1628)。グリッドへ「ゴースト行」として描くための元データ。`limit` 件で打ち切る
 * (大量削除でも DOM を膨らませない)。PK が空なら diffResultRows と同じく空配列。
 */
export function removedPrevRows(
  prev: CellValue[][],
  next: CellValue[][],
  pkIndices: number[],
  limit = 200,
): CellValue[][] {
  if (pkIndices.length === 0) return [];
  const nextKeys = new Set<PkKey>();
  for (const row of next) nextKeys.add(pkKey(row, pkIndices));
  const out: CellValue[][] = [];
  for (const row of prev) {
    if (nextKeys.has(pkKey(row, pkIndices))) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 「変化のみ」表示用に、変化したセルを持つ行と追加行の行位置集合を返す (#1628)。
 * 削除行は今回結果に存在しないのでここには含まれない (ゴースト行として別枠で出す)。
 */
export function changedRowIndexSet(diff: ResultRowDiff, rowCount: number): Set<number> {
  const out = new Set<number>(diff.addedRows);
  for (let i = 0; i < rowCount; i++) {
    if (diff.changedCells[i]?.some(Boolean)) out.add(i);
  }
  return out;
}
