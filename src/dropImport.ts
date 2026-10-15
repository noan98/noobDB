// ウィンドウへドロップされた CSV / TSV の取り込み先の決め方 (#1623)。
//
// アクティブなテーブルタブがあればそのテーブルへ取り込む (従来どおり)。テーブルタブでなくても
// アクティブなタブのデータベースが決まっていれば、そのデータベースへ新規テーブルを作って
// 取り込む (ImportModal の作成モード, #985)。データベースが曖昧なときだけ取り込まない。

/** 取り込み先の決定に使うタブの最小形。 */
export interface DropTargetTab {
  kind: string;
  database?: string | null;
  table?: string | null;
}

export type CsvDropTarget =
  | { kind: "table"; database: string; table: string }
  | { kind: "newTable"; database: string }
  | { kind: "none" };

export function resolveCsvDropTarget(
  connected: boolean,
  tab: DropTargetTab | null | undefined,
): CsvDropTarget {
  if (!connected || !tab) return { kind: "none" };
  const database = tab.database ?? "";
  if (tab.kind === "table" && database && tab.table) {
    return { kind: "table", database, table: tab.table };
  }
  if (database) return { kind: "newTable", database };
  return { kind: "none" };
}
