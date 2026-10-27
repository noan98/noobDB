import { useEffect, useState } from "react";
import { api, type SqliteRebuildEdit, type SqliteRebuildPlan } from "./api/tauri";

export type SqliteRebuildPlanState =
  /** 再作成が要らない編集 (または無効化中)。 */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; plan: SqliteRebuildPlan }
  | { status: "error"; error: string };

/** 入力の途中で IPC を連打しないための待ち時間 (ミリ秒)。 */
const DEBOUNCE_MS = 250;

/**
 * SQLite の構造エディタの編集内容から、テーブル再作成 SQL を `plan_sqlite_table_rebuild` (#1888) で
 * 組み立てるフック。入力が変わるたびにデバウンスして呼び直す。読み取りのみなので read_only でも動く。
 * `edit` が null (再作成が要らない) なら何も呼ばず `idle` を返す。
 */
export function useSqliteRebuildPlan(
  sessionId: string,
  database: string,
  table: string,
  edit: SqliteRebuildEdit | null,
  enabled: boolean,
): SqliteRebuildPlanState {
  const [settled, setSettled] = useState<{ key: string; state: SqliteRebuildPlanState } | null>(null);
  const active = enabled && edit !== null;
  const key = JSON.stringify([sessionId, database, table, edit]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key が sessionId / database / table / edit を表す
  useEffect(() => {
    if (!active || edit === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .planSqliteTableRebuild(sessionId, database, table, edit)
        .then((plan) => {
          if (!cancelled) setSettled({ key, state: { status: "ok", plan } });
        })
        .catch((e) => {
          if (!cancelled) setSettled({ key, state: { status: "error", error: String(e) } });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, active]);

  if (!active) return { status: "idle" };
  return settled?.key === key ? settled.state : { status: "loading" };
}
