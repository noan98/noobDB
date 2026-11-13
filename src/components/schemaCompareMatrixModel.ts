import type { DiffStatus, SchemaDiff } from "../api/tauri";

/**
 * 複数 DB のスキーマ比較 (基準 1 つ vs 比較先 複数)。比較そのものは既存の 2 者比較
 * (`compare_schema`) を比較先ごとに呼び、ここでは結果を「テーブル × 比較先」の表へ
 * まとめる純ロジックだけを持つ (描画は `SchemaCompareMatrix.tsx`)。
 */

/** 基準を含めて一度に比べられる DB の数 (基準 1 + 比較先 4)。 */
export const MAX_COMPARE_DATABASES = 5;
/** 比較先 (更新先) として並べられる数。 */
export const MAX_COMPARE_TARGETS = MAX_COMPARE_DATABASES - 1;

/** 表の 1 列ぶん (= 比較先 1 つ) の比較結果。失敗した比較先は `diff` が null で `error` を持つ。 */
export interface MatrixColumnInput {
  diff: SchemaDiff | null;
  error: string | null;
}

/**
 * 1 マスの状態。`absent` は基準にもその比較先にも無いテーブル (他の比較先にだけある)、
 * `error` はその比較先の比較に失敗したことを表す。
 */
export type MatrixCell = DiffStatus | "absent" | "error";

export interface MatrixRow {
  name: string;
  /** 比較先ごとの状態 (列の順は入力どおり)。 */
  cells: MatrixCell[];
  /** どれか 1 つの比較先で差分があるか。 */
  differs: boolean;
  /** 基準とずれている比較先の数 (追加 / 削除 / 変更のどれか)。ドリフト度の分子。 */
  drift: number;
  /** 比較に成功した比較先の数 (失敗した列は含めない)。ドリフト度の分母。 */
  compared: number;
}

export interface CompareMatrix {
  rows: MatrixRow[];
  /** 比較先ごとの、差分のあるテーブル数 (失敗した列は null)。 */
  differingTables: (number | null)[];
}

/** 基準とずれているマスか (追加 / 削除 / 変更)。`same` / `absent` / `error` は数えない。 */
function isDrifting(cell: MatrixCell): boolean {
  return cell !== "same" && cell !== "absent" && cell !== "error";
}

/**
 * 比較先ごとの差分を「テーブル × 比較先」の表へまとめる。行はテーブル名の和集合で、
 * 名前順に並べる。`compare_schema` は基準側の全テーブルを必ず返すので、ある列に行が
 * 無いのは「基準にもその比較先にも無い」(他の比較先にだけある) テーブルで、`absent` になる。
 */
export function buildCompareMatrix(columns: MatrixColumnInput[]): CompareMatrix {
  const names = new Set<string>();
  const byColumn = columns.map((col) => {
    const m = new Map<string, DiffStatus>();
    if (col.diff) {
      for (const tbl of col.diff.tables) {
        m.set(tbl.name, tbl.status);
        names.add(tbl.name);
      }
    }
    return m;
  });
  const rows: MatrixRow[] = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const cells = columns.map(
        (col, i): MatrixCell => (col.diff ? (byColumn[i]?.get(name) ?? "absent") : "error"),
      );
      const drift = cells.filter(isDrifting).length;
      return { name, cells, differs: drift > 0, drift, compared: columns.filter((c) => c.diff).length };
    });
  const differingTables = columns.map((col) =>
    col.diff ? col.diff.tables.filter((tbl) => tbl.status !== "same").length : null,
  );
  return { rows, differingTables };
}

/** 表に出す行。`onlyDiffering` なら差分のある行だけ、`query` は名前の部分一致 (大小無視)。 */
export function filterMatrixRows(rows: MatrixRow[], onlyDiffering: boolean, query: string): MatrixRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (!onlyDiffering || r.differs) && (q === "" || r.name.toLowerCase().includes(q)));
}

/** 列見出しの内訳ストリップ用。追加 / 削除 / 変更のテーブル数 (差分なしは含めない)。 */
export type ColumnBreakdown = Record<"source_only" | "target_only" | "different", number>;

/** 1 つの比較先の差分を、追加 / 削除 / 変更の件数へ集計する。失敗した列 (diff が null) は null。 */
export function columnBreakdown(diff: SchemaDiff | null): ColumnBreakdown | null {
  if (!diff) return null;
  const out: ColumnBreakdown = { source_only: 0, target_only: 0, different: 0 };
  for (const tbl of diff.tables) {
    if (tbl.status !== "same") out[tbl.status] += 1;
  }
  return out;
}

/** 行の並び順。`name` は名前順 (既定)、`drift` はずれている環境が多い順。 */
export type MatrixSort = "name" | "drift";

/**
 * 行を並べ替える (元の配列は変えない)。`drift` はずれている比較先の数の降順で、同数は
 * 名前順。`name` は入力の順 (`buildCompareMatrix` が名前順に並べている) のまま返す。
 */
export function sortMatrixRows(rows: MatrixRow[], sort: MatrixSort): MatrixRow[] {
  if (sort === "name") return rows;
  return [...rows].sort((a, b) => b.drift - a.drift || a.name.localeCompare(b.name));
}
