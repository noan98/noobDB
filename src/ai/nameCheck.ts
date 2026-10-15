// AI が作った SQL の表名・列名を、すでに送っているスキーマと照合する純ロジック (#1620)。
// AI を再呼び出しせず、ローカルで「存在しない表 / 列」を実行前に見つける。ベストエフォートで、
// 確実に分かるものだけを指摘する (誤警告を避けるため、判断のつかない構文は黙って見送る):
// - 表名: FROM / JOIN の直後の識別子と、応答の `tables_used`。CTE 名・関数呼び出し・
//   システムカタログ (`information_schema` / `pg_*` / `sqlite_*`)・別データベース修飾は対象外。
// - 列名: `別名.列` / `表名.列` の形で、別名が FROM / JOIN で既知の表に解決できるものだけ。
//   修飾なしの列はサブクエリ・派生表の列と区別できないので見ない。

import { maskLiterals } from "../dangerousSql";

export interface NameCheckTable {
  name: string;
  columns: { name: string }[];
}

export interface NameIssue {
  kind: "table" | "column";
  /** 見つからなかった表名 / 列名。 */
  name: string;
  /** 列の場合の所属表 (スキーマ側の綴り)。 */
  table?: string;
}

/** 別名の位置に来うる予約語 (これを別名と取り違えない)。 */
const NOT_ALIAS = new Set(
  (
    "where on using join inner left right full cross natural outer group order having limit offset union " +
    "intersect except window set values select from for lateral returning fetch straight_join when then " +
    "else end and or not is in as into partition qualify tablesample"
  ).split(" "),
);

const IDENT = String.raw`(?:` + "`[^`]+`" + String.raw`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const FROM_JOIN_RE = new RegExp(
  String.raw`\b(?:FROM|JOIN)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(\s*\()?(?:\s+(?:AS\s+)?(?!(?:${[...NOT_ALIAS].join("|")})\b)(${IDENT}))?`,
  "gi",
);
const CTE_RE = new RegExp(
  String.raw`(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)(${IDENT})\s*(?:\([^()]*\))?\s+AS\s*(?:NOT\s+MATERIALIZED\s*|MATERIALIZED\s*)?\(`,
  "gi",
);
const QUALIFIED_RE = new RegExp(String.raw`(?<![.\w$])(${IDENT})\s*\.\s*(${IDENT}|\*)`, "g");

/** FROM を含むが表名を取らない構文は空白に潰す。 */
const NON_TABLE_PATTERNS: RegExp[] = [
  /\b(?:EXTRACT|TRIM|SUBSTRING|OVERLAY)\s*\([^()]*\)/gi,
  /\bDISTINCT\s+FROM\b/gi,
];

const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog", "performance_schema", "sys", "mysql"]);

function unquote(ident: string): string {
  const first = ident[0];
  return first === "`" || first === '"' || first === "[" ? ident.slice(1, -1) : ident;
}

function isSystemTable(name: string): boolean {
  return /^(?:sqlite_|pg_)/i.test(name);
}

/**
 * SQL の表名・列名をスキーマと照合し、見つからないものを返す。
 * `tablesUsed` は AI 応答の `tables_used` (SQL に現れない綴りの揺れも拾う)。
 * `database` は接続中のデータベース名 (修飾付きの表名が別 DB を指すときは対象外にする)。
 */
export function checkSqlNames(
  sql: string,
  driver: string,
  tables: readonly NameCheckTable[],
  tablesUsed: readonly string[] = [],
  database: string | null = null,
): NameIssue[] {
  if (tables.length === 0) return [];
  const known = new Map<string, NameCheckTable>();
  for (const t of tables) known.set(t.name.toLowerCase(), t);
  let masked = maskLiterals(sql, driver, { keepQuotedIdentifiers: true, cache: false });
  for (const re of NON_TABLE_PATTERNS) masked = masked.replace(re, (m) => " ".repeat(m.length));

  const cteNames = new Set<string>();
  for (const m of masked.matchAll(CTE_RE)) cteNames.add(unquote(m[1]).toLowerCase());

  const issues: NameIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: NameIssue) => {
    const key = `${issue.kind}:${issue.table ?? ""}:${issue.name}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  const db = database?.toLowerCase() ?? null;

  // 別名 → 既知の表。同じ別名が別の表を指す (スコープ違い) ときは曖昧なので外す。
  const aliasToTable = new Map<string, NameCheckTable | null>();
  const bind = (alias: string, table: NameCheckTable) => {
    const prev = aliasToTable.get(alias);
    aliasToTable.set(alias, prev === undefined || prev === table ? table : null);
  };

  for (const m of masked.matchAll(FROM_JOIN_RE)) {
    if (m[2]) continue; // 関数呼び出し (generate_series(...) など)
    const parts = m[1].split(".").map((p) => unquote(p.trim()));
    const name = parts[parts.length - 1];
    const prefix = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : null;
    if (prefix !== null && !["public", "main", db].includes(prefix)) continue; // 別 DB / 別スキーマ
    const lower = name.toLowerCase();
    if (isSystemTable(name) || (prefix === null && cteNames.has(lower))) continue;
    const table = known.get(lower);
    if (!table) {
      if (prefix === null || SYSTEM_SCHEMAS.has(prefix) === false) push({ kind: "table", name });
      continue;
    }
    bind(lower, table);
    const alias = m[3] ? unquote(m[3]) : null;
    if (alias && !NOT_ALIAS.has(alias.toLowerCase())) bind(alias.toLowerCase(), table);
  }

  for (const raw of tablesUsed) {
    const name = unquote(raw.trim().split(".").pop()?.trim() ?? "");
    if (name === "" || isSystemTable(name) || cteNames.has(name.toLowerCase())) continue;
    if (raw.includes(".") && !known.has(name.toLowerCase())) {
      const prefix = unquote(raw.trim().split(".").slice(-2)[0].trim()).toLowerCase();
      if (!["public", "main", db].includes(prefix)) continue;
    }
    if (!known.has(name.toLowerCase())) push({ kind: "table", name });
  }

  for (const m of masked.matchAll(QUALIFIED_RE)) {
    const table = aliasToTable.get(unquote(m[1]).toLowerCase());
    if (!table || m[2] === "*" || table.columns.length === 0) continue;
    const col = unquote(m[2]);
    if (!table.columns.some((c) => c.name.toLowerCase() === col.toLowerCase())) {
      push({ kind: "column", name: col, table: table.name });
    }
  }
  return issues;
}
