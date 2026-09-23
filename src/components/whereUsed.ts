/**
 * オブジェクト依存検索 (Where-used / 影響分析、#1027) の純ロジック。副作用なし
 * (定義の取得は呼び出し側から関数として注入する) なので Vitest で単体テストできる。
 *
 * 「このテーブル / 列を DROP・RENAME したら何が壊れるか」に答えるため、ビュー・
 * ルーチン・トリガーの定義本文 (既存の `list_schema_objects` →
 * `get_object_definition`) と保存済みスニペットを走査し、指定した識別子への参照を
 * 洗い出す。**新しい IPC / 実行経路は増やさない** — どちらも読み取りの introspection
 * なので read_only セッションでも動く。
 *
 * ## パーサではない
 *
 * 本物の SQL パーサではなく、「コメント / 文字列リテラルをマスクしてから識別子
 * トークンを照合する」ベストエフォートの走査である。影響分析では**見落としの方が
 * 誤検出より危険**なので、判定に迷うものは除外せず `possible` (候補) として残す。
 *
 * ## 識別子境界の規則 (誤検出の抑止)
 *
 * 1. 照合は**トークン単位**。部分文字列一致はしない (`orders` は `orders_archive` /
 *    `old_orders` / `orders2` にマッチしない)。識別子文字は Unicode の文字・数字・
 *    `_`・`$` (MySQL は `$` を名前に許す)。
 * 2. 大小文字は**無視**する。引用識別子 (`"Orders"`) は本来大小を区別する方言も
 *    あるが、見落とし回避を優先して同一視する。
 * 3. 引用形式は `"x"` (MySQL 以外)・`` `x` ``・`[x]` (MSSQL / SQLite) を解釈し、
 *    中身 (二重化エスケープ解除後) で照合する。MySQL の `"x"` は文字列リテラル。
 * 4. `@x` / `@@x` (変数)・`:x` (バインド。`::` キャストは除く)・`$1` (位置
 *    パラメータ)・数字始まりの語はそもそも識別子として扱わない。
 * 5. ドット連鎖 (`schema.table.column`) を 1 単位として読む。
 *    - テーブル: 連鎖の末尾 (`FROM s.orders`) か末尾の 1 つ手前 (`orders.id`) に
 *      ある場合だけ。修飾子付きなら、その修飾子が対象のスキーマ / DB (`tableQualifiers`)
 *      のときだけ採用する (`other_schema.orders` / `o.orders` は別物として除外)。
 *    - 列: 連鎖の末尾にある場合だけ。`s.other_table.col` のように**別テーブルと
 *      確定できる**ものは除外、`orders.col` / 別名 `o.col` (FROM/JOIN から拾った
 *      エイリアス) は直接参照、解決できない修飾子 (`x.col` / トリガーの `NEW.col`)
 *      と無修飾の列は、本文が対象テーブルを参照していれば直接、していなければ候補。
 *
 * ## マスク
 *
 * 安全網と同じ `dangerousSql.ts` の `maskLiterals` (共有ゴールデンで Rust と固定)
 * をそのまま再利用し、その結果に 2 つだけ手を加える (`prepareForReferenceScan`)。
 * `maskLiterals` 自体の挙動は変えない (ゴールデンに影響しない)。
 *
 * - `maskLiterals` は引用識別子の中身も空白にするので、区切り文字が残っている
 *   位置から元の中身を書き戻す (`"Order Items"` を照合できるように)。
 * - PostgreSQL の関数本文はドル引用 (`AS $function$ … $function$`) なので、その
 *   ままでは本文ごと消える。ドル引用の中身を再帰的にマスクし直して戻す。
 *
 * 動的 SQL (`EXECUTE 'SELECT … FROM orders'`) の中の参照は文字列リテラルなので
 * 検出できない (既知の限界として UI で明示する)。
 */

import type { SchemaObject, SchemaObjectKind, Snippet } from "../api/tauri";
import { maskLiterals } from "../dangerousSql";
import { mapLimited } from "./mapLimited";

/** 検索対象。`column` が null ならテーブル (またはビュー) そのものへの参照を探す。 */
export interface WhereUsedTarget {
  /** ツリーの「データベース」ノード名 (PostgreSQL はスキーマ、MSSQL はデータベース)。 */
  database: string;
  table: string;
  column: string | null;
}

/** 参照の確からしさ。`possible` は「対象テーブルとの結び付きを確認できなかった」候補。 */
export type ReferenceConfidence = "direct" | "possible";

export interface ReferenceHit {
  start: number;
  end: number;
  confidence: ReferenceConfidence;
}

/** 表示用に 1 行へまとめた該当箇所。`ranges` は `text` 内のオフセット。 */
export interface ReferenceLine {
  /** 1 始まりの行番号。 */
  line: number;
  text: string;
  ranges: [number, number][];
  /** 長い行の先頭 / 末尾を省略したか (表示側で「…」を付ける)。 */
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface DefinitionAnalysis {
  confidence: ReferenceConfidence;
  hitCount: number;
  lines: ReferenceLine[];
}

// ---------------------------------------------------------------------------
// ドライバ別の縮退表
// ---------------------------------------------------------------------------

const ALL_KINDS: readonly SchemaObjectKind[] = [
  "view",
  "materialized_view",
  "procedure",
  "function",
  "trigger",
];

/**
 * ドライバごとに定義本文を取得できるオブジェクト種別。`list_schema_objects` /
 * `get_object_definition` のドライバ実装 (`src-tauri/src/db/*.rs`) と対応する。
 *
 * - MySQL: ビュー / プロシージャ / 関数 / トリガー (`SHOW CREATE …`)
 * - PostgreSQL: 上記 + マテリアライズドビュー (`pg_get_viewdef` / `pg_get_functiondef` /
 *   `pg_get_triggerdef`)。トリガー本文はトリガー関数側にあるので関数として走査される。
 * - SQLite: ビュー / トリガーのみ (ストアドルーチンが存在しない。`sqlite_master.sql`)
 * - DuckDB: ビューのみ (プロシージャ / トリガーが無い。マクロはルーチンとして
 *   一覧していない)
 * - MSSQL: ビュー / プロシージャ / 関数 / トリガー (`OBJECT_DEFINITION`、`dbo` のみ。
 *   `WITH ENCRYPTION` のオブジェクトは本文が取れず「定義を取得できない」に数える)
 */
export const WHERE_USED_KIND_SUPPORT: Readonly<Record<string, readonly SchemaObjectKind[]>> = {
  mysql: ["view", "procedure", "function", "trigger"],
  postgres: ALL_KINDS,
  sqlite: ["view", "trigger"],
  duckdb: ["view"],
  mssql: ["view", "procedure", "function", "trigger"],
};

/**
 * このドライバでは走査できない (存在しない / 取得できない) 種別。UI の縮退表示用。
 * マテリアライズドビューは PostgreSQL 以外に存在しない種別なので、毎回ノイズに
 * ならないよう挙げない。
 */
export function unsupportedWhereUsedKinds(driver: string): SchemaObjectKind[] {
  const supported = WHERE_USED_KIND_SUPPORT[driver] ?? ALL_KINDS;
  return ALL_KINDS.filter((k) => k !== "materialized_view" && !supported.includes(k));
}

/**
 * テーブル名の修飾子として「対象と同じスキーマ / DB」を意味する名前 (小文字)。
 * MSSQL はスキーマを `dbo` 固定で扱う (`db.dbo.t` / `dbo.t`)。SQLite の既定
 * スキーマは `main`、DuckDB の既定カタログ内スキーマは `main`。
 */
export function tableQualifiers(driver: string, database: string): string[] {
  const out = new Set<string>();
  if (database) out.add(database.toLowerCase());
  if (driver === "mssql") out.add("dbo");
  if (driver === "sqlite") out.add("main");
  return [...out];
}

// ---------------------------------------------------------------------------
// マスク (maskLiterals の再利用)
// ---------------------------------------------------------------------------

function doubleQuoteIsIdentifier(driver: string | undefined): boolean {
  return driver !== "mysql";
}

function bracketIsIdentifier(driver: string | undefined): boolean {
  return driver === "mssql" || driver === "sqlite";
}

const WORD = /[\p{L}\p{N}_$]/u;
const WORD_START = /[\p{L}_]/u;
/** ドル引用の開始タグ (`$$` / `$tag$`)。sticky で `lastIndex` の位置だけを見る。 */
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/**
 * コメントと文字列リテラルだけを空白にし、引用識別子とドル引用の本文 (PostgreSQL
 * の関数本体) はコードとして残した同じ長さの文字列を返す。オフセットは元の SQL と
 * 一致するので、ヒット位置で元の文字列を切り出せる。
 */
export function prepareForReferenceScan(sql: string, driver?: string): string {
  const masked = maskLiterals(sql, driver);
  const out = masked.split("");
  const n = masked.length;
  let i = 0;
  while (i < n) {
    const c = masked[i];
    // 引用識別子: maskLiterals は区切り文字を残して中身だけ空白にする。区切り
    // 文字はマスク後の文字列にしか現れない (コメント/リテラル内はすべて空白) ので、
    // 次に現れる同じ文字が閉じ区切り。中身を元の文字列から書き戻す。
    if (c === "`" || (c === '"' && doubleQuoteIsIdentifier(driver))) {
      const close = masked.indexOf(c, i + 1);
      if (close === -1) break;
      for (let k = i + 1; k < close; k++) out[k] = sql[k];
      i = close + 1;
      continue;
    }
    if (c === "$" && (i === 0 || !WORD.test(masked[i - 1]))) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(masked);
      if (m) {
        const tag = m[0];
        const close = masked.indexOf(tag, i + tag.length);
        if (close !== -1) {
          // ドル引用の中身 (PL/pgSQL / SQL 関数の本体) を改めて走査用にマスクする。
          const inner = prepareForReferenceScan(sql.slice(i + tag.length, close), driver);
          for (let k = 0; k < inner.length; k++) out[i + tag.length + k] = inner[k];
          i = close + tag.length;
          continue;
        }
      }
    }
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// トークン化
// ---------------------------------------------------------------------------

interface IdentToken {
  /** 引用を外し、二重化エスケープを解除した名前。 */
  name: string;
  start: number;
  end: number;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** `pos` から識別子 1 つを読む。識別子でなければ null。 */
function readIdent(text: string, pos: number, driver: string | undefined): IdentToken | null {
  const c = text[pos];
  if (c === undefined) return null;
  const quoted = (close: string): IdentToken | null => {
    let j = pos + 1;
    let name = "";
    while (j < text.length) {
      if (text[j] === close) {
        if (text[j + 1] === close) {
          name += close;
          j += 2;
          continue;
        }
        const trimmed = name.trim();
        return trimmed ? { name, start: pos, end: j + 1 } : null;
      }
      name += text[j];
      j++;
    }
    return null;
  };
  if (c === "`") return quoted("`");
  if (c === '"' && doubleQuoteIsIdentifier(driver)) return quoted('"');
  if (c === "[" && bracketIsIdentifier(driver)) return quoted("]");
  if (WORD_START.test(c)) {
    let j = pos + 1;
    while (j < text.length && WORD.test(text[j])) j++;
    return { name: text.slice(pos, j), start: pos, end: j };
  }
  return null;
}

/**
 * 識別子のドット連鎖 (`a.b.c`) を列挙する。各要素は連鎖を構成するトークン列と、
 * 連鎖の直後に続く「別名候補」トークン (`FROM orders o` の `o`、`AS` は読み飛ばす)。
 */
interface IdentChain {
  parts: IdentToken[];
  next: IdentToken | null;
}

function skipSpaces(text: string, pos: number): number {
  let j = pos;
  while (j < text.length && isSpace(text[j])) j++;
  return j;
}

function tokenizeChains(text: string, driver: string | undefined): IdentChain[] {
  const chains: IdentChain[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    // 変数・バインド・位置パラメータ・数値は識別子として扱わず語ごと読み飛ばす。
    if (c === "@" || (c === ":" && text[i + 1] !== ":" && text[i - 1] !== ":") || c === "$" || /[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && (text[j] === "@" || WORD.test(text[j]))) j++;
      i = j;
      continue;
    }
    const tok = readIdent(text, i, driver);
    if (!tok) {
      i++;
      continue;
    }
    const parts = [tok];
    let end = tok.end;
    for (;;) {
      const dot = skipSpaces(text, end);
      if (text[dot] !== ".") break;
      const after = skipSpaces(text, dot + 1);
      const nextTok = readIdent(text, after, driver);
      if (!nextTok) {
        end = dot + 1;
        break;
      }
      parts.push(nextTok);
      end = nextTok.end;
    }
    chains.push({ parts, next: null });
    i = end;
  }
  // 別名候補は「連鎖の直後の単独トークン」。連鎖同士の隣接関係から埋める。
  for (let k = 0; k + 1 < chains.length; k++) {
    const cur = chains[k];
    const last = cur.parts[cur.parts.length - 1];
    let cand = chains[k + 1];
    const between = text.slice(last.end, cand.parts[0].start);
    if (between.trim() !== "") continue;
    if (cand.parts.length === 1 && cand.parts[0].name.toLowerCase() === "as" && k + 2 < chains.length) {
      const afterAs = chains[k + 2];
      if (text.slice(cand.parts[0].end, afterAs.parts[0].start).trim() !== "") continue;
      cand = afterAs;
    }
    if (cand.parts.length === 1 && !ALIAS_STOPWORDS.has(cand.parts[0].name.toLowerCase())) {
      cur.next = cand.parts[0];
    }
  }
  return chains;
}

/** テーブル名の直後に来ても別名ではない語。 */
const ALIAS_STOPWORDS = new Set([
  "as", "on", "using", "where", "join", "inner", "left", "right", "full", "outer", "cross",
  "natural", "lateral", "set", "values", "select", "from", "group", "order", "having",
  "limit", "offset", "fetch", "union", "intersect", "except", "returning", "window",
  "for", "when", "then", "else", "end", "begin", "before", "after", "instead", "of",
  "each", "row", "execute", "with", "into", "default", "and", "or", "not", "is", "in",
  "partition", "tablesample", "straight_join", "force", "use", "ignore", "loop",
  "declare", "if", "return", "returns", "language", "referencing", "update", "insert",
  "delete", "by", "asc", "desc", "nulls", "window", "procedure", "function",
]);

// ---------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 定義本文 (元の SQL) から対象への参照位置を返す。オフセットは `sql` 上の位置。
 * テーブル検索ではテーブル参照、列検索では列参照を返す。
 */
export function findReferences(
  sql: string,
  target: WhereUsedTarget,
  driver?: string,
): ReferenceHit[] {
  const text = prepareForReferenceScan(sql, driver);
  const chains = tokenizeChains(text, driver);
  const qualifiers = tableQualifiers(driver ?? "", target.database);
  const isOurQualifier = (q: IdentToken) => qualifiers.includes(q.name.toLowerCase());

  // テーブル参照 (列検索でも「本文が対象テーブルを参照しているか」の判定に使う)。
  const tableHits: ReferenceHit[] = [];
  const aliases = new Set<string>();
  for (const { parts, next } of chains) {
    const L = parts.length;
    for (const idx of [L - 1, L - 2]) {
      if (idx < 0 || !eq(parts[idx].name, target.table)) continue;
      const qual = idx > 0 ? parts[idx - 1] : null;
      if (qual && !isOurQualifier(qual)) continue;
      tableHits.push({ start: parts[idx].start, end: parts[idx].end, confidence: "direct" });
      if (idx === L - 1 && next) aliases.add(next.name.toLowerCase());
      break;
    }
  }
  if (target.column === null) return tableHits;

  const referencesTable = tableHits.length > 0;
  const column = target.column;
  const colHits: ReferenceHit[] = [];
  for (const { parts } of chains) {
    const L = parts.length;
    const last = parts[L - 1];
    if (!eq(last.name, column)) continue;
    if (L === 1) {
      colHits.push({ start: last.start, end: last.end, confidence: referencesTable ? "direct" : "possible" });
      continue;
    }
    const qual = parts[L - 2];
    const qualIsTable = eq(qual.name, target.table);
    if (qualIsTable) {
      // `s.orders.col` なら s が同じスキーマのときだけ。`orders.col` はそのまま。
      if (L >= 3 && !isOurQualifier(parts[L - 3])) continue;
      colHits.push({ start: last.start, end: last.end, confidence: "direct" });
      continue;
    }
    // `s.other.col` — スキーマ修飾された別テーブルと確定できるので除外。
    if (L >= 3) continue;
    if (aliases.has(qual.name.toLowerCase())) {
      colHits.push({ start: last.start, end: last.end, confidence: "direct" });
      continue;
    }
    // 別名が解決できない (サブクエリ別名・トリガーの NEW/OLD など)。見落としより
    // 誤検出の方が安全なので残し、テーブル参照の有無で確からしさを分ける。
    colHits.push({ start: last.start, end: last.end, confidence: referencesTable ? "direct" : "possible" });
  }
  return colHits;
}

/** 長い行を表示するときの最大文字数。ヒット周辺を切り出す。 */
const MAX_LINE_CHARS = 160;

/** ヒット位置を行単位にまとめる (行番号・前後の空白を落とした本文・行内の範囲)。 */
export function toReferenceLines(sql: string, hits: readonly ReferenceHit[]): ReferenceLine[] {
  if (hits.length === 0) return [];
  const lineStarts = [0];
  for (let i = 0; i < sql.length; i++) if (sql[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const byLine = new Map<number, [number, number][]>();
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    const ln = lineOf(h.start);
    const list = byLine.get(ln) ?? [];
    list.push([h.start - lineStarts[ln], h.end - lineStarts[ln]]);
    byLine.set(ln, list);
  }
  const out: ReferenceLine[] = [];
  for (const [ln, ranges] of byLine) {
    const startPos = lineStarts[ln];
    const endPos = ln + 1 < lineStarts.length ? lineStarts[ln + 1] - 1 : sql.length;
    const raw = sql.slice(startPos, endPos).replace(/\r$/, "");
    const lead = raw.length - raw.trimStart().length;
    let text = raw.trim();
    let shifted = ranges.map(([s, e]) => [s - lead, e - lead] as [number, number]);
    let clippedStart = false;
    let clippedEnd = false;
    if (text.length > MAX_LINE_CHARS) {
      const from = Math.max(0, Math.min(shifted[0][0] - 40, text.length - MAX_LINE_CHARS));
      const to = from + MAX_LINE_CHARS;
      clippedStart = from > 0;
      clippedEnd = to < text.length;
      text = text.slice(from, to);
      shifted = shifted
        .map(([s, e]) => [s - from, Math.min(e - from, MAX_LINE_CHARS)] as [number, number])
        .filter(([s]) => s >= 0 && s < MAX_LINE_CHARS);
    }
    out.push({ line: ln + 1, text, ranges: shifted, clippedStart, clippedEnd });
  }
  return out;
}

/** 行テキストを「強調する / しない」区間に分ける (描画用。範囲の重なり・逆順を吸収する)。 */
export function splitHighlightSegments(
  text: string,
  ranges: readonly [number, number][],
): { text: string; hit: boolean }[] {
  const sorted = [...ranges]
    .map(([s, e]) => [Math.max(0, s), Math.min(text.length, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of sorted) {
    if (e <= pos) continue;
    const from = Math.max(s, pos);
    if (from > pos) out.push({ text: text.slice(pos, from), hit: false });
    out.push({ text: text.slice(from, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** 1 つの定義本文を解析する。参照が無ければ null。 */
export function analyzeDefinition(
  sql: string,
  target: WhereUsedTarget,
  driver?: string,
): DefinitionAnalysis | null {
  const hits = findReferences(sql, target, driver);
  if (hits.length === 0) return null;
  return {
    confidence: hits.some((h) => h.confidence === "direct") ? "direct" : "possible",
    hitCount: hits.length,
    lines: toReferenceLines(sql, hits),
  };
}

// ---------------------------------------------------------------------------
// 走査のオーケストレーション
// ---------------------------------------------------------------------------

export interface WhereUsedMatch extends DefinitionAnalysis {
  source: "object" | "snippet";
  /** オブジェクト種別。スニペットは "snippet"。 */
  kind: SchemaObjectKind | "snippet";
  name: string;
  /** スキーマオブジェクトの一意識別子 (`get_object_definition` へそのまま渡す)。 */
  id: string | null;
  /** スニペットの ID (スニペットのときだけ)。 */
  snippetId: string | null;
}

export interface WhereUsedFailure {
  kind: SchemaObjectKind;
  name: string;
  error: string;
}

export interface WhereUsedReport {
  matches: WhereUsedMatch[];
  /** 定義を走査できたオブジェクト数 (スニペットを除く)。 */
  scannedObjects: number;
  scannedSnippets: number;
  /** 定義の取得に失敗したオブジェクト (権限不足など)。 */
  failed: WhereUsedFailure[];
  /** 定義本文が空で返ったオブジェクト (MSSQL の暗号化オブジェクトなど)。 */
  emptyDefinitions: { kind: SchemaObjectKind; name: string }[];
  /** キャンセルされ、途中までの結果であること。 */
  cancelled: boolean;
}

export interface WhereUsedProgress {
  done: number;
  total: number;
}

export interface WhereUsedScanOptions {
  driver: string;
  target: WhereUsedTarget;
  listObjects: () => Promise<SchemaObject[]>;
  getDefinition: (obj: SchemaObject) => Promise<string>;
  /** 走査するスニペット (接続中プロファイルのスコープで絞り込み済みのもの)。 */
  snippets: readonly Snippet[];
  signal?: AbortSignal;
  onProgress?: (p: WhereUsedProgress) => void;
  /** 定義取得の同時実行数。既定 4 (大きなスキーマで往復を詰め込みすぎない)。 */
  concurrency?: number;
}

const KIND_ORDER: Record<WhereUsedMatch["kind"], number> = {
  view: 0,
  materialized_view: 1,
  procedure: 2,
  function: 3,
  trigger: 4,
  snippet: 5,
};

/** 表示順: 直接参照 → 候補、その中で種別順 → 名前順。 */
export function sortWhereUsedMatches(matches: readonly WhereUsedMatch[]): WhereUsedMatch[] {
  return [...matches].sort(
    (a, b) =>
      (a.confidence === b.confidence ? 0 : a.confidence === "direct" ? -1 : 1) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name),
  );
}

/** スニペットがこの接続のドライバで使えるものか (ドライバ未指定は全ドライバ共通)。 */
export function snippetAppliesToDriver(snippet: Snippet, driver: string): boolean {
  return snippet.driver === null || snippet.driver === driver;
}

/**
 * 全ビュー / ルーチン / トリガーの定義とスニペットを走査する。個々の定義取得の
 * 失敗は全体を止めず `failed` に集める (権限の無いオブジェクトがあっても残りは
 * 調べられるように)。`signal` が中断されたら未取得の定義は取りに行かず、そこまでの
 * 結果を `cancelled: true` で返す。
 */
export async function runWhereUsedScan(opts: WhereUsedScanOptions): Promise<WhereUsedReport> {
  const { driver, target, signal } = opts;
  const supported = WHERE_USED_KIND_SUPPORT[driver] ?? ALL_KINDS;
  const all = await opts.listObjects();
  // 対象自身 (ビューを検索したときのそのビュー) は自分の CREATE 文にヒットするので除く。
  const objects = all.filter(
    (o) =>
      supported.includes(o.kind) &&
      !(target.column === null &&
        (o.kind === "view" || o.kind === "materialized_view") &&
        eq(o.name, target.table)),
  );
  const total = objects.length;
  let done = 0;
  opts.onProgress?.({ done, total });

  const matches: WhereUsedMatch[] = [];
  const failed: WhereUsedFailure[] = [];
  const emptyDefinitions: { kind: SchemaObjectKind; name: string }[] = [];
  let scannedObjects = 0;

  await mapLimited(objects, opts.concurrency ?? 4, async (obj) => {
    if (signal?.aborted) return;
    try {
      const def = await opts.getDefinition(obj);
      if (signal?.aborted) return;
      scannedObjects++;
      if (!def.trim()) {
        emptyDefinitions.push({ kind: obj.kind, name: obj.name });
      } else {
        const a = analyzeDefinition(def, target, driver);
        if (a) {
          matches.push({ ...a, source: "object", kind: obj.kind, name: obj.name, id: obj.id, snippetId: null });
        }
      }
    } catch (e) {
      failed.push({ kind: obj.kind, name: obj.name, error: String(e) });
    } finally {
      done++;
      opts.onProgress?.({ done, total });
    }
  });

  const cancelled = signal?.aborted ?? false;
  let scannedSnippets = 0;
  if (!cancelled) {
    for (const s of opts.snippets) {
      if (!snippetAppliesToDriver(s, driver)) continue;
      scannedSnippets++;
      const a = analyzeDefinition(s.sql, target, driver);
      if (a) {
        matches.push({ ...a, source: "snippet", kind: "snippet", name: s.name, id: null, snippetId: s.id });
      }
    }
  }

  return {
    matches: sortWhereUsedMatches(matches),
    scannedObjects,
    scannedSnippets,
    failed,
    emptyDefinitions,
    cancelled,
  };
}
