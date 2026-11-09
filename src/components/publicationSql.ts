import type { PublicationInfo } from "../api/tauri";
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

/** 実行する文の一覧 (末尾の `;` なし)。選んだ順に並べる。 */
export function buildPublicationStatements(
  schema: string,
  table: string,
  picks: readonly PublicationPick[],
): string[] {
  const q = (s: string) => quoteIdentFor("postgres", s);
  const target = `${q(schema)}.${q(table)}`;
  return picks.map(
    (p) => `ALTER PUBLICATION ${q(p.publication)} ${p.action === "add" ? "ADD" : "DROP"} TABLE ${target}`,
  );
}

/** プレビュー用に 1 つの文字列へ連結する (各文の末尾に `;`)。 */
export function formatPublicationPreview(statements: readonly string[]): string {
  return statements.map((s) => `${s};`).join("\n");
}
