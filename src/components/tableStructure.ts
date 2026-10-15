/**
 * テーブル構造 (Structure) ボトムパネル (#1112) の純ロジック。
 *
 * Database Explorer でテーブルを選んだあと「データ (Data)」と「構造 (Structure)」の
 * どちらへも 1 手で行けるようにするための、構造側の整形。取得は既存の読み取り
 * IPC (`describe_table` / `list_indexes`) だけで、書き込み経路は持たない。
 */

import type { IndexInfo, TableColumnInfo } from "../api/tauri";
import { foreignKeysOf, type ExplorerForeignKey } from "./explorerTree";

/** 構造パネルの対象。ツリー / コマンドパレット / 外部キーの参照先から決まる。 */
export interface StructureTarget {
  database: string;
  table: string;
}

/** 列に付くキーの種別 (表示順もこの順)。 */
export type StructureKeyKind = "pk" | "fk" | "unique";

export interface StructureColumnRow {
  /** 1 始まりの列位置。 */
  position: number;
  name: string;
  dataType: string;
  nullable: boolean;
  /** 既定値。無ければ null (「NULL を既定値に持つ」とは区別しない)。 */
  defaultValue: string | null;
  keys: StructureKeyKind[];
  /** `auto_increment` などドライバ固有の補足。空なら null。 */
  extra: string | null;
  /** 外部キーの参照先 (外部キー列のときだけ)。 */
  foreignKey: ExplorerForeignKey | null;
  /** 列コメント (#1002)。無い / 空白だけなら null。 */
  comment: string | null;
}

/** 列情報を表の行へ整形する。 */
export function structureColumnRows(columns: readonly TableColumnInfo[]): StructureColumnRow[] {
  const fkByColumn = new Map(foreignKeysOf(columns).map((fk) => [fk.column, fk]));
  return columns.map((c, i) => {
    const keys: StructureKeyKind[] = [];
    const key = c.key.toUpperCase();
    if (key === "PRI") keys.push("pk");
    const fk = fkByColumn.get(c.name) ?? null;
    if (fk) keys.push("fk");
    if (key === "UNI") keys.push("unique");
    const extra = c.extra.trim();
    const comment = c.comment?.trim() ?? "";
    return {
      position: i + 1,
      name: c.name,
      dataType: c.data_type,
      nullable: c.nullable,
      defaultValue: c.default,
      keys,
      extra: extra.length > 0 ? extra : null,
      foreignKey: fk,
      comment: comment.length > 0 ? comment : null,
    };
  });
}

/** インデックスの種別 (表示用)。主キー > 一意 > 通常の順で 1 つに決める。 */
export function indexKind(idx: IndexInfo): "primary" | "unique" | "index" {
  if (idx.primary) return "primary";
  if (idx.unique) return "unique";
  return "index";
}

/**
 * インデックスを主キー → 一意 → 通常の順に並べる (同じ種別の中は元の順)。
 * 構造を読むときは「行をどう特定するか」を最初に知りたいので主キーを先頭に置く。
 */
export function sortIndexes(indexes: readonly IndexInfo[]): IndexInfo[] {
  const rank = { primary: 0, unique: 1, index: 2 } as const;
  return indexes
    .map((idx, i) => ({ idx, i }))
    .sort((a, b) => rank[indexKind(a.idx)] - rank[indexKind(b.idx)] || a.i - b.i)
    .map(({ idx }) => idx);
}

/** 対象の表示名 (`db.table`。SQLite はデータベースを省く)。 */
export function structureTargetLabel(driver: string, target: StructureTarget): string {
  return driver === "sqlite" || !target.database ? target.table : `${target.database}.${target.table}`;
}

/** 被参照 (逆方向) の外部キー 1 件を表の行にしたもの (#1628)。 */
export interface StructureIncomingRow {
  /** 外部キーを持つ参照元 (子) テーブル。 */
  table: string;
  /** 参照元の列。 */
  column: string;
  /** このテーブル側の参照されている列。 */
  referencedColumn: string;
}

/**
 * `incoming_foreign_keys` の結果を、参照元テーブル → 参照元の列の順に並べる (#1628)。
 * 自己参照 (参照元がこのテーブル自身) も含めて返す — 影響範囲の確認では見えるべきなので。
 * 同じ組が重複して返っても 1 行にまとめる。
 */
export function structureIncomingRows(incoming: readonly StructureIncomingRow[]): StructureIncomingRow[] {
  const seen = new Set<string>();
  const out: StructureIncomingRow[] = [];
  for (const fk of incoming) {
    const key = JSON.stringify([fk.table, fk.column, fk.referencedColumn]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ table: fk.table, column: fk.column, referencedColumn: fk.referencedColumn });
  }
  return out.sort(
    (a, b) =>
      a.table.localeCompare(b.table) ||
      a.column.localeCompare(b.column) ||
      a.referencedColumn.localeCompare(b.referencedColumn),
  );
}
