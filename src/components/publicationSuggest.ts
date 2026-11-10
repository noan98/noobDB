import type { PublicationInfo, TableReplicaIdentity } from "../api/tauri";
import { publicationMembership, replicaIdentityBlocksWrites } from "./publicationSql";

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
 * 追加できるパブリケーションのうち、入れると UPDATE / DELETE が止まるもの (主キーの無い表 × update / delete を公開) があるか (#2212)。
 * 提案自体は控えず、トーストに警告を添える判断に使う。
 */
export function hasReplicaIdentityRisk(
  publications: readonly PublicationInfo[],
  schema: string,
  table: string,
  identity: TableReplicaIdentity | null,
): boolean {
  return publications.some(
    (p) =>
      publicationMembership(p, schema, table) === "none" && replicaIdentityBlocksWrites(p.publish, identity),
  );
}

/** 提案の中身。`replicaIdentityRisk` が true なら、追加すると書き込みが止まるパブリケーションがある (#2212)。 */
export interface PublicationSuggestion {
  replicaIdentityRisk: boolean;
}

/**
 * 提案を出すか。postgres 以外・read_only・UNLOGGED・スキーマ不明・対象なし・取得失敗では null (失敗はエラーにしない)。
 * 出すときは、主キーの無い表で書き込みが止まるおそれの有無を添えて返す (#2212、提案自体は控えない)。
 * `list` は `api.listPublications(sessionId)`、`getIdentity` は `api.getTableReplicaIdentity(...)` を渡す
 * (失敗・省略は「不明」で、警告しない)。
 */
export async function shouldSuggestPublication(
  opts: { driver: string; readOnly: boolean; schema: string; table: string; unlogged?: boolean },
  list: () => Promise<PublicationInfo[]>,
  getIdentity?: () => Promise<TableReplicaIdentity | null>,
): Promise<PublicationSuggestion | null> {
  // UNLOGGED 表は PostgreSQL がパブリケーションへの追加を拒否する。スキーマ不明も提案しない。
  if (opts.driver !== "postgres" || opts.readOnly || opts.unlogged || !opts.schema) return null;
  try {
    const publications = await list();
    if (!hasAddablePublication(publications, opts.schema, opts.table)) return null;
    let identity: TableReplicaIdentity | null = null;
    try {
      identity = getIdentity ? await getIdentity() : null;
    } catch {
      identity = null;
    }
    return { replicaIdentityRisk: hasReplicaIdentityRisk(publications, opts.schema, opts.table, identity) };
  } catch {
    return null;
  }
}
