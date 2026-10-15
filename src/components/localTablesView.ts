import type { LocalTableMeta } from "../api/tauri";

/**
 * ローカルテーブル一覧 (`LocalTablesPanel`) の絞り込みと並べ替え (#1627)。表示だけに効き、
 * 登録済みのテーブルは変えない。
 */

/** 並べ替えの種類。`registered` は登録順 (バックエンドが返した順) のまま。 */
export type LocalTableSort = "registered" | "name" | "rows" | "fetched";

export const LOCAL_TABLE_SORTS: readonly LocalTableSort[] = ["registered", "name", "rows", "fetched"];

/** `<select>` の値を並べ替えの種類へ。未知の値は `registered`。 */
export function parseLocalTableSort(value: string): LocalTableSort {
  return LOCAL_TABLE_SORTS.find((s) => s === value) ?? "registered";
}

/**
 * テーブル名の部分一致 (大文字小文字を区別しない、空白だけは無視) で絞り込み、`sort` で並べ替える。
 * 行数は多い順、取得日時は新しい順、名前は昇順。同値のときは登録順を保つ。
 */
export function viewLocalTables(
  tables: readonly LocalTableMeta[],
  query: string,
  sort: LocalTableSort,
): LocalTableMeta[] {
  const q = query.trim().toLowerCase();
  const filtered = q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : [...tables];
  if (sort === "registered") return filtered;
  const indexed = filtered.map((t, i) => ({ t, i }));
  indexed.sort((a, b) => {
    let d = 0;
    if (sort === "name")
      d = a.t.name.localeCompare(b.t.name, undefined, { numeric: true, sensitivity: "base" });
    else if (sort === "rows") d = b.t.row_count - a.t.row_count;
    else d = b.t.fetched_at_ms - a.t.fetched_at_ms;
    return d !== 0 ? d : a.i - b.i;
  });
  return indexed.map((x) => x.t);
}
