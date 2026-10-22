import { useEffect, useState } from "react";
import { api } from "./api/tauri";

export type TableRowEstimateState =
  | { status: "loading" }
  /** `rows` が null なら統計が概算行数を持たない (SQLite など) か、テーブルが見つからない。 */
  | { status: "ok"; rows: number | null }
  | { status: "error" };

/**
 * テーブルの概算行数を 1 テーブル用の `table_row_estimate` (#1263) で 1 回取得するフック (#1771)。
 * ALTER が書き換え / 長いロックを伴うとき、テーブルの大きさで警告するか決める材料にする。
 * DB 全体の `table_statistics` は重く、統計ダッシュボードの増減基準 (#1621) も書き換えるので使わない。失敗しても ALTER 自体は止めない (`error` で警告を出す側に回す)。
 */
export function useTableRowEstimate(
  sessionId: string,
  database: string,
  table: string,
  enabled: boolean,
): TableRowEstimateState {
  const [settled, setSettled] = useState<{ key: string; state: TableRowEstimateState } | null>(null);
  const key = JSON.stringify([sessionId, database, table]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key が sessionId / database / table を表す
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.tableRowEstimate(sessionId, database, table))
      .then((n) => {
        if (cancelled) return;
        // 0 は統計が未更新 (MySQL の information_schema_stats_expiry) やパーティション親 (PostgreSQL の
        // n_live_tup=0) でも出るので、信用せず「不明」として警告側に倒す。
        setSettled({ key, state: { status: "ok", rows: n != null && n > 0 ? n : null } });
      })
      .catch(() => {
        if (!cancelled) setSettled({ key, state: { status: "error" } });
      });
    return () => {
      cancelled = true;
    };
  }, [key, enabled]);

  return settled?.key === key ? settled.state : { status: "loading" };
}
