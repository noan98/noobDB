import { useEffect, useMemo, useState } from "react";
import { api, type ColumnDependencyReport } from "./api/tauri";

/** 入力 (DROP の切り替え) の途中で毎回問い合わせないための待ち時間 (ミリ秒)。 */
export const COLUMN_DEPS_DEBOUNCE_MS = 300;

export type ColumnDependencyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; report: ColumnDependencyReport }
  | { status: "error"; error: string };

/**
 * DROP COLUMN の対象列を参照する依存オブジェクトを `column_dependencies` で取得するフック (#1758)。
 * 対象列が空・`enabled` が偽なら何もしない。対象列の集合が変わったらデバウンスして取り直し、
 * 待っている間に変わった古い応答は捨てる。読み取りのみなので `read_only` 接続でも動く。
 */
export function useColumnDependencies(
  sessionId: string,
  database: string,
  table: string,
  columns: readonly string[],
  enabled = true,
): ColumnDependencyState {
  const key = useMemo(() => JSON.stringify([sessionId, database, table, columns]), [
    sessionId,
    database,
    table,
    columns,
  ]);
  const [settled, setSettled] = useState<{ key: string; state: ColumnDependencyState } | null>(
    null,
  );
  const active = enabled && columns.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: columns は key が同一なら同じ内容なので key だけを依存にする
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .columnDependencies(sessionId, database, table, [...columns])
        .then((report) => {
          if (!cancelled) setSettled({ key, state: { status: "ok", report } });
        })
        .catch((e) => {
          if (!cancelled) setSettled({ key, state: { status: "error", error: String(e) } });
        });
    }, COLUMN_DEPS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, active]);

  if (!active) return { status: "idle" };
  return settled?.key === key ? settled.state : { status: "loading" };
}
