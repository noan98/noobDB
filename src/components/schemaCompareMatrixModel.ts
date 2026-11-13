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
}

export interface CompareMatrix {
  rows: MatrixRow[];
  /** 比較先ごとの、差分のあるテーブル数 (失敗した列は null)。 */
  differingTables: (number | null)[];
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
      return { name, cells, differs: cells.some((c) => c !== "same" && c !== "absent" && c !== "error") };
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
