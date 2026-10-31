// パーティション表の構造パネル節 (#1868) の純ロジック。境界式の整形と、パーティションごとに
// 出せる破壊的操作の判定。SQL の組み立ては tableMaintenance.ts / maintenanceCommands.ts。

import type { TablePartition, TablePartitions } from "../api/tauri";
import {
  buildAttachPartitionSql,
  buildDetachPartitionSql,
  buildPartitionDropSql,
  buildPartitionTruncateSql,
} from "./tableMaintenance";

/** データを失う / 構造が変わる操作。確認ダイアログ (本番では名前の型入力) を必ず挟む。 */
export type PartitionDestructiveOp = "truncate" | "detach" | "drop";

/** 括弧の外のカンマで分ける (引用符・入れ子の括弧の中は無視)。 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      cur += c;
      if (c === quote) {
        if (s[i + 1] === quote) {
          cur += s[i + 1];
          i++;
        } else quote = null;
      }
      continue;
    }
    // 英数字の直後の引用符 (`O'Reilly` など) は値の一部として扱い、引用の開始とみなさない。
    // 開始とみなすと閉じ引用符が無いまま後続の値まで 1 つに飲み込んでしまう。
    if ((c === "'" || c === '"') && !/[\p{L}\p{N}_]/u.test(s[i - 1] ?? "")) {
      quote = c;
      cur += c;
    } else if (c === "(") {
      depth++;
      cur += c;
    } else if (c === ")") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** `(...)` で囲まれた本体を返す。囲まれていなければ null。 */
function parenBody(s: string): string | null {
  const t = s.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return null;
  return t.slice(1, -1).trim();
}

/** `'2026-01-01'::date` のような型キャストと外側の単一引用符を落とした、読みやすい値。 */
function plainValue(v: string): string {
  const t = v.trim().replace(/::[a-zA-Z_][\w ]*(\(\d+(,\s*\d+)?\))?(\[\])?$/, "");
  const m = /^'((?:[^']|'')*)'$/.exec(t);
  return m ? (m[1] ?? "").replace(/''/g, "'") : t;
}

function plainList(body: string): string {
  return splitTopLevel(body).map(plainValue).join(", ");
}

/**
 * 境界の表示文字列を短くする。
 *
 * - PostgreSQL RANGE `FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')` → `2026-01-01 → 2026-02-01`
 *   (`MINVALUE` / `MAXVALUE` はそのまま)
 * - PostgreSQL LIST `FOR VALUES IN ('a', 'b')` → `a, b`
 * - PostgreSQL HASH `FOR VALUES WITH (modulus 4, remainder 1)` → `modulus 4 / remainder 1`
 * - `DEFAULT` → `DEFAULT`
 * - MySQL `LESS THAN (100)` / `IN (1,2)` はそのまま。
 *
 * 読めない形式は原文を返す (失わない)。
 */
export function formatPartitionBound(bound: string): string {
  const raw = bound.trim();
  if (raw === "") return "";
  if (/^default$/i.test(raw)) return "DEFAULT";
  const body = raw.replace(/^FOR VALUES\s+/i, "");
  const range = /^FROM\s*(\(.*\))\s*TO\s*(\(.*\))$/is.exec(body);
  if (range) {
    const from = parenBody(range[1] as string);
    const to = parenBody(range[2] as string);
    if (from !== null && to !== null) return `${plainList(from)} → ${plainList(to)}`;
  }
  const inList = /^IN\s*(\(.*\))$/is.exec(body);
  if (inList && /^FOR VALUES/i.test(raw)) {
    const inner = parenBody(inList[1] as string);
    if (inner !== null) return plainList(inner);
  }
  const hash = /^WITH\s*\(\s*modulus\s+(\d+)\s*,\s*remainder\s+(\d+)\s*\)$/i.exec(body);
  if (hash) return `modulus ${hash[1]} / remainder ${hash[2]}`;
  return raw;
}

/** MySQL の DROP PARTITION は RANGE / LIST の直下のパーティションだけ (HASH / KEY は COALESCE 系)。 */
function mysqlCanDrop(method: string, p: TablePartition): boolean {
  return p.depth === 0 && (/^RANGE/i.test(method) || /^LIST/i.test(method));
}

/** そのパーティションに出せる破壊的操作 (ドライバ・分割方式・階層で変わる)。SQLite は無し。 */
export function partitionDestructiveOps(
  driver: string,
  info: Pick<TablePartitions, "method">,
  p: TablePartition,
): PartitionDestructiveOp[] {
  if (driver === "postgres") {
    return ["truncate", "detach", "drop"];
  }
  if (driver === "mysql") {
    // MySQL のサブパーティションへの操作は未検証なので出さない。
    if (p.depth > 0) return [];
    return mysqlCanDrop(info.method, p) ? ["truncate", "drop"] : ["truncate"];
  }
  return [];
}

/** 破壊的操作の SQL。 */
export function buildPartitionOpSql(
  op: PartitionDestructiveOp,
  driver: string,
  database: string | null,
  table: string,
  part: TablePartition,
): string {
  const p = { name: part.name, schema: part.schema, parent: part.parent, parentSchema: part.parent_schema };
  switch (op) {
    case "truncate":
      return buildPartitionTruncateSql(driver, database, table, p);
    case "drop":
      return buildPartitionDropSql(driver, database, table, p);
    case "detach":
      return buildDetachPartitionSql(driver, database, table, p);
  }
}

// ---- ATTACH PARTITION (#1929) ----

/** ATTACH で境界を組み立てられる分割方式 (PostgreSQL の宣言的パーティション)。 */
export type AttachBoundKind = "range" | "list" | "hash";

/** ATTACH できるか: PostgreSQL の RANGE / LIST / HASH だけ (MySQL は EXCHANGE PARTITION で別物、SQLite は無し)。 */
export function attachBoundKind(
  driver: string,
  info: Pick<TablePartitions, "method">,
): AttachBoundKind | null {
  if (driver !== "postgres") return null;
  const m = info.method.trim().toUpperCase();
  return m === "RANGE" ? "range" : m === "LIST" ? "list" : m === "HASH" ? "hash" : null;
}

/** パーティションキー (`created_at` / `a, b` / `lower(region)`) を列ごとに分ける。 */
export function partitionKeyColumns(key: string): string[] {
  return splitTopLevel(key);
}

/** LIST の入力欄 (カンマ区切り。引用符・括弧の中のカンマは区切りにしない) を値に分ける。 */
export function parseListValues(raw: string): string[] {
  return splitTopLevel(raw);
}

/**
 * 利用者が入力した境界値を SQL リテラルにする。MINVALUE / MAXVALUE / NULL (大文字小文字無視) と、
 * 入力全体が 1 つの完全な文字列リテラルのものだけをそのまま使い、他はすべて文字列として引用する
 * (中の単一引用符は二重化)。数値も引用してよい: PostgreSQL がキー列の型へ変換するので、文字列キーの
 * '007' の先頭 0 も保たれる。式や複数値を紛れ込ませて文を抜け出す入力は、全体が 1 つの文字列になる。
 */
export function quoteBoundValue(raw: string): string {
  const v = raw.trim();
  if (/^(minvalue|maxvalue|null)$/i.test(v)) return v.toUpperCase();
  if (/^'(?:[^']|'')*'$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

/** 境界の入力。DEFAULT は RANGE / LIST のみ (HASH には無い)。 */
export type AttachBoundSpec =
  | { kind: "default" }
  | { kind: "range"; from: string[]; to: string[] }
  | { kind: "list"; values: string[] }
  | { kind: "hash"; modulus: string; remainder: string };

/** 入力の不備。null なら組み立てられる。UI は i18n キーに対応づける。 */
export type AttachBoundError = "rangeEmpty" | "listEmpty" | "hashModulus" | "hashRemainder";

/** 境界入力の検証。 */
export function validateAttachBound(spec: AttachBoundSpec): AttachBoundError | null {
  switch (spec.kind) {
    case "default":
      return null;
    case "range":
      return spec.from.some((v) => v.trim() === "") || spec.to.some((v) => v.trim() === "")
        ? "rangeEmpty"
        : null;
    case "list":
      return spec.values.every((v) => v.trim() === "") ? "listEmpty" : null;
    case "hash": {
      if (!/^\d+$/.test(spec.modulus.trim()) || Number(spec.modulus) < 1) return "hashModulus";
      if (!/^\d+$/.test(spec.remainder.trim()) || Number(spec.remainder) >= Number(spec.modulus)) {
        return "hashRemainder";
      }
      return null;
    }
  }
}

/** `FOR VALUES ...` / `DEFAULT` の句。入力が不正なら空文字。 */
export function buildPartitionBoundClause(spec: AttachBoundSpec): string {
  if (validateAttachBound(spec) !== null) return "";
  switch (spec.kind) {
    case "default":
      return "DEFAULT";
    case "range":
      return `FOR VALUES FROM (${spec.from.map(quoteBoundValue).join(", ")}) TO (${spec.to.map(quoteBoundValue).join(", ")})`;
    case "list":
      return `FOR VALUES IN (${spec.values
        .filter((v) => v.trim() !== "")
        .map(quoteBoundValue)
        .join(", ")})`;
    case "hash":
      return `FOR VALUES WITH (MODULUS ${Number(spec.modulus)}, REMAINDER ${Number(spec.remainder)})`;
  }
}

/** ATTACH の SQL (入力が不正なら空文字)。 */
export function buildAttachSql(
  driver: string,
  database: string | null,
  table: string,
  child: string,
  spec: AttachBoundSpec,
): string {
  return buildAttachPartitionSql(
    driver,
    database,
    table,
    { name: child, schema: database },
    buildPartitionBoundClause(spec),
  );
}

/**
 * 付け先候補: 親と同じスキーマの表から、親自身と既に付いている直下のパーティションを除く。
 * (他のパーティション表の子かどうかは分からないので、その場合は DB 側のエラーになる。)
 */
export function attachCandidates(
  tables: readonly string[],
  parent: string,
  info: Pick<TablePartitions, "partitions">,
): string[] {
  const attached = new Set(info.partitions.map((p) => p.name));
  return tables.filter((n) => n !== parent && !attached.has(n));
}

/** 既存の HASH パーティションの MODULUS (新しい子の既定値に使う)。無ければ null。 */
export function existingHashModulus(info: Pick<TablePartitions, "partitions">): string | null {
  for (const p of info.partitions) {
    if (p.depth !== 0) continue;
    const m = /modulus\s+(\d+)/i.exec(p.bound);
    if (m) return m[1] as string;
  }
  return null;
}
