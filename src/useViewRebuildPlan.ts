import { useEffect, useMemo, useState } from "react";
import { api, type ViewRebuildPlan } from "./api/tauri";

/** 入力の途中で毎回問い合わせないための待ち時間 (ミリ秒)。 */
export const VIEW_REBUILD_DEBOUNCE_MS = 300;

export type ViewRebuildState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; plan: ViewRebuildPlan }
  | { status: "error"; error: string };

/**
 * 型を変える列に依存するビューの作り直し計画を `view_rebuild_plan` で取得するフック (#2268)。
 * 対象列が空・`enabled` が偽なら何もしない。対象列やマテビューの再計算設定が変わったらデバウンスして
 * 取り直し、待っている間に変わった古い応答は捨てる。読み取りのみなので `read_only` 接続でも動く。
 */
export function useViewRebuildPlan(
  sessionId: string,
  database: string,
  table: string,
  columns: readonly string[],
  matviewWithData: boolean,
  enabled = true,
): ViewRebuildState {
  const key = useMemo(
    () => JSON.stringify([sessionId, database, table, columns, matviewWithData]),
    [sessionId, database, table, columns, matviewWithData],
  );
  const [settled, setSettled] = useState<{ key: string; state: ViewRebuildState } | null>(null);
  const active = enabled && columns.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: columns は key が同一なら同じ内容なので key だけを依存にする
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => api.viewRebuildPlan(sessionId, database, table, [...columns], matviewWithData))
        .then((plan) => {
          if (!cancelled) setSettled({ key, state: { status: "ok", plan } });
        })
        .catch((e) => {
          if (!cancelled) setSettled({ key, state: { status: "error", error: String(e) } });
        });
    }, VIEW_REBUILD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, active]);

  if (!active) return { status: "idle" };
  return settled?.key === key ? settled.state : { status: "loading" };
}
