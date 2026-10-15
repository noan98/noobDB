// 明示トランザクション開始オプション (分離レベル / READ ONLY, #1166) の純ロジック。
// バックエンド (`db/tx_options.rs`) の TxIsolation と同じ kebab-case 語彙。

export type TxIsolation = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";

export const TX_ISOLATION_LEVELS: readonly TxIsolation[] = [
  "read-committed",
  "repeatable-read",
  "serializable",
  "read-uncommitted",
];

/** ListboxSelect の「サーバ既定」を表す値 (空文字)。 */
export const TX_ISOLATION_DEFAULT = "";

/** 分離レベルを指定できるドライバか (SQLite は分離レベルを持たないので選択を無効にする)。 */
export function supportsTxOptions(driver: string | null | undefined): boolean {
  return driver === "mysql" || driver === "postgres";
}

/**
 * READ ONLY で開始できるドライバか。MySQL / PostgreSQL はサーバの READ ONLY トランザクション、
 * SQLite は BEGIN 中だけ `PRAGMA query_only = ON` で実現する (#1626) ので、3 ドライバとも対応。
 */
export function supportsTxReadOnly(driver: string | null | undefined): boolean {
  return driver === "mysql" || driver === "postgres" || driver === "sqlite";
}

/** PostgreSQL は READ UNCOMMITTED を READ COMMITTED と同じに扱う。 */
export function isolationIsAliasedOn(driver: string | null | undefined, level: TxIsolation): boolean {
  return driver === "postgres" && level === "read-uncommitted";
}

/** UI の選択値を IPC 引数へ。非対応のオプションは既定 (未指定) に落とす。 */
export function resolveTxOptions(
  driver: string | null | undefined,
  isolationValue: string,
  readOnly: boolean,
): { isolation: TxIsolation | null; readOnly: boolean } {
  const isolation =
    supportsTxOptions(driver) && (TX_ISOLATION_LEVELS as readonly string[]).includes(isolationValue)
      ? (isolationValue as TxIsolation)
      : null;
  return { isolation, readOnly: supportsTxReadOnly(driver) && readOnly };
}
