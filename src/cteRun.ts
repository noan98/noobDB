import type { I18nKey } from "./i18n";
import { isReadOnlySql, maskLiterals } from "./dangerousSql";
import { type CteDef, parseCteDefs } from "./components/sqlDerivedCompletion";
import { quoteIdentFor } from "./components/sqlDialect";
import { unquote } from "./components/sqlJoinCompletion";
import { parseServerVersion } from "./components/statsAdvisor";
import { statementAtOffset } from "./sqlScript";

/**
 * 「この CTE までを実行」(#2409) の SQL 組み立て。純関数で、エディタの本文は書き換えない。
 *
 * カーソルが `WITH ... name AS (...)` の定義の中にあるとき、その CTE と、それが (推移的に)
 * 参照する CTE だけを残した `WITH ... SELECT * FROM <name>` を作る。
 *
 * 仕様 (テストで固定):
 * - **未使用の CTE は落とす**。対象が参照しない CTE は、前段でも後段でも残さない。
 *   書き込みを含む CTE が巻き込まれて実行されるのを避ける意味もある。
 * - 参照は識別子の字句一致で見る (大文字小文字は区別しない・文字列とコメントは対象外・
 *   `x.name` の `name` のようにドットの後ろは参照と見なさない)。列名と偶然一致した CTE は
 *   余分に残るが、結果は変わらない (安全側)。
 * - 非 RECURSIVE では前段の CTE だけを参照元とする (後段の同名は実テーブルを指す)。
 *   RECURSIVE (PostgreSQL は前方参照も許す) では全 CTE を参照元にする。
 * - 書き込みを含む CTE (PG の writable CTE) が残る場合は組み立てない (`writes`)。
 *   最終的な SQL にも読み取り専用ガード (`isReadOnlySql`) を通し、通らなければ同じく拒否する。
 * - 再帰を含むときは `recursive: true` を返し、`limit` が渡されていれば末尾に `LIMIT n` を付ける
 *   (自動 LIMIT の設定が無効でも暴走させないため)。付けた SQL は自動 LIMIT の規約
 *   (`autoLimitVectors.json`: 既存の末尾 LIMIT はそのまま) でも二重に付かない。
 */

export type CteRunBlock =
  /** カーソルのある文が WITH で始まらない。 */
  | "noCte"
  /** カーソルが CTE の定義の外 (WITH 句の外) にある。 */
  | "notInCte"
  /** 対象に書き込みを含む CTE が含まれる。 */
  | "writes"
  /** 組み立てた SQL が読み取り専用ガードを通らない。 */
  | "notReadOnly";

/** 実行できない理由 → 表示文言のキー (ツールチップ / トースト共通)。`unsupported` は WITH 非対応のサーバ。 */
export const CTE_BLOCK_KEYS: Record<CteRunBlock | "unsupported", I18nKey> = {
  noCte: "cteRunBlockedNoCte",
  notInCte: "cteRunBlockedNotInCte",
  writes: "cteRunBlockedWrites",
  notReadOnly: "cteRunBlockedNotReadOnly",
  unsupported: "cteRunBlockedUnsupported",
};

export type CteRunPlan =
  | { ok: true; sql: string; name: string; title: string; recursive: boolean; keptNames: string[] }
  | { ok: false; reason: CteRunBlock };

const IDENT_RE = /`[^`]+`|"[^"]+"|[A-Za-z_]\w*/g;
const WRITE_KW = /\b(?:INSERT|UPDATE|DELETE|MERGE)\b(?!\s*\()/i;

/** 本体 (マスク済み) が参照している識別子 (小文字・引用符なし)。 */
function referencedNames(maskedBody: string): Set<string> {
  const out = new Set<string>();
  for (const m of maskedBody.matchAll(IDENT_RE)) {
    const idx = m.index ?? 0;
    if (maskedBody[idx - 1] === ".") continue;
    out.add(unquote(m[0]).toLowerCase());
  }
  return out;
}

/**
 * `text` の `offset` にあるカーソルの CTE を単体で実行する SQL を作る。
 * `limit` は再帰を含むときだけ末尾に付ける行数上限 (省略可)。
 */
export function buildCteRun(opts: {
  text: string;
  offset: number;
  driver: string;
  limit?: number | null;
}): CteRunPlan {
  const { text, offset, driver } = opts;
  const range = statementAtOffset(text, offset, driver);
  if (!range) return { ok: false, reason: "noCte" };
  const stmt = text.slice(range.from, range.to);
  const rel = Math.max(0, Math.min(offset - range.from, stmt.length));
  const masked = maskLiterals(stmt, driver, { keepQuotedIdentifiers: true, cache: false });
  const parsed = parseCteDefs(masked);
  if (!parsed || parsed.defs.length === 0) return { ok: false, reason: "noCte" };
  const { defs, recursive } = parsed;

  const target = defs.findIndex((d) => rel >= d.start && rel <= d.close + 1);
  if (target < 0) return { ok: false, reason: "notInCte" };

  // 対象から推移的に参照される CTE を集める。
  const bodies = defs.map((d) => masked.slice(d.open + 1, d.close));
  const refs = bodies.map(referencedNames);
  const byName = new Map<string, number[]>();
  defs.forEach((d, i) => {
    const k = d.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), i]);
  });
  const keep = new Set<number>([target]);
  const queue = [target];
  while (queue.length > 0) {
    const cur = queue.pop() as number;
    for (const name of refs[cur]) {
      for (const j of byName.get(name) ?? []) {
        // 非 RECURSIVE は前段 (または自分より前) だけ。同名が複数あれば直近の前段を指す。
        if (!recursive && j >= cur) continue;
        if (keep.has(j)) continue;
        keep.add(j);
        queue.push(j);
      }
    }
  }
  const kept = [...keep].sort((a, b) => a - b);

  if (kept.some((i) => WRITE_KW.test(bodies[i]))) return { ok: false, reason: "writes" };

  // 再帰: 残した CTE のどれかが自分以降の CTE (自分自身を含む) を参照している。
  const isRecursive =
    recursive && kept.some((i) => [...refs[i]].some((n) => (byName.get(n) ?? []).some((j) => j >= i)));

  const target0: CteDef = defs[target];
  const defsSql = kept.map((i) => stmt.slice(defs[i].start, defs[i].close + 1)).join(",\n");
  let sql = `WITH ${recursive ? "RECURSIVE " : ""}${defsSql}\nSELECT * FROM ${quoteIdentFor(driver, target0.name)}`;
  if (isRecursive && opts.limit && opts.limit > 0) sql += `\nLIMIT ${Math.floor(opts.limit)}`;

  if (!isReadOnlySql(sql, driver)) return { ok: false, reason: "notReadOnly" };
  return {
    ok: true,
    sql,
    name: target0.name,
    title: `CTE: ${target0.name}`,
    recursive: isRecursive,
    keptNames: kept.map((i) => defs[i].name),
  };
}

/**
 * このサーバが WITH (CTE) を解釈できるか。MySQL 8.0 未満 (5.x) は不可、MariaDB は 10.2 以降。
 * PostgreSQL / SQLite は常に可。版が分からない (取得前・失敗) ときは塞がない
 * (非対応ならサーバがエラーを返す)。`raw` は `SELECT VERSION()` の文字列。
 */
export function supportsCte(driver: string, raw: string | null): boolean {
  if (driver !== "mysql") return true;
  const v = parseServerVersion(driver, raw);
  if (!v) return true;
  if (v.mariadb) return v.major > 10 || (v.major === 10 && v.minor >= 2);
  return v.major >= 8;
}
