import type { PublicationInfo } from "../api/tauri";
import { publicationMembership } from "./publicationSql";

/**
 * テーブル作成ウィザードで PostgreSQL の表を作った直後に「パブリケーションに追加…」を提案するかの判定 (#2190)。
 * 純関数 + 取得関数の注入にして、条件の組み合わせをテストで固定する。
 */

/** 新しい表を明示的に追加できる (FOR ALL TABLES でも TABLES IN SCHEMA でもない) パブリケーションがあるか。 */
export function hasAddablePublication(
  publications: readonly PublicationInfo[],
  schema: string,
  table: string,
): boolean {
  return publications.some((p) => publicationMembership(p, schema, table) === "none");
}

/**
 * 提案を出すか。postgres 以外・read_only・UNLOGGED・スキーマ不明・対象なし・取得失敗では false (失敗はエラーにしない)。
 * `list` は `api.listPublications(sessionId)` を渡す。
 */
export async function shouldSuggestPublication(
  opts: { driver: string; readOnly: boolean; schema: string; table: string; unlogged?: boolean },
  list: () => Promise<PublicationInfo[]>,
): Promise<boolean> {
  // UNLOGGED 表は PostgreSQL がパブリケーションへの追加を拒否する。スキーマ不明も提案しない。
  if (opts.driver !== "postgres" || opts.readOnly || opts.unlogged || !opts.schema) return false;
  try {
    return hasAddablePublication(await list(), opts.schema, opts.table);
  } catch {
    return false;
  }
}
