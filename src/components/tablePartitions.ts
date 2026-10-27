// パーティション表の構造パネル節 (#1868) の純ロジック。境界式の整形と、パーティションごとに
// 出せる破壊的操作の判定。SQL の組み立ては tableMaintenance.ts / maintenanceCommands.ts。

import type { TablePartition, TablePartitions } from "../api/tauri";
import {
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
    if (c === "'" || c === '"') {
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
    // DETACH は直下の子だけ (サブパーティションは親のスキーマが分からないため対象外)。
    return p.depth === 0 ? ["truncate", "detach", "drop"] : ["truncate", "drop"];
  }
  if (driver === "mysql") {
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
  p: TablePartition,
): string {
  switch (op) {
    case "truncate":
      return buildPartitionTruncateSql(driver, database, table, p);
    case "drop":
      return buildPartitionDropSql(driver, database, table, p);
    case "detach":
      return buildDetachPartitionSql(driver, database, table, p);
  }
}
