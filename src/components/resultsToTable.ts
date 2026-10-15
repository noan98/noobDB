// 実行結果を新規テーブルへ保存 (CREATE TABLE ... AS SELECT、#821) の純ロジック。
//
// エディタで実行した「結果セットを返す単一クエリ」から、同一接続内で完結する
// `CREATE TABLE <名前> AS <クエリ>` を組み立てる。3 方言 (MySQL/PostgreSQL/SQLite)
// とも標準 CTAS 構文をサポートするため、識別子クオート以外の方言差は無い
// (`tableMaintenance.ts` / `createTable.ts` と同じ `qualified` パターン)。
//
// 対象クエリの判定はベストエフォート (パーサではない) で、`dangerousSql.ts` と
// 同じ「コメント/文字列リテラルをマスクしてから先頭キーワードを見る」方式を踏襲する。
// バックエンドの `is_read_only_sql` が実行時に最終防波堤として効くため、ここでの
// 判定をすり抜けても書き込みが素通りすることはない — 目的は UI 上で無意味な
// 導線 (非 SELECT・複数文) を早めに隠すこと。

import { maskLiterals } from "../dangerousSql";
import { quoteIdentFor } from "./sqlDialect";

/**
 * `sql` が単一の `SELECT` / `WITH ...` 文であり、CTAS のソースとして妥当かを判定する。
 * `SHOW` / `DESCRIBE` / `EXPLAIN` は読み取り専用だが `CREATE TABLE ... AS` の
 * ソースにはなれないため対象外。スタック文 (末尾以外に `;` を含む) も拒否する。
 *
 * `driver` は `maskLiterals` の文字列エスケープ規則を選ぶ (#852、#1004)。省略時は
 * 保守的な非 MySQL 解釈になる。
 */
export function isCtasEligibleSql(sql: string, driver?: string): boolean {
  const masked = maskLiterals(sql, driver);
  const body = masked.trim().replace(/;\s*$/, "");
  if (!body) return false;
  // 末尾の 1 個を剥がした後にまだ `;` が残っていれば、隠れた 2 文目がある。
  if (body.includes(";")) return false;
  const lower = body.toLowerCase();
  return /^select\b/.test(lower) || /^with\b/.test(lower);
}

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。 */
function qualified(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/**
 * `CREATE TABLE <name> AS <sourceSql>` 文を生成する。`sourceSql` 末尾の
 * セミコロン/空白は剥がし、生成した文の末尾にだけ 1 つ付与する
 * (呼び出し元の SQL をそのまま連結して二重セミコロンにならないようにする)。
 */
export function buildCreateTableAsSql(
  driver: string,
  database: string | null,
  table: string,
  sourceSql: string,
): string {
  const name = qualified(driver, database, table);
  const query = sourceSql.trim().replace(/;\s*$/, "");
  return `CREATE TABLE ${name} AS\n${query};`;
}

/**
 * `name` (トリム後) が `existingTables` のいずれかと大小無視で一致するか。
 * 空文字は「未入力」であって衝突ではないので false を返す。
 */
export function tableNameCollides(existingTables: string[], name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return false;
  return existingTables.some((t) => t.toLowerCase() === trimmed);
}

// ---- 既存テーブルへの追記 (INSERT ... SELECT、#1623) ----

/** 追記先の列のうち、マッピング判定に必要な最小の形 (`TableColumnInfo` の部分集合)。 */
export interface AppendTargetColumn {
  name: string;
  nullable: boolean;
  default: string | null;
  extra: string;
}

/**
 * 結果の列ごとに追記先の列名 (スキップは `null`) を決める。列名の大小無視一致を優先し、
 * 1 つも一致せず列数が同じときだけ位置対応にする (`SELECT 1, 2` のような無名の結果向け)。
 * 追記先で既に使われた列は 2 度目以降の同名結果列には割り当てない。
 */
export function autoMapAppendColumns(
  resultColumns: string[],
  target: AppendTargetColumn[],
): (string | null)[] {
  const used = new Set<string>();
  const byName = resultColumns.map((rc) => {
    const hit = target.find((t) => t.name.toLowerCase() === rc.toLowerCase() && !used.has(t.name));
    if (hit) used.add(hit.name);
    return hit ? hit.name : null;
  });
  if (byName.some((m) => m !== null)) return byName;
  if (resultColumns.length === target.length) return target.map((t) => t.name);
  return byName;
}

export type AppendIssue =
  | { kind: "noneMapped" }
  | { kind: "duplicateTarget"; column: string }
  | { kind: "duplicateSource"; column: string }
  | { kind: "missingRequired"; column: string };

/** 追記側が自動で値を持てる列 (採番・生成列・既定値あり)。 */
function hasImplicitValue(c: AppendTargetColumn): boolean {
  if (c.nullable || c.default !== null) return true;
  const extra = c.extra.toLowerCase();
  return extra.includes("auto_increment") || extra.includes("generated") || extra.includes("identity");
}

/**
 * マッピングの問題を列挙する。`noneMapped` / `duplicateTarget` / `duplicateSource` は
 * 実行できない (SQL を組めない) 致命的なもので、`missingRequired` は NOT NULL かつ既定値の
 * 無い追記先の列に何も入らない警告 (DB 側で失敗しうるが、ユーザの判断で実行は許す)。
 */
export function findAppendIssues(
  resultColumns: string[],
  mapping: (string | null)[],
  target: AppendTargetColumn[],
): AppendIssue[] {
  const issues: AppendIssue[] = [];
  const mapped = mapping.map((m, i) => ({ target: m, source: resultColumns[i] })).filter((p) => p.target);
  if (mapped.length === 0) issues.push({ kind: "noneMapped" });
  const seenTarget = new Set<string>();
  const dupTarget = new Set<string>();
  for (const p of mapped) {
    const key = (p.target as string).toLowerCase();
    if (seenTarget.has(key)) dupTarget.add(p.target as string);
    seenTarget.add(key);
  }
  for (const column of dupTarget) issues.push({ kind: "duplicateTarget", column });
  // 結果列名が重複していると、サブクエリ越しに名前で参照できない。
  const counts = new Map<string, number>();
  for (const rc of resultColumns) counts.set(rc.toLowerCase(), (counts.get(rc.toLowerCase()) ?? 0) + 1);
  const dupSource = new Set<string>();
  for (const p of mapped) {
    if ((counts.get(p.source.toLowerCase()) ?? 0) > 1) dupSource.add(p.source);
  }
  for (const column of dupSource) issues.push({ kind: "duplicateSource", column });
  for (const c of target) {
    if (!seenTarget.has(c.name.toLowerCase()) && !hasImplicitValue(c)) {
      issues.push({ kind: "missingRequired", column: c.name });
    }
  }
  return issues;
}

/** 実行を止めるべき問題があるか。 */
export function hasBlockingAppendIssue(issues: AppendIssue[]): boolean {
  return issues.some((i) => i.kind !== "missingRequired");
}

/**
 * `INSERT INTO <table> (<追記先の列>) SELECT <結果の列> FROM (<クエリ>) AS _src` を生成する。
 * 結果列は名前で参照する (列の並びが違っても対応どおりに入る)。マッピング対象が無ければ空文字。
 */
export function buildInsertSelectSql(
  driver: string,
  database: string | null,
  table: string,
  resultColumns: string[],
  mapping: (string | null)[],
  sourceSql: string,
): string {
  const pairs = resultColumns
    .map((source, i) => ({ source, target: mapping[i] ?? null }))
    .filter((p): p is { source: string; target: string } => p.target !== null);
  if (pairs.length === 0) return "";
  const q = (n: string) => quoteIdentFor(driver, n);
  const query = sourceSql.trim().replace(/;\s*$/, "");
  return (
    `INSERT INTO ${qualified(driver, database, table)} (${pairs.map((p) => q(p.target)).join(", ")})\n` +
    `SELECT ${pairs.map((p) => q(p.source)).join(", ")}\nFROM (\n${query}\n) AS _src;`
  );
}

/**
 * 追記 (INSERT ... SELECT) の実行前に確認が要るか。通常のクエリ実行の書き込み承認と同じ条件:
 * 本番プロファイルで `confirm_writes` が有効、かつ読み取り専用でない (#1623)。
 */
export function appendNeedsApproval(
  profile: { is_production?: boolean; confirm_writes?: boolean; read_only?: boolean } | null | undefined,
): boolean {
  return !!profile && !!profile.is_production && !!profile.confirm_writes && !profile.read_only;
}
