import { isReadOnlySql } from "../dangerousSql";

/**
 * EXPLAIN の「実測モード」(EXPLAIN ANALYZE, #1164) の純ロジック。
 *
 * `ANALYZE` は SQL を**実際に実行する**ため、書き込み SQL で使うと本当に
 * データが変わる。そのため実測モード用の SQL 組み立ては必ずここを通し、
 * 読み取り専用と判定できない SQL は拒否する (フロント側のガード)。バックエンド
 * 側は `run_query_stream` の `forceReadOnly` で同じ判定を強制する (二重の安全網)。
 * 推定 EXPLAIN のプレフィックスは `investigationBundle.ts` の
 * `bundleExplainPrefix` のままで、本モジュールは触らない。
 */

/**
 * 実測モードに対応するドライバ。PostgreSQL と MySQL (8.0.18+)。SQLite の
 * `EXPLAIN QUERY PLAN` には実測値が無いので非対応 (トグルを無効化する)。
 * MySQL のバージョンはここでは判定せず、古いサーバではサーバ側のエラーが
 * そのまま結果タブに出る。
 */
export function explainAnalyzeSupported(driver: string | null | undefined): boolean {
  return driver === "postgres" || driver === "mysql";
}

/** 実測モードの方言別プレフィックス。非対応ドライバは null。 */
export function explainAnalyzePrefix(driver: string | null | undefined): string | null {
  if (driver === "postgres") return "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ";
  if (driver === "mysql") return "EXPLAIN ANALYZE ";
  return null;
}

export type ExplainAnalyzeBuild =
  | { ok: true; sql: string }
  | { ok: false; reason: "unsupported" | "empty" | "notReadOnly" };

/**
 * 実測モードで実行する SQL を組み立てる。非対応ドライバ・空 SQL・読み取り専用と
 * 判定できない SQL (書き込み / DDL / 複数文 / 行ロック付き SELECT など) は
 * `ok: false` を返し、呼び出し側は実行しない。
 */
export function buildExplainAnalyzeSql(
  driver: string | null | undefined,
  sql: string,
): ExplainAnalyzeBuild {
  const prefix = explainAnalyzePrefix(driver);
  if (prefix === null) return { ok: false, reason: "unsupported" };
  if (sql.trim() === "") return { ok: false, reason: "empty" };
  if (!isReadOnlySql(sql, driver ?? undefined)) return { ok: false, reason: "notReadOnly" };
  return { ok: true, sql: `${prefix}${sql}` };
}
