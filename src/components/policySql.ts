import { quoteIdentFor } from "./sqlDialect";

/**
 * PostgreSQL の行レベルセキュリティ (RLS) ポリシー `CREATE POLICY` の組み立て (#2159)。
 * 純関数にして、コマンドごとの句の可否・ロールの引用・名前の検証をテストで固定する。実行は
 * 通常のクエリ経路 (`run_query_transaction`) を通るので、read_only の拒否はバックエンドが行う。
 */

export const POLICY_COMMANDS = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"] as const;
export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

export const POLICY_KINDS = ["PERMISSIVE", "RESTRICTIVE"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** ポリシー名の上限 (NAMEDATALEN - 1 = 63 バイト)。 */
export const POLICY_NAME_MAX_BYTES = 63;

export interface PolicyDraft {
  /** PostgreSQL のスキーマ (ツリーの「データベース」)。 */
  schema: string;
  table: string;
  name: string;
  kind: PolicyKind;
  command: PolicyCommand;
  /** カンマ区切りのロール名。空なら PUBLIC。 */
  roles: string;
  using: string;
  withCheck: string;
  /** 表の RLS を有効にする (`ENABLE ROW LEVEL SECURITY`)。 */
  enableRls: boolean;
  /** 表の所有者にも適用する (`FORCE ROW LEVEL SECURITY`)。RLS が有効な表 (または同時に有効にする表) で使う。 */
  forceRls: boolean;
}

/** `USING` を書けるか。INSERT のポリシーは `WITH CHECK` だけ。 */
export function usingAllowed(command: PolicyCommand): boolean {
  return command !== "INSERT";
}

/** `WITH CHECK` を書けるか。SELECT / DELETE のポリシーは `USING` だけ。 */
export function withCheckAllowed(command: PolicyCommand): boolean {
  return command === "ALL" || command === "INSERT" || command === "UPDATE";
}

export type PolicyNameError = "empty" | "tooLong" | "duplicate";

/** ポリシー名の検証。名前は表ごとに一意なので、重複判定には同じ表の既存名を渡す。 */
export function validatePolicyName(name: string, existingOnTable: readonly string[]): PolicyNameError | null {
  if (name.trim() === "") return "empty";
  if (new TextEncoder().encode(name).length > POLICY_NAME_MAX_BYTES) return "tooLong";
  if (existingOnTable.includes(name)) return "duplicate";
  return null;
}

/** ロールの特殊名。引用せずにそのまま書く (`"public"` と引用すると同名のロールの意味になる)。 */
const SPECIAL_ROLES = new Set(["PUBLIC", "CURRENT_USER", "SESSION_USER", "CURRENT_ROLE"]);

/** カンマ区切りのロール名を分ける (空要素は捨てる)。 */
export function parseRoles(input: string): string[] {
  return input
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== "");
}

function roleSql(role: string): string {
  return SPECIAL_ROLES.has(role.toUpperCase()) ? role.toUpperCase() : quoteIdentFor("postgres", role);
}

/** 式の前後の空白を除き、末尾の `;` を落とす。 */
function cleanExpr(expr: string): string {
  return expr
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

/** `CREATE POLICY` の文 (末尾の `;` なし)。 */
export function buildCreatePolicySql(d: PolicyDraft): string {
  const roles = parseRoles(d.roles);
  const q = (s: string) => quoteIdentFor("postgres", s);
  const parts = [
    `CREATE POLICY ${q(d.name)} ON ${q(d.schema)}.${q(d.table)}`,
    `AS ${d.kind}`,
    `FOR ${d.command}`,
    `TO ${roles.length > 0 ? roles.map(roleSql).join(", ") : "PUBLIC"}`,
  ];
  const using = cleanExpr(d.using);
  if (usingAllowed(d.command) && using !== "") parts.push(`USING (${using})`);
  const check = cleanExpr(d.withCheck);
  if (withCheckAllowed(d.command) && check !== "") parts.push(`WITH CHECK (${check})`);
  return parts.join("\n  ");
}

/**
 * 実行する文の一覧。RLS を有効にする指定があれば、ポリシーの作成より前に `ENABLE`、後に `FORCE` を並べる
 * (1 つのトランザクションで流すので、途中で失敗すれば全部戻る)。
 */
export function buildPolicyStatements(d: PolicyDraft): string[] {
  const table = `${quoteIdentFor("postgres", d.schema)}.${quoteIdentFor("postgres", d.table)}`;
  const out: string[] = [];
  if (d.enableRls) out.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  out.push(buildCreatePolicySql(d));
  if (d.forceRls) out.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  return out;
}

/** プレビュー用に 1 つの文字列へ連結する (各文の末尾に `;`)。 */
export function formatPolicyPreview(statements: readonly string[]): string {
  return statements.map((s) => `${s};`).join("\n");
}
