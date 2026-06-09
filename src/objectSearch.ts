// スキーマ横断のグローバルオブジェクト検索 (#473) の純ロジック。
//
// `schema_overview` (DB ごとの TableSchema[]) を検索インデックス化し、テーブル名・
// カラム名を大小無視の部分一致でスコアリングして返す。UI (ObjectSearchModal) と
// データ取得 (App.tsx) はここを使うだけ。副作用が無いので Vitest でテストする。

import type { TableSchema } from "./api/tauri";

/** 検索ヒット 1 件。テーブルそのものか、テーブル内のカラムか。 */
export interface ObjectEntry {
  kind: "table" | "column";
  database: string;
  table: string;
  /** `kind === "column"` のときだけ設定。 */
  column?: string;
}

/** DB 名 → その DB のテーブル一覧から、検索対象エントリの平坦な配列を作る。 */
export function buildObjectIndex(schemasByDb: Record<string, TableSchema[]>): ObjectEntry[] {
  const out: ObjectEntry[] = [];
  for (const [database, tables] of Object.entries(schemasByDb)) {
    for (const tbl of tables) {
      out.push({ kind: "table", database, table: tbl.name });
      for (const col of tbl.columns) {
        out.push({ kind: "column", database, table: tbl.name, column: col });
      }
    }
  }
  return out;
}

/**
 * 1 件のスコアを返す。マッチしなければ 0。完全一致 > 前方一致 > 単語境界 > 部分一致。
 * 同点ならテーブルエントリをカラムエントリより上位にする (table ボーナス +1)。
 */
function scoreEntry(entry: ObjectEntry, q: string): number {
  const target = (entry.kind === "column" ? entry.column ?? "" : entry.table).toLowerCase();
  if (!target) return 0;
  let base = 0;
  if (target === q) base = 100;
  else if (target.startsWith(q)) base = 75;
  else if (new RegExp(`[_\\s.-]${escapeRegex(q)}`).test(target)) base = 50;
  else if (target.includes(q)) base = 25;
  else return 0;
  return base + (entry.kind === "table" ? 1 : 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `query` を大小無視・部分一致で検索し、スコア降順 (同点はテーブル優先) に並べた
 * 上位 `limit` 件を返す。空クエリは空配列。
 */
export function searchObjects(index: ObjectEntry[], query: string, limit = 200): ObjectEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { entry: ObjectEntry; score: number }[] = [];
  for (const entry of index) {
    const score = scoreEntry(entry, q);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 安定した二次キー: DB → テーブル → カラムのアルファベット順。
    const ai = a.entry;
    const bi = b.entry;
    if (ai.database !== bi.database) return ai.database < bi.database ? -1 : 1;
    if (ai.table !== bi.table) return ai.table < bi.table ? -1 : 1;
    return (ai.column ?? "") < (bi.column ?? "") ? -1 : (ai.column ?? "") > (bi.column ?? "") ? 1 : 0;
  });
  return scored.slice(0, limit).map((s) => s.entry);
}
