import type { ViewRebuildPlan } from "./api/tauri";
import type { AlterStatement, ExistingColumnBaseline, ExistingColumnEdit } from "./components/alterTable";

/**
 * PostgreSQL の列の型変更で依存ビューを作り直す手順 (#2268, 親 Epic #2261) の、フロント側の純ロジック。
 * ビューの列挙と SQL の組み立ては Rust (`db/view_rebuild.rs`)。ここは「どの列を調べるか」と
 * 「組み立て済みの SQL を ALTER 文の前後へ差し込む」だけを担う。
 */

/** 型を変える既存列 (変更前の列名)。PostgreSQL 以外・削除する列・型が変わらない列は含めない。 */
export function typeChangedColumns(
  driver: string,
  baseline: readonly ExistingColumnBaseline[],
  existing: readonly ExistingColumnEdit[],
): string[] {
  if (driver !== "postgres") return [];
  const out: string[] = [];
  for (const e of existing) {
    if (e.drop) continue;
    const base = baseline.find((b) => b.name === e.original);
    if (!base) continue;
    const next = e.type.trim() || base.type.trim();
    if (next !== base.type.trim()) out.push(e.original);
  }
  return out;
}

/** 作り直しの対象があり、止める依存が無い (= 作り直して適用できる) か。 */
export function canRebuildViews(plan: ViewRebuildPlan | null): boolean {
  return plan !== null && plan.views.length > 0 && plan.blockers.length === 0;
}

/**
 * `statements` (ALTER 一式) の前に依存ビューの DROP を、後ろに CREATE と復元を差し込む。
 * 全体を 1 回の `run_query_transaction` で流すので、途中で失敗すればすべて元に戻る。
 */
export function applyViewRebuild(statements: AlterStatement[], plan: ViewRebuildPlan): AlterStatement[] {
  if (!canRebuildViews(plan)) return statements;
  const wrap = (sql: string, kind: AlterStatement["kind"]): AlterStatement => ({
    sql,
    kind,
    destructive: false,
  });
  return [
    ...plan.drop_statements.map((s) => wrap(s, "dropDependentView")),
    ...statements,
    ...plan.create_statements.map((s) => wrap(s, "recreateDependentView")),
    ...plan.restore_statements.map((s) => wrap(s, "recreateDependentView")),
  ];
}

/** 計画のうちマテリアライズドビュー (再作成で全件を再計算する) だけ。 */
export function materializedViews(plan: ViewRebuildPlan): ViewRebuildPlan["views"] {
  return plan.views.filter((v) => v.kind === "materialized_view");
}
