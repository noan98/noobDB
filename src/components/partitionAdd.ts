// パーティション表に「次のパーティションを追加」する入力の純ロジック (#2211)。
//
// 既存の最後の RANGE 境界から同じ幅の次の期間を推定し、N 件まとめての SQL を作る。
// - PostgreSQL: 子ごとに `CREATE TABLE ... PARTITION OF ... FOR VALUES ...` (RANGE / LIST / HASH)。
// - MySQL: `ALTER TABLE ... ADD PARTITION (...)`。MAXVALUE のパーティションがある RANGE は
//   末尾に足せないので `REORGANIZE PARTITION <max> INTO (新しい子..., <max>)` で分割する。
//   HASH / KEY は `ADD PARTITION PARTITIONS n`。
// - SQLite: パーティション非対応 (導線なし)。
// 識別子は sqlDialect.ts、PostgreSQL の境界リテラルは tablePartitions.ts の既存関数を流用する。

import type { TablePartitions } from "../api/tauri";
import {
  buildPartitionBoundClause,
  parseHashBound,
  parseListBound,
  parseListValues,
  parseRangeBound,
  partitionKeyColumns,
} from "./tablePartitions";
import { qualifiedTableName, quoteIdentFor } from "./sqlDialect";

export type AddPartitionKind = "range" | "list" | "hash" | "hashCount";

/** 追加できるか。PostgreSQL の RANGE / LIST / HASH、MySQL の RANGE / LIST / HASH / KEY (サブパーティション無し)。 */
export function addPartitionKind(
  driver: string,
  info: Pick<TablePartitions, "method" | "sub_method">,
): AddPartitionKind | null {
  const m = info.method.trim().toUpperCase();
  if (driver === "postgres") {
    return m === "RANGE" ? "range" : m === "LIST" ? "list" : m === "HASH" ? "hash" : null;
  }
  if (driver === "mysql") {
    // サブパーティション付きは ADD PARTITION にサブ定義も要るので扱わない。
    if (info.sub_method) return null;
    if (m.startsWith("RANGE")) return "range";
    if (m.startsWith("LIST")) return "list";
    if (/^(LINEAR )?(HASH|KEY)/.test(m)) return "hashCount";
  }
  return null;
}

// ---- 値の比較・加算 ----

interface Temporal {
  y: number;
  m: number;
  d: number;
  time: string | null;
}

const TEMPORAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?$/;

function parseTemporal(s: string): Temporal | null {
  const m = TEMPORAL_RE.exec(s.trim());
  if (!m) return null;
  const t = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), time: m[4] ?? null };
  if (t.m < 1 || t.m > 12 || t.d < 1 || t.d > daysInMonth(t.y, t.m)) return null;
  return t;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function formatTemporal(t: Temporal): string {
  const date = `${pad(t.y, 4)}-${pad(t.m)}-${pad(t.d)}`;
  return t.time ? `${date} ${t.time}` : date;
}

function temporalMs(t: Temporal): number {
  const [hh, mi, ss] = (t.time ?? "00:00:00").split(":").map(Number);
  return Date.UTC(t.y, t.m - 1, t.d, hh ?? 0, mi ?? 0, ss ?? 0);
}

function addMonths(t: Temporal, n: number): Temporal {
  const idx = t.y * 12 + (t.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { ...t, y, m, d: Math.min(t.d, daysInMonth(y, m)) };
}

function addDays(t: Temporal, n: number): Temporal {
  const dt = new Date(Date.UTC(t.y, t.m - 1, t.d + n));
  return { ...t, y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const INT_RE = /^-?\d+$/;

function isInfinite(v: string): -1 | 1 | 0 {
  const u = v.trim().toUpperCase();
  return u === "MINVALUE" ? -1 : u === "MAXVALUE" ? 1 : 0;
}

/** 2 つの境界値の大小。整数同士・日付同士・MINVALUE / MAXVALUE は比べられる。比べられなければ null。 */
export function compareBoundValue(a: string, b: string): number | null {
  const ia = isInfinite(a);
  const ib = isInfinite(b);
  if (ia !== 0 || ib !== 0) return Math.sign(ia - ib);
  const x = a.trim();
  const y = b.trim();
  if (INT_RE.test(x) && INT_RE.test(y)) {
    const bx = BigInt(x);
    const by = BigInt(y);
    return bx < by ? -1 : bx > by ? 1 : 0;
  }
  const tx = parseTemporal(x);
  const ty = parseTemporal(y);
  if (tx && ty) return Math.sign(temporalMs(tx) - temporalMs(ty));
  return null;
}

/** 複数キー列の境界を辞書順に比べる (PostgreSQL の RANGE と同じ)。判定できなければ null。 */
export function compareBoundTuple(a: readonly string[], b: readonly string[]): number | null {
  if (a.length !== b.length) return null;
  for (let i = 0; i < a.length; i++) {
    const c = compareBoundValue(a[i] as string, b[i] as string);
    if (c === null) return null;
    if (c !== 0) return c;
  }
  return 0;
}

type Step = { type: "int"; by: bigint } | { type: "months"; by: number } | { type: "days"; by: number };

/** `from` → `to` の幅。月初同士で月数が整数ならカレンダー月 (年も月数)、そうでなければ日数 / 整数の差。 */
function stepOf(from: string, to: string): Step | null {
  const f = from.trim();
  const t = to.trim();
  if (INT_RE.test(f) && INT_RE.test(t)) {
    const by = BigInt(t) - BigInt(f);
    return by > 0n ? { type: "int", by } : null;
  }
  const tf = parseTemporal(f);
  const tt = parseTemporal(t);
  if (!tf || !tt || tf.time !== tt.time) return null;
  const months = (tt.y - tf.y) * 12 + (tt.m - tf.m);
  if (tf.d === tt.d && months > 0) return { type: "months", by: months };
  const days = Math.round((temporalMs(tt) - temporalMs(tf)) / 86_400_000);
  return days > 0 ? { type: "days", by: days } : null;
}

function applyStep(v: string, step: Step): string | null {
  const s = v.trim();
  if (step.type === "int") return INT_RE.test(s) ? String(BigInt(s) + step.by) : null;
  const t = parseTemporal(s);
  if (!t) return null;
  return formatTemporal(step.type === "months" ? addMonths(t, step.by) : addDays(t, step.by));
}

/** 次の期間: 直前の `to` が新しい `from`、`to` は同じ幅だけ進める。1 列の RANGE だけ。 */
export function advanceRange(from: string, to: string): { from: string; to: string } | null {
  const step = stepOf(from, to);
  if (!step) return null;
  const next = applyStep(to, step);
  return next === null ? null : { from: to.trim(), to: next };
}

/** 名前の末尾に付ける境界ラベル: 年単位 `2026` / 月単位 `2026_02` / 日付 `20260201` / 整数はそのまま。 */
function boundLabel(from: string, to: string): string {
  const step = stepOf(from, to);
  const t = parseTemporal(from);
  if (step && t) {
    if (step.type === "months" && step.by % 12 === 0 && t.m === 1) return pad(t.y, 4);
    if (step.type === "months") return `${pad(t.y, 4)}_${pad(t.m)}`;
    return `${pad(t.y, 4)}${pad(t.m)}${pad(t.d)}`;
  }
  return from.trim().replace(/[^\p{L}\p{N}]+/gu, "_");
}

/** 名前から末尾の数字・区切りを落とした接頭辞。数字で終わらない名前は `名前_` を接頭辞にする。 */
function namePrefix(name: string, table: string): string {
  const stripped = name.replace(/\d[\d_-]*$/, "");
  if (stripped === name) return name === "" ? `${table}_` : `${name}_`;
  return stripped === "" ? `${table}_` : stripped;
}

// ---- 既存パーティションの解釈 ----

interface ExistingRange {
  name: string;
  from: string[] | null;
  to: string[];
}

function topLevel(info: Pick<TablePartitions, "partitions">) {
  return info.partitions.filter((p) => p.depth === 0 && !p.is_default);
}

/** 直下の RANGE パーティションの区間。MySQL は `LESS THAN` だけなので下限は 1 つ前の上限 (先頭は null)。 */
function existingRanges(driver: string, info: Pick<TablePartitions, "partitions">): ExistingRange[] {
  const out: ExistingRange[] = [];
  let prevTo: string[] | null = null;
  for (const p of topLevel(info)) {
    const b = parseRangeBound(p.bound);
    if (!b) continue;
    out.push({ name: p.name, from: driver === "mysql" ? prevTo : b.from, to: b.to });
    prevTo = b.to;
  }
  return out;
}

const isMaxTuple = (to: readonly string[]) => to.length > 0 && to.every((v) => isInfinite(v) === 1);

/** MySQL の RANGE に MAXVALUE のパーティションがあれば、その名前と上限の個数。 */
function mysqlMaxPartition(
  info: Pick<TablePartitions, "partitions">,
): { name: string; arity: number } | null {
  for (const p of topLevel(info)) {
    const b = parseRangeBound(p.bound);
    if (b && isMaxTuple(b.to)) return { name: p.name, arity: b.to.length };
  }
  return null;
}

/** 有限の上限を持つ最後の RANGE 区間 (比べられなければ一覧の後ろの方を採る)。 */
function lastFiniteRange(ranges: readonly ExistingRange[]): ExistingRange | null {
  let last: ExistingRange | null = null;
  for (const r of ranges) {
    if (isMaxTuple(r.to) || r.to.some((v) => isInfinite(v) === 1)) continue;
    if (!last || (compareBoundTuple(r.to, last.to) ?? 1) > 0) last = r;
  }
  return last;
}

// ---- フォームと SQL ----

export interface AddPartitionForm {
  name: string;
  /** RANGE の下限 (キー列ごと)。MySQL は直前の上限で決まるので参照されない。 */
  from: string[];
  to: string[];
  /** LIST の入力欄 (カンマ区切り)。 */
  values: string;
  modulus: string;
  remainder: string;
  /** 一度に作る件数 (RANGE / MySQL の HASH・KEY)。 */
  count: string;
}

/** RANGE の列数: 直近の境界の値の数、無ければキー列の数。 */
export function rangeArity(info: Pick<TablePartitions, "key" | "partitions">): number {
  for (const p of [...topLevel(info)].reverse()) {
    const b = parseRangeBound(p.bound);
    if (b) return b.to.length;
  }
  return Math.max(1, partitionKeyColumns(info.key).length);
}

/** 入力の初期値。RANGE は最後の境界と同じ幅の次の期間、HASH は未使用の剰余を提案する。 */
export function initialAddForm(
  driver: string,
  table: string,
  info: Pick<TablePartitions, "key" | "method" | "partitions">,
  kind: AddPartitionKind,
): AddPartitionForm {
  const arity = rangeArity(info);
  const form: AddPartitionForm = {
    name: "",
    from: Array.from({ length: arity }, () => ""),
    to: Array.from({ length: arity }, () => ""),
    values: "",
    modulus: "",
    remainder: "",
    count: "1",
  };
  const prefixSource = topLevel(info).at(-1)?.name ?? "";
  if (kind === "range") {
    const ranges = existingRanges(driver, info);
    const last = lastFiniteRange(ranges);
    if (last && last.to.length === 1) {
      const lastTo = last.to[0] as string;
      const lastFrom = last.from?.[0];
      // MySQL の先頭パーティションは下限が無いので幅を推定できない (上限だけ提案する)。
      const next = lastFrom === undefined ? null : advanceRange(lastFrom, lastTo);
      form.from = [lastTo];
      if (next) {
        form.to = [next.to];
        form.name = namePrefix(prefixSource, table) + boundLabel(next.from, next.to);
      }
    } else if (last) {
      form.from = [...last.to];
    }
    return form;
  }
  if (kind === "hash") {
    const hashes = topLevel(info).flatMap((p) => {
      const h = parseHashBound(p.bound);
      return h ? [h] : [];
    });
    const modulus = hashes[0]?.modulus;
    if (modulus !== undefined) {
      form.modulus = String(modulus);
      const used = new Set(hashes.filter((h) => h.modulus === modulus).map((h) => h.remainder));
      for (let r = 0; r < modulus; r++) {
        if (!used.has(r)) {
          form.remainder = String(r);
          break;
        }
      }
    }
    form.name = namePrefix(prefixSource, table) + (form.remainder === "" ? "" : form.remainder);
    return form;
  }
  if (kind === "list") form.name = namePrefix(prefixSource, table);
  return form;
}

/** 入力の不備。UI は code を i18n キーに対応づけ、detail を差し込む。 */
export type AddPartitionErrorCode =
  | "nameEmpty"
  | "nameDuplicate"
  | "rangeEmpty"
  | "rangeOrder"
  | "rangeOverlap"
  | "rangeNotAscending"
  | "listEmpty"
  | "listOverlap"
  | "hashModulus"
  | "hashRemainder"
  | "hashDuplicate"
  | "count"
  | "countUnsupported";

export interface AddPartitionError {
  code: AddPartitionErrorCode;
  detail?: string;
}

export interface PlannedPartition {
  name: string;
  from: string[];
  to: string[];
}

export interface AddPartitionPlan {
  /** MySQL の RANGE で MAXVALUE を分割するとき `reorganize`。 */
  mode: "add" | "reorganize";
  /** 作る子 (RANGE のみ。件数ぶん)。 */
  items: PlannedPartition[];
  /** 実行する文。エラーがあれば空。 */
  statements: string[];
  /** プレビュー用に連結した SQL。エラーがあれば空文字。 */
  sql: string;
  errors: AddPartitionError[];
}

export const MAX_ADD_COUNT = 60;

/** MySQL の LESS THAN / IN に書くリテラル: 整数・MAXVALUE・MINVALUE はそのまま、他は文字列として引用する。 */
function mysqlLiteral(raw: string): string {
  const v = raw.trim();
  if (INT_RE.test(v)) return v;
  if (isInfinite(v) !== 0) return v.toUpperCase();
  if (/^'(?:[^']|'')*'$/.test(v)) return v;
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

const nameKey = (driver: string, n: string) => (driver === "mysql" ? n.toLowerCase() : n);

function emptyPlan(errors: AddPartitionError[], mode: "add" | "reorganize" = "add"): AddPartitionPlan {
  return { mode, items: [], statements: [], sql: "", errors };
}

function finishPlan(
  mode: "add" | "reorganize",
  items: PlannedPartition[],
  statements: string[],
): AddPartitionPlan {
  return { mode, items, statements, sql: statements.join("\n"), errors: [] };
}

function parseCount(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_ADD_COUNT ? n : null;
}

/** PostgreSQL の `CREATE TABLE <child> PARTITION OF <parent> <境界句>;`。 */
function partitionOfSql(database: string | null, table: string, child: string, bound: string): string {
  return `CREATE TABLE ${qualifiedTableName("postgres", database, child)} PARTITION OF ${qualifiedTableName("postgres", database, table)} ${bound};`;
}

/** 追加の SQL を組み立てる。入力が不正 / 既存の境界と重なるときは errors を返し SQL は空。 */
export function planAddPartitions(
  driver: string,
  database: string | null,
  table: string,
  info: Pick<TablePartitions, "key" | "method" | "sub_method" | "partitions">,
  kind: AddPartitionKind,
  form: AddPartitionForm,
): AddPartitionPlan {
  const errors: AddPartitionError[] = [];
  const existingNames = new Set(info.partitions.map((p) => nameKey(driver, p.name)));
  const checkName = (name: string, seen: Set<string>) => {
    if (name.trim() === "") errors.push({ code: "nameEmpty" });
    else if (existingNames.has(nameKey(driver, name.trim())) || seen.has(nameKey(driver, name.trim()))) {
      errors.push({ code: "nameDuplicate", detail: name.trim() });
    }
    seen.add(nameKey(driver, name.trim()));
  };
  const q = (name: string) => quoteIdentFor(driver, name);
  const target = qualifiedTableName(driver, database, table);

  if (kind === "hashCount") {
    const n = parseCount(form.count);
    if (n === null) return emptyPlan([{ code: "count" }]);
    return finishPlan("add", [], [`ALTER TABLE ${target} ADD PARTITION PARTITIONS ${n};`]);
  }

  if (kind === "hash") {
    checkName(form.name, new Set());
    const mod = form.modulus.trim();
    const rem = form.remainder.trim();
    if (!/^\d+$/.test(mod) || Number(mod) < 1) errors.push({ code: "hashModulus" });
    else if (!/^\d+$/.test(rem) || Number(rem) >= Number(mod)) errors.push({ code: "hashRemainder" });
    else {
      const dup = topLevel(info).some((p) => {
        const h = parseHashBound(p.bound);
        return h !== null && h.modulus === Number(mod) && h.remainder === Number(rem);
      });
      if (dup) errors.push({ code: "hashDuplicate" });
    }
    if (errors.length > 0) return emptyPlan(errors);
    const bound = buildPartitionBoundClause({ kind: "hash", modulus: mod, remainder: rem });
    return finishPlan("add", [], [partitionOfSql(database, table, form.name.trim(), bound)]);
  }

  if (kind === "list") {
    checkName(form.name, new Set());
    const values = parseListValues(form.values).filter((v) => v.trim() !== "");
    if (values.length === 0) errors.push({ code: "listEmpty" });
    else {
      const used = new Set<string>();
      for (const p of topLevel(info)) for (const v of parseListBound(p.bound) ?? []) used.add(v);
      const seen = new Set<string>();
      for (const v of values.map(plainListValue)) {
        if (used.has(v) || seen.has(v)) {
          errors.push({ code: "listOverlap", detail: v });
          break;
        }
        seen.add(v);
      }
    }
    if (errors.length > 0) return emptyPlan(errors);
    if (driver === "postgres") {
      const bound = buildPartitionBoundClause({ kind: "list", values });
      return finishPlan("add", [], [partitionOfSql(database, table, form.name.trim(), bound)]);
    }
    return finishPlan(
      "add",
      [],
      [
        `ALTER TABLE ${target} ADD PARTITION (PARTITION ${q(form.name.trim())} VALUES IN (${values.map(mysqlLiteral).join(", ")}));`,
      ],
    );
  }

  // ---- RANGE ----
  const count = parseCount(form.count);
  if (count === null) errors.push({ code: "count" });
  const ranges = existingRanges(driver, info);
  const maxPart = driver === "mysql" ? mysqlMaxPartition(info) : null;
  const last = driver === "mysql" ? lastFiniteRange(ranges) : null;
  // MySQL の下限は常に直前の上限 (最初の 1 件が先頭のパーティションなら下限なし)。
  const firstFrom = driver === "mysql" ? (last?.to ?? form.from.map(() => "MINVALUE")) : form.from;
  const filled = (a: readonly string[]) => a.length > 0 && a.every((v) => v.trim() !== "");
  if (!filled(firstFrom) || !filled(form.to)) errors.push({ code: "rangeEmpty" });
  checkName(form.name, new Set());
  if (errors.length > 0) return emptyPlan(errors, maxPart ? "reorganize" : "add");

  const items: PlannedPartition[] = [{ name: form.name.trim(), from: firstFrom, to: form.to }];
  if ((count ?? 1) > 1) {
    const f0 = firstFrom[0] as string;
    const t0 = form.to[0] as string;
    const prefix = namePrefix(form.name.trim(), table);
    let cur = { from: f0, to: t0 };
    const seen = new Set([nameKey(driver, form.name.trim())]);
    for (let i = 1; i < (count ?? 1); i++) {
      const next = form.to.length === 1 ? advanceRange(cur.from, cur.to) : null;
      if (!next) {
        errors.push({ code: "countUnsupported" });
        break;
      }
      const name = prefix + boundLabel(next.from, next.to);
      checkName(name, seen);
      items.push({ name, from: [next.from], to: [next.to] });
      cur = next;
    }
  }
  if (errors.length > 0) return emptyPlan(errors, maxPart ? "reorganize" : "add");

  // 順序と重なり。
  for (const it of items) {
    if (driver === "mysql") {
      const lowerCmp = compareBoundTuple(it.to, it.from);
      if (lowerCmp !== null && lowerCmp <= 0 && last) {
        errors.push({ code: "rangeNotAscending", detail: last.to.join(", ") });
        break;
      }
    } else if ((compareBoundTuple(it.from, it.to) ?? -1) >= 0) {
      errors.push({ code: "rangeOrder" });
      break;
    }
  }
  if (errors.length === 0) {
    const sorted = items.map((it, i) => ({ it, i }));
    for (const { it, i } of sorted) {
      for (const other of items.slice(0, i)) {
        // 生成した件どうしの重なり (幅が不正でない限り起きないが念のため)。
        if (
          (compareBoundTuple(it.from, other.to) ?? 1) < 0 &&
          (compareBoundTuple(other.from, it.to) ?? 1) < 0
        ) {
          errors.push({ code: "rangeOverlap", detail: other.name });
        }
      }
      if (driver === "postgres") {
        for (const ex of ranges) {
          if (!ex.from) continue;
          if ((compareBoundTuple(it.from, ex.to) ?? 1) < 0 && (compareBoundTuple(ex.from, it.to) ?? 1) < 0) {
            errors.push({ code: "rangeOverlap", detail: ex.name });
            break;
          }
        }
      }
    }
  }
  if (errors.length > 0) return emptyPlan(errors, maxPart ? "reorganize" : "add");

  if (driver === "postgres") {
    return finishPlan(
      "add",
      items,
      items.map((it) =>
        partitionOfSql(
          database,
          table,
          it.name,
          buildPartitionBoundClause({ kind: "range", from: it.from, to: it.to }),
        ),
      ),
    );
  }
  const defs = items.map(
    (it) => `PARTITION ${q(it.name)} VALUES LESS THAN (${it.to.map(mysqlLiteral).join(", ")})`,
  );
  if (maxPart) {
    const maxVals = Array.from({ length: maxPart.arity }, () => "MAXVALUE").join(", ");
    defs.push(`PARTITION ${q(maxPart.name)} VALUES LESS THAN (${maxVals})`);
    return finishPlan("reorganize", items, [
      `ALTER TABLE ${target} REORGANIZE PARTITION ${q(maxPart.name)} INTO (${defs.join(", ")});`,
    ]);
  }
  return finishPlan("add", items, [`ALTER TABLE ${target} ADD PARTITION (${defs.join(", ")});`]);
}

/** LIST の入力値を既存境界 (`parseListBound` の値) と同じ形に正規化する (引用符を外す)。 */
function plainListValue(raw: string): string {
  const v = raw.trim();
  const m = /^'((?:[^']|'')*)'$/.exec(v);
  return m ? (m[1] ?? "").replace(/''/g, "'") : v;
}

/** PostgreSQL で DEFAULT パーティションがあるか (追加時に行の移動確認とロックの注意を出す)。 */
export function hasDefaultPartition(info: Pick<TablePartitions, "partitions">): boolean {
  return info.partitions.some((p) => p.depth === 0 && p.is_default);
}

/** MySQL の RANGE で MAXVALUE を分割する追加か。 */
export function reorganizesMaxvalue(
  driver: string,
  kind: AddPartitionKind,
  info: Pick<TablePartitions, "partitions">,
): string | null {
  return driver === "mysql" && kind === "range" ? (mysqlMaxPartition(info)?.name ?? null) : null;
}
