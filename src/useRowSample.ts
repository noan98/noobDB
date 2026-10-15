import { useEffect, useRef, useState } from "react";
import type { CellValue, Column } from "./api/tauri";

/** 読み取り専用の SELECT を実行して先頭数行を返す関数 (`run_lookup_query` を束ねたもの)。 */
export type SampleRunner = (
  sql: string,
  rowCap: number,
) => Promise<{ columns: readonly Column[]; rows: readonly (readonly CellValue[])[] }>;

export type RowSampleState =
  | { status: "loading" }
  | { status: "ok"; columns: string[]; rows: CellValue[][] }
  | { status: "error"; error: string };

/** 入力の途中で毎回クエリを撃たないための待ち時間 (ミリ秒)。 */
export const ROW_SAMPLE_DEBOUNCE_MS = 500;

/**
 * 変更前に先頭数行を実データで見るための読み取り専用サンプル取得フック (#1626)。
 * `sql` が変わるたびにデバウンスして 1 本だけ発行し、古い応答では上書きしない。`run` が null・
 * `sql` が null・`enabled` が false なら何も実行しない (null を返す)。実行は `run_lookup_query` 経由なので
 * `read_only` セッションでも動き、履歴・結果キャッシュを汚さない。
 */
export function useRowSample(
  run: SampleRunner | null,
  sql: string | null,
  rowCap: number,
  enabled = true,
): RowSampleState | null {
  const [settled, setSettled] = useState<{ sql: string; state: RowSampleState } | null>(null);
  const runRef = useRef(run);
  runRef.current = run;
  const active = enabled && !!run && !!sql;

  useEffect(() => {
    if (!active || !sql) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const r = runRef.current;
      if (!r) return;
      r(sql, rowCap)
        .then((res) => {
          if (cancelled) return;
          setSettled({
            sql,
            state: {
              status: "ok",
              columns: res.columns.map((c) => c.name),
              rows: res.rows.map((row) => [...row]),
            },
          });
        })
        .catch((e) => {
          if (!cancelled) setSettled({ sql, state: { status: "error", error: String(e) } });
        });
    }, ROW_SAMPLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, sql, rowCap]);

  if (!active) return null;
  return settled && settled.sql === sql ? settled.state : { status: "loading" };
}
