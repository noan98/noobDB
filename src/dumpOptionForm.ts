import type { DriverKind, DumpOptions } from "./api/tauri";
import type { I18nKey } from "./i18n";
import type { DumpBoolOptionKey } from "./dumpOptionLocks";

/**
 * ダンプのオプション画面 (DumpModal / タスクスケジューラのダンプ設定, #2131) が共有する定義。
 * 項目の追加はここ 1 か所で済ませ、両方の画面に同時に反映する。
 */

/** 新規ダンプ / 新規タスクの既定値 (両画面で揃える)。 */
export const DEFAULT_DUMP_OPTIONS: DumpOptions = {
  singleTransaction: true,
  routines: false,
  events: false,
  triggers: true,
  addDropTable: true,
  extendedInsert: true,
  completeInsert: false,
  noData: false,
  noCreateInfo: false,
  noOwner: true,
  noPrivileges: false,
  pgSchema: null,
  formatSql: false,
  gzip: false,
  noTablespaces: false,
  setGtidPurgedOff: false,
  writeChecksum: false,
  sqliteSnapshot: false,
  native: false,
};

/** Each toggle maps one checkbox to a boolean `DumpOptions` field and its labels. */
export interface OptionRow {
  key: DumpBoolOptionKey;
  label: I18nKey;
  hint: I18nKey;
}

export const OPTION_ROWS: OptionRow[] = [
  { key: "singleTransaction", label: "dumpOptSingleTransaction", hint: "dumpOptSingleTransactionHint" },
  { key: "routines", label: "dumpOptRoutines", hint: "dumpOptRoutinesHint" },
  { key: "events", label: "dumpOptEvents", hint: "dumpOptEventsHint" },
  { key: "triggers", label: "dumpOptTriggers", hint: "dumpOptTriggersHint" },
  { key: "addDropTable", label: "dumpOptAddDropTable", hint: "dumpOptAddDropTableHint" },
  { key: "extendedInsert", label: "dumpOptExtendedInsert", hint: "dumpOptExtendedInsertHint" },
  { key: "completeInsert", label: "dumpOptCompleteInsert", hint: "dumpOptCompleteInsertHint" },
  { key: "noData", label: "dumpOptNoData", hint: "dumpOptNoDataHint" },
  { key: "noCreateInfo", label: "dumpOptNoCreateInfo", hint: "dumpOptNoCreateInfoHint" },
  { key: "noOwner", label: "dumpOptNoOwner", hint: "dumpOptNoOwnerHint" },
  { key: "noPrivileges", label: "dumpOptNoPrivileges", hint: "dumpOptNoPrivilegesHint" },
  { key: "formatSql", label: "dumpOptFormatSql", hint: "dumpOptFormatSqlHint" },
  { key: "gzip", label: "dumpOptGzip", hint: "dumpOptGzipHint" },
  { key: "noTablespaces", label: "dumpOptNoTablespaces", hint: "dumpOptNoTablespacesHint" },
  { key: "setGtidPurgedOff", label: "dumpOptGtidPurgedOff", hint: "dumpOptGtidPurgedOffHint" },
  { key: "writeChecksum", label: "dumpOptChecksum", hint: "dumpOptChecksumHint" },
  { key: "sqliteSnapshot", label: "dumpOptSqliteSnapshot", hint: "dumpOptSqliteSnapshotHint" },
];

/** オプションを「構造 / データ / 出力 / 互換」に分けて見せる (#2094)。 */
export const OPTION_GROUPS: { id: string; label: I18nKey; keys: DumpBoolOptionKey[] }[] = [
  {
    id: "structure",
    label: "dumpGroupStructure",
    keys: ["routines", "events", "triggers", "addDropTable", "noCreateInfo"],
  },
  {
    id: "data",
    label: "dumpGroupData",
    keys: ["singleTransaction", "extendedInsert", "completeInsert", "noData"],
  },
  { id: "output", label: "dumpGroupOutput", keys: ["formatSql", "gzip", "writeChecksum", "sqliteSnapshot"] },
  {
    id: "compat",
    label: "dumpGroupCompat",
    keys: ["noTablespaces", "setGtidPurgedOff", "noOwner", "noPrivileges"],
  },
];

/** Which toggle keys each driver shows. Omitted fields are sent at their default
 *  but hidden, so the wire shape stays a full `DumpOptions` for every driver. */
export const DRIVER_OPTIONS: Record<DriverKind, DumpBoolOptionKey[]> = {
  mysql: [
    "native",
    "singleTransaction",
    "routines",
    "events",
    "triggers",
    "addDropTable",
    "extendedInsert",
    "completeInsert",
    "noData",
    "noCreateInfo",
    "noTablespaces",
    "setGtidPurgedOff",
    "formatSql",
    "gzip",
    "writeChecksum",
  ],
  postgres: [
    "native",
    "routines",
    "addDropTable",
    "noData",
    "noCreateInfo",
    "noOwner",
    "noPrivileges",
    "formatSql",
    "gzip",
    "writeChecksum",
  ],
  sqlite: ["addDropTable", "noData", "noCreateInfo", "formatSql", "gzip", "writeChecksum", "sqliteSnapshot"],
};

/** 外部クライアントツールを使わずに接続から直接 SQL を生成するドライバ。 */
export const NATIVE_DUMP_DRIVERS: ReadonlySet<DriverKind> = new Set<DriverKind>(["sqlite"]);

/** ドライバ → ダンプに使う外部ツール (SQLite は接続から直接生成するので無し)。 */
export const DUMP_TOOL: Partial<Record<DriverKind, "mysqldump" | "pg_dump">> = {
  mysql: "mysqldump",
  postgres: "pg_dump",
};

/**
 * `DumpOptions` の各キーを、画面でどう扱うかで分類する。`satisfies Record<keyof DumpOptions, …>` で
 * **キーの網羅を型で強制**する: `DumpOptions` に項目を足すと、ここに分類を足すまでビルドが通らない
 * (片方の画面だけに項目が増える回帰を防ぐ, #2131)。
 * - `toggle`: `OPTION_ROWS` のスイッチ (両画面で同じ部品が描く)
 * - `engine`: 生成エンジンのカード選択 (`native`)
 * - `pgSchema`: PostgreSQL のスキーマ入力
 * - `masks`: ネイティブ生成のマスキング (タスク画面のみ。DumpModal は持たない)
 * - `scope`: テーブル指定 (スキーマツリーから渡される DumpModal のみ)
 */
export const DUMP_OPTION_KEY_KINDS = {
  singleTransaction: "toggle",
  routines: "toggle",
  events: "toggle",
  triggers: "toggle",
  addDropTable: "toggle",
  extendedInsert: "toggle",
  completeInsert: "toggle",
  noData: "toggle",
  noCreateInfo: "toggle",
  noOwner: "toggle",
  noPrivileges: "toggle",
  pgSchema: "pgSchema",
  formatSql: "toggle",
  gzip: "toggle",
  tables: "scope",
  noTablespaces: "toggle",
  setGtidPurgedOff: "toggle",
  writeChecksum: "toggle",
  sqliteSnapshot: "toggle",
  native: "engine",
  masks: "masks",
} as const satisfies Record<keyof DumpOptions, "toggle" | "engine" | "pgSchema" | "masks" | "scope">;

/** ドライバ (とテーブル指定の有無) で表示するスイッチ行。表示されない値は黙って持ち込まない。 */
export function visibleOptionRows(
  driver: DriverKind,
  hidden?: ReadonlySet<DumpBoolOptionKey> | null,
): OptionRow[] {
  const allowed = new Set(DRIVER_OPTIONS[driver]);
  return OPTION_ROWS.filter((row) => allowed.has(row.key) && !(hidden && hidden.has(row.key)));
}
