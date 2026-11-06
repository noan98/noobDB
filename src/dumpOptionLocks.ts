import type { DumpOptions, DriverKind } from "./api/tauri";
import type { I18nKey } from "./i18n";

/**
 * ダンプ画面で「生成エンジン / 出力形式のせいで効かないオプション」を決める純関数群 (#2094)。
 *
 * 画面ではロックされたスイッチを消さずに無効 + 理由つきで残し、実行時には**同じ判定**で値を
 * 上書きして送る (`resolveDumpOptions`)。判定を 1 か所に置くことで「画面の表示」と「バックエンドに
 * 渡る値」がズレない。
 */

export type DumpBoolOptionKey = {
  [K in keyof DumpOptions]-?: DumpOptions[K] extends boolean | undefined ? K : never;
}[keyof DumpOptions];

/** ネイティブ生成 (#2033) では外部ツールの引数に相当し、効かなくなるスイッチ。 */
const EXTERNAL_TOOL_ONLY_OPTIONS: readonly DumpBoolOptionKey[] = [
  "singleTransaction",
  "noTablespaces",
  "setGtidPurgedOff",
  "noOwner",
  "noPrivileges",
  "completeInsert",
];

/** SQLite スナップショット (#1624) は SQL を生成しないので、SQL 形式向けのスイッチは効かない。 */
const SNAPSHOT_IGNORED_OPTIONS: readonly DumpBoolOptionKey[] = [
  "addDropTable",
  "noData",
  "noCreateInfo",
  "formatSql",
];

/** ロックの判定に使う文脈。 */
export interface DumpLockContext {
  driver: DriverKind;
  /** ネイティブ生成を選んでいるか (SQLite は常にネイティブなのでここでは見ない)。 */
  native: boolean;
  sqliteSnapshot: boolean;
}

export interface DumpOptionLock {
  /** 無効の理由 (バッジの Tooltip と行の説明に出す)。 */
  reason: I18nKey;
  /** ロック中に画面へ表示し、実行時に送る値。 */
  forced: boolean;
}

export function dumpOptionLock(key: DumpBoolOptionKey, ctx: DumpLockContext): DumpOptionLock | null {
  if (ctx.sqliteSnapshot && SNAPSHOT_IGNORED_OPTIONS.includes(key)) {
    return { reason: "dumpLockSnapshot", forced: false };
  }
  const native = ctx.driver !== "sqlite" && ctx.native;
  if (native && EXTERNAL_TOOL_ONLY_OPTIONS.includes(key)) {
    return {
      reason: key === "singleTransaction" ? "dumpLockNativeConsistency" : "dumpLockNative",
      forced: false,
    };
  }
  // pg_dump は関数を常に出力する (ネイティブ生成のときだけ選べる)。
  if (ctx.driver === "postgres" && !native && key === "routines") {
    return { reason: "dumpLockPgDumpRoutines", forced: true };
  }
  return null;
}

const LOCKABLE_KEYS: readonly DumpBoolOptionKey[] = [
  ...new Set<DumpBoolOptionKey>([...EXTERNAL_TOOL_ONLY_OPTIONS, ...SNAPSHOT_IGNORED_OPTIONS, "routines"]),
];

/** ロックされたオプションを強制値に置き換えた、バックエンドへ送る値を返す (表示と実行の一致)。 */
export function resolveDumpOptions(options: DumpOptions, ctx: DumpLockContext): DumpOptions {
  const next: DumpOptions = { ...options };
  for (const key of LOCKABLE_KEYS) {
    const lock = dumpOptionLock(key, ctx);
    if (lock) next[key] = lock.forced;
  }
  return next;
}
