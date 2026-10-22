import { useEffect, useState } from "react";
import { api } from "./api/tauri";

export type TableRowEstimate =
  | { status: "loading" }
  /** `rows` が null なら統計が概算行数を持たない (SQLite など) か、テーブルが見つからない。 */
  | { status: "ok"; rows: number | null }
  | { status: "error" };

/**
 * テーブルの概算行数を `table_statistics` で 1 回取得するフック (#1771)。ALTER が書き換え / 長いロックを
 * 伴うとき、テーブルの大きさで警告するか決める材料にする。統計は DB 全体を返すので、`enabled` になった
 * ときに 1 度だけ引いて該当テーブルを拾う。失敗しても ALTER 自体は止めない (`error` で警告を出す側に回す)。
 */
export function useTableRowEstimate(
  sessionId: string,
  database: string,
  table: string,
  enabled: boolean,
): TableRowEstimate {
  const [settled, setSettled] = useState<{ key: string; state: TableRowEstimate } | null>(null);
  const key = JSON.stringify([sessionId, database, table]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key が sessionId / database / table を表す
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.tableStatistics(sessionId, database))
      .then((stats) => {
        if (cancelled) return;
        const found = stats.find((s) => s.name === table);
        setSettled({ key, state: { status: "ok", rows: found?.row_estimate ?? null } });
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
