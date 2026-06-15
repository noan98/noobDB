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
function valuesEqual(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
}

/** 複合 PK でも曖昧にならない安定キー。JSON 配列で join する。 */
function pkKey(row: CellValue[], pkIndices: number[]): string {
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
  const changedCells = next.map(() => new Array<boolean>(colCount).fill(false));
  // PK が無ければペアリング不能 — 差分を出さない。
  if (pkIndices.length === 0) {
    return { changedCells, addedRows: new Set(), removedCount: 0, hasChanges: false };
  }

  // 前回行を PK → 行位置で索引する。重複 PK は通常起きないが、起きても後勝ちで
  // 安全側に倒す (誤検出を避ける方向)。
  const prevByPk = new Map<string, number>();
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
    for (let c = 0; c < colCount; c++) {
      if (!valuesEqual(prevRow[c], row[c])) {
        changedCells[ni][c] = true;
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
