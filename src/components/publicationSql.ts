import type { PublicationInfo, TableReplicaIdentity } from "../api/tauri";
import { quoteIdentFor } from "./sqlDialect";

/**
 * PostgreSQL 論理レプリケーションのパブリケーションへの表の追加 / 除外 (`ALTER PUBLICATION ... ADD / DROP TABLE`)
 * の組み立て (#2181)。純関数にして、表の所属判定と SQL の引用をテストで固定する。実行は
 * 通常のクエリ経路 (`run_query_transaction`) と実行ゲート (`runGuardedDdl`) を通るので、read_only の拒否は
 * バックエンドが行う。
 */

/**
 * 表がパブリケーションに入っているか。
 * - `member`: `FOR TABLE` / `ADD TABLE` で明示的に入っている (外せる)
 * - `all`: `FOR ALL TABLES` で自動で入っている (個別には外せない)
 * - `schema`: `FOR TABLES IN SCHEMA` で表のスキーマごと入っている (個別には外せない)
 * - `none`: 入っていない (追加できる)
 */
export type PublicationMembership = "member" | "all" | "schema" | "none";

export function publicationMembership(
  p: PublicationInfo,
  schema: string,
  table: string,
): PublicationMembership {
  if (p.tables.some((t) => t.schema === schema && t.table === table)) return "member";
  if (p.all_tables) return "all";
  if (p.schemas.includes(schema)) return "schema";
  return "none";
}

export type PublicationAction = "add" | "drop";

/** 所属から、そのパブリケーションに対してできる操作。個別に変えられない (`all` / `schema`) は null。 */
export function publicationActionFor(m: PublicationMembership): PublicationAction | null {
  if (m === "none") return "add";
  if (m === "member") return "drop";
  return null;
}

export interface PublicationPick {
  publication: string;
  action: PublicationAction;
}

/**
 * 実行する文の一覧 (末尾の `;` なし)。選んだ順に並べる。`replicaIdentityFull` を立てると、先頭に
 * `ALTER TABLE ... REPLICA IDENTITY FULL` を足す (主キーの無い表を UPDATE / DELETE を公開するパブリケーションへ入れる前の対処、#2212)。
 */
export function buildPublicationStatements(
  schema: string,
  table: string,
  picks: readonly PublicationPick[],
  opts: { replicaIdentityFull?: boolean } = {},
): string[] {
  const q = (s: string) => quoteIdentFor("postgres", s);
  const target = `${q(schema)}.${q(table)}`;
  const alters = picks.map(
    (p) => `ALTER PUBLICATION ${q(p.publication)} ${p.action === "add" ? "ADD" : "DROP"} TABLE ${target}`,
  );
  return opts.replicaIdentityFull && alters.length > 0
    ? [`ALTER TABLE ${target} REPLICA IDENTITY FULL`, ...alters]
    : alters;
}

/**
 * REPLICA IDENTITY の確認 (#2212)。パブリケーションが `update` / `delete` を公開するとき、表に行を特定する手段
 * (主キー・`FULL`・指定の索引) が無いと、その表への UPDATE / DELETE が
 * `cannot update table "x" because it does not have a replica identity and publishes updates` で失敗する。
 * `relreplident` は `d` (既定: 主キー) / `n` (なし) / `f` (全列) / `i` (指定の索引)。バックエンドが実効値に正規化して返す
 * (索引が DROP 済みの `i` は `n`、遅延可能な主キーは主キー無し、パーティション親は末端の集計)。
 */

/** 公開する操作に UPDATE / DELETE が含まれるか (INSERT / TRUNCATE だけなら REPLICA IDENTITY は要らない)。 */
export function publishesRowChanges(publish: readonly string[]): boolean {
  return publish.includes("update") || publish.includes("delete");
}

/** 表に行を特定する手段が無いか: `n` (NOTHING)、または `d` (既定) で主キーが無い。`f` / `i` と、未知の値は問題なしとみなす。 */
export function lacksReplicaIdentity(info: TableReplicaIdentity): boolean {
  if (info.replica_identity === "n") return true;
  return info.replica_identity === "d" && !info.has_primary_key;
}

/**
 * その表をこのパブリケーションに入れると UPDATE / DELETE が止まるか。`info` が不明 (取得失敗・表が無い) は false
 * (確かめられないものを警告しない)。
 */
export function replicaIdentityBlocksWrites(
  publish: readonly string[],
  info: TableReplicaIdentity | null,
): boolean {
  return info !== null && publishesRowChanges(publish) && lacksReplicaIdentity(info);
}

/** 親表の `ALTER TABLE ... REPLICA IDENTITY FULL` で解消できるか。パーティション親は子へ伝播しないので、パーティションごとの設定が要る。 */
export function replicaIdentityFullApplies(info: TableReplicaIdentity | null): boolean {
  return info !== null && !info.is_partitioned;
}

/** 表の REPLICA IDENTITY の表示キー (`relreplident` → i18n キーの接尾辞)。未知の値は `d` 扱い。 */
export function replicaIdentityKind(
  info: TableReplicaIdentity,
): "default" | "defaultNoPk" | "nothing" | "full" | "index" | "partitioned" {
  if (info.is_partitioned) return "partitioned";
  switch (info.replica_identity) {
    case "n":
      return "nothing";
    case "f":
      return "full";
    case "i":
      return "index";
    default:
      return info.has_primary_key ? "default" : "defaultNoPk";
  }
}

/** プレビュー用に 1 つの文字列へ連結する (各文の末尾に `;`)。 */
export function formatPublicationPreview(statements: readonly string[]): string {
  return statements.map((s) => `${s};`).join("\n");
}
