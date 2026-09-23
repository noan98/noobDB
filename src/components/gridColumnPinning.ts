import type { ColumnPinningPosition, ColumnPinningState } from "@tanstack/react-table";

/**
 * 結果グリッドの列ピン留め状態と @tanstack/react-table v9 の論理ピン留めの橋渡し (#1115)。
 *
 * v9 はピン留めを物理方向 (`left` / `right`) から論理方向 (`start` / `end`) へ
 * 改名した。一方で noobDB は列レイアウトを結果シェイプ単位で `{ left, right }` の
 * 形のまま localStorage へ永続化している (#616)。保存済みのレイアウトを壊さない
 * よう、永続化・UI (ヘッダーメニューの左/右ピン、`is-pinned-left` クラス、sticky の
 * `left` / `right` オフセット) は従来どおり物理方向で持ち、react-table と受け渡す
 * 境界だけでこのモジュールを使って相互変換する。
 *
 * noobDB の UI は LTR 固定なので `start` = 左、`end` = 右 の固定対応で良い。
 */

/** 永続化・UI 側で使う物理方向のピン留め状態。 */
export interface PhysicalColumnPinning {
  left: string[];
  right: string[];
}

/** 永続化・UI 側で使う物理方向のピン位置 (`false` = ピン留めなし)。 */
export type PhysicalPinSide = false | "left" | "right";

/** 物理方向の状態 → react-table に渡す論理方向の状態。 */
export function toTablePinning(p: PhysicalColumnPinning): ColumnPinningState {
  return { start: p.left, end: p.right };
}

/**
 * react-table から返ってきた論理方向の状態 → 物理方向の状態。
 * 片側が欠けた部分的な値 (`resetColumnPinning` 等) も空配列で補う。
 */
export function fromTablePinning(p: Partial<ColumnPinningState> | undefined): PhysicalColumnPinning {
  return { left: p?.start ?? [], right: p?.end ?? [] };
}

/** `column.getIsPinned()` の論理位置 → 物理方向のピン位置。 */
export function pinSideFromTable(pos: ColumnPinningPosition): PhysicalPinSide {
  if (pos === "start") return "left";
  if (pos === "end") return "right";
  return false;
}

/** 物理方向のピン位置 → `column.pin()` に渡す論理位置。 */
export function tablePinPosition(side: PhysicalPinSide): ColumnPinningPosition {
  if (side === "left") return "start";
  if (side === "right") return "end";
  return false;
}
