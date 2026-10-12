import { isRegistrableSuggestionSql } from "./assertionSuggest";
import { parseCountCell, type CountRunner } from "../useCountPreviews";

/**
 * AI が出した SQL を採用前に検証する純ロジック (#1536)。提案 SQL を
 * `SELECT COUNT(*) FROM (<提案SQL>) AS suggestion_check` で読み取り専用に実行すると、
 * 架空の列名・テーブル名・方言違いは実行時エラーとして即座に分かり、行を返す SQL なら件数
 * (データ品質アサーションなら違反件数。0 件で合格) を保存前に確認できる。
 * アサーションの実行方式 (`db::assertions` の `custom_sql`) と同じサブクエリ形式なので 3 ドライバで通る。
 */

/** 検証用の件数 SQL。SELECT / WITH 以外・空文は null (検証しない)。末尾の `;` は落とす。 */
export function buildSuggestionCountSql(sql: string, driver: string): string | null {
  const body = sql.trim().replace(/[;\s]+$/, "");
  if (body === "" || !isRegistrableSuggestionSql(body, driver)) return null;
  return `SELECT COUNT(*) FROM (\n${body}\n) AS suggestion_check`;
}

export type SuggestionCheckResult =
  | { status: "ok"; count: number }
  | { status: "error"; error: string }
  | { status: "skipped" };

/** 件数 SQL を実行して結果を返す。実行できない形 (読み取り専用でない等) は `skipped`。 */
export async function checkSuggestionSql(
  run: CountRunner,
  sql: string,
  driver: string,
): Promise<SuggestionCheckResult> {
  const countSql = buildSuggestionCountSql(sql, driver);
  if (countSql === null) return { status: "skipped" };
  try {
    const res = await run(countSql);
    const count = parseCountCell(res.rows[0]?.[0]);
    return count === null ? { status: "error", error: "unexpected result" } : { status: "ok", count };
  } catch (e) {
    return { status: "error", error: String(e) };
  }
}
