import type { SqliteMaintenanceResult } from "../api/tauri";

/**
 * SQLite メンテナンス (#1625) の表示用の純ロジック。
 *
 * 空きページ (`freelist_count`) がファイル全体 (`page_count`) の一定割合を超えたら、
 * VACUUM でファイルを縮められる目安として知らせる。小さな DB では誤検知になるので、
 * 最低ページ数も要求する。
 */

/** 空きページ率がこれ以上なら VACUUM を勧める。 */
export const VACUUM_HINT_RATIO = 0.2;
/** これ未満のページ数の DB では勧めない (数 MB 以下では縮めても意味が薄い)。 */
export const VACUUM_HINT_MIN_PAGES = 100;

/** 空きページ率 (0〜1)。取得できていない / 0 ページのときは `null`。 */
export function freelistRatio(
  result: Pick<SqliteMaintenanceResult, "page_count" | "freelist_count">,
): number | null {
  const { page_count: pages, freelist_count: free } = result;
  if (pages == null || free == null || pages <= 0) return null;
  return free / pages;
}

/** VACUUM を検討すべきか。 */
export function shouldSuggestVacuum(
  result: Pick<SqliteMaintenanceResult, "page_count" | "freelist_count">,
): boolean {
  const ratio = freelistRatio(result);
  return ratio !== null && (result.page_count ?? 0) >= VACUUM_HINT_MIN_PAGES && ratio >= VACUUM_HINT_RATIO;
}

/** 参照整合性違反を親子の表の組ごとに数える (表示順は件数の多い順)。 */
export function groupFkViolations(
  violations: SqliteMaintenanceResult["fk_violations"],
): Array<{ table: string; parent: string; count: number }> {
  const map = new Map<string, { table: string; parent: string; count: number }>();
  for (const v of violations) {
    const key = `${v.table}\u0000${v.parent}`;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { table: v.table, parent: v.parent, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.table.localeCompare(b.table));
}
