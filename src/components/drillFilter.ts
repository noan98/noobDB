/**
 * ピボットの集計セル・チャートの棒や点から、その組み合わせで絞り込んだグリッドへ移る
 * ための純ロジック (#2236)。
 *
 * 絞り込みの実行・表示は既存の列フィルタ (`gridSortFilter.ts` の `ColumnFilter`) と、
 * 結果グリッドのフィルタ表示がそのまま担う。ここでは
 *
 * 1. 集計キー (行見出し・列見出し・合計・チャートの X ラベル) → 絞り込み条件 (`DrillCondition`)
 * 2. 条件 → `ColumnFilter` (`quickFilter.ts` の `clientQuickFilter` と同じ表現へ寄せる)
 * 3. 現在の列フィルタ状態へ条件を適用 / 取り消す (`applyDrillRequest`)
 * 4. チップに出す要約文
 *
 * だけを持つ。副作用が無いので Vitest でテストする。
 *
 * ## 条件の意味論
 *
 * - NULL キーは `nullMode: "only"` (IS NULL)。表示ラベルの "(null)" と実データの文字列
 *   "(null)" は区別するため、ピボットは `PivotModel.rowKeyValues` / `colKeyValues` の
 *   元の値を使う。
 * - 文字列の等値は**大小区別**。ピボットは `Apple` と `apple` を別の行に分けるので、
 *   大小無視の `equals` で絞ると別グループの行が混ざる。
 * - 空文字・空白だけのキーは、`equals` だと「値のない条件」扱いで絞り込みが効かない
 *   (`isColumnFilterActive`) ため、`in` (完全一致のチェックリスト) で表す。
 */

import type { CellValue, Column } from "../api/tauri";
import type { ColumnFilter } from "./gridSortFilter";
import type { PivotConfig, PivotModel } from "./pivotData";
import { clientQuickFilter } from "./quickFilter";

/** 絞り込み条件 1 件: 列 `colIdx` が `value` に等しい (`null` は NULL)。 */
export interface DrillCondition {
  colIdx: number;
  /** 要約表示用の列名。 */
  column: string;
  /** 元のキー値。NULL は `null`。 */
  value: string | null;
}

/** 絞り込みの出どころ (チップの文言と「戻る」の行き先)。 */
export type DrillSource = "pivot" | "chart";

/**
 * 結果グリッドへ渡す列フィルタ要求。`apply` は他の列フィルタを捨てて条件ぴったりに
 * 置き換え (集計キーと同じ行集合を見せるため)、`clear` は条件の列のフィルタだけ外す。
 */
export interface ColumnFilterRequest {
  mode: "apply" | "clear";
  conditions: DrillCondition[];
}

/** ピボット上のクリック対象。`null` は「その軸では絞らない」。 */
export interface PivotDrillTarget {
  /** 行見出しの添字。合計行・総計では `null`。 */
  row: number | null;
  /** 列見出しの添字。合計列・総計では `null`。 */
  col: number | null;
}

/**
 * ピボットの集計セル / 行見出し / 列見出し / 合計から絞り込み条件を作る。
 *
 * - 本体セル: 行軸 + 列軸 (列軸が無い設定なら行軸だけ)
 * - 行見出し・行の合計: 行軸だけ
 * - 列見出し・列の合計: 列軸だけ
 * - 総計 (両方 `null`) と範囲外の添字: 絞れないので空配列
 */
export function pivotDrillConditions(
  model: Pick<PivotModel, "rowKeyValues" | "colKeyValues">,
  columns: Pick<Column, "name">[],
  config: Pick<PivotConfig, "rowField" | "colField">,
  target: PivotDrillTarget,
): DrillCondition[] {
  const out: DrillCondition[] = [];
  if (target.row !== null) {
    if (target.row < 0 || target.row >= model.rowKeyValues.length) return [];
    out.push({
      colIdx: config.rowField,
      column: columns[config.rowField]?.name ?? `col${config.rowField}`,
      value: model.rowKeyValues[target.row],
    });
  }
  if (target.col !== null && config.colField != null) {
    if (target.col < 0 || target.col >= model.colKeyValues.length) return [];
    out.push({
      colIdx: config.colField,
      column: columns[config.colField]?.name ?? `col${config.colField}`,
      value: model.colKeyValues[target.col],
    });
  }
  return out;
}

/** チャートが NULL の X 値に当てる表示ラベル (`chartData.ts` の `cellLabel` と同じ)。 */
const CHART_NULL_LABEL = "(null)";

/**
 * チャートの X ラベルから絞り込み条件を作る。ラベルは `String(値)` で、NULL は "(null)"
 * になっているため、ラベルが "(null)" で元の行に NULL があるときだけ NULL として扱う
 * (NULL と文字列 "(null)" が両方あると区別できないので NULL を優先する)。
 */
export function chartDrillConditions(
  rows: CellValue[][],
  columns: Pick<Column, "name">[],
  xCol: number,
  label: string | undefined,
): DrillCondition[] {
  if (label === undefined || xCol < 0) return [];
  const asNull = label === CHART_NULL_LABEL && rows.some((r) => r[xCol] === null || r[xCol] === undefined);
  return [{ colIdx: xCol, column: columns[xCol]?.name ?? `col${xCol}`, value: asNull ? null : label }];
}

/**
 * 条件 1 件を `ColumnFilter` へ。数値列は `eq` (数値比較)、それ以外は大小区別の `equals`。
 * 空白だけの値は `in` で完全一致にする (上の「条件の意味論」)。
 */
export function drillColumnFilter(value: string | null, numeric: boolean): ColumnFilter {
  if (value === null) return clientQuickFilter(null, "eq", numeric);
  if (value.trim() === "") {
    return { op: "in", value: "", value2: "", nullMode: "any", values: [value] };
  }
  return clientQuickFilter(value, "eq", numeric, true);
}

/** react-table の `ColumnFiltersState` の 1 要素 (列 id は列の添字を文字列にしたもの)。 */
export interface ColumnFilterEntry {
  id: string;
  value: unknown;
}

/**
 * 列フィルタ要求を現在の状態へ適用した次の状態を返す。`apply` は条件の列だけを残して
 * 置き換え、`clear` は条件の列のフィルタだけ外す (ほかの列のフィルタは触らない)。
 * 同じ列が複数の条件にあれば後勝ち。
 */
export function applyDrillRequest(
  current: readonly ColumnFilterEntry[],
  request: ColumnFilterRequest,
  isNumeric: (colIdx: number) => boolean,
): ColumnFilterEntry[] {
  const ids = new Set(request.conditions.map((c) => String(c.colIdx)));
  if (request.mode === "clear") return current.filter((f) => !ids.has(f.id));
  const byId = new Map<string, ColumnFilterEntry>();
  for (const c of request.conditions) {
    byId.set(String(c.colIdx), {
      id: String(c.colIdx),
      value: drillColumnFilter(c.value, isNumeric(c.colIdx)),
    });
  }
  return [...byId.values()];
}

/** 値の表示 (NULL は `nullLabel`、長い値は省略記号)。 */
function conditionValueText(v: string | null, nullLabel: string, max: number): string {
  if (v === null) return nullLabel;
  const flat = v.replace(/\s+/g, " ");
  if (flat === "") return '""';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** チップ・読み上げ用の要約 (例: `region=東京 × status=paid`)。 */
export function drillSummary(conditions: readonly DrillCondition[], nullLabel = "NULL", max = 24): string {
  return conditions.map((c) => `${c.column}=${conditionValueText(c.value, nullLabel, max)}`).join(" × ");
}
