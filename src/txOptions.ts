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

/** 分離レベル / READ ONLY を指定できるドライバか (SQLite は非対応でトグル無効)。 */
export function supportsTxOptions(driver: string | null | undefined): boolean {
  return driver === "mysql" || driver === "postgres";
}

/** PostgreSQL は READ UNCOMMITTED を READ COMMITTED と同じに扱う。 */
export function isolationIsAliasedOn(driver: string | null | undefined, level: TxIsolation): boolean {
  return driver === "postgres" && level === "read-uncommitted";
}

/** UI の選択値を IPC 引数へ。非対応ドライバでは常に既定 (未指定) に落とす。 */
export function resolveTxOptions(
  driver: string | null | undefined,
  isolationValue: string,
  readOnly: boolean,
): { isolation: TxIsolation | null; readOnly: boolean } {
  if (!supportsTxOptions(driver)) return { isolation: null, readOnly: false };
  const isolation = (TX_ISOLATION_LEVELS as readonly string[]).includes(isolationValue)
    ? (isolationValue as TxIsolation)
    : null;
  return { isolation, readOnly };
}
