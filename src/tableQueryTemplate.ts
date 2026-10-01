// テーブルを開いたときのデフォルトクエリ (テンプレート) の純ロジック (#1253)。
//
// 既定ではテーブルを開くと `SELECT * FROM <table> LIMIT n` を実行する。設定で
// プレースホルダ付きのテンプレート (例: `SELECT * FROM {table} ORDER BY {pk} DESC
// LIMIT {limit}`) を指定すると、そのクエリで開く。ここではテンプレートの
// 検証・展開・解決順序 (テーブル別の上書き > 全体 > 従来) と、展開後の SQL から
// 「編集してよいか」「キーセット・ページネーションを使えるか」「サーバ側の
// ソート/フィルタを付けるときに包む必要があるか」を判定する。副作用がないので
// Vitest で境界を固定する (`__tests__/tableQueryTemplate.test.ts`)。
//
// 設計上の決定:
// - 不正なテンプレートは保存時に拒否し (`validateTableQueryTemplate`)、実行時にも
//   再検証して通らなければ従来クエリへフォールバックする (二重の安全策)。
// - 行を特定できる形 (単一テーブル + 主キー列 / rowid・ctid を含む SELECT) を
//   満たさないテンプレートは読み取り専用で開く。誤った行を書き換えないよう、
//   結果を見てからの再判定はしない。
// - `{pk}` は複合主キーなら全列をカンマ連結する。主キーが無ければ SQLite の
//   `rowid` / PostgreSQL の `ctid` を使い、どちらも無い (MySQL など) 場合は
//   テンプレート全体を従来クエリへフォールバックする。
// - キーセット (#1150) は「WHERE 等が無く、ORDER BY が無いか主キーの昇順だけ」の
//   ときだけ使う。それ以外は LIMIT/OFFSET 方式にする。
import { isReadOnlySql, maskLiterals, trimTrailingSeparators } from "./dangerousSql";
import { quoteIdentFor } from "./components/sqlDialect";

/** テンプレートで使えるプレースホルダ。 */
export const TABLE_QUERY_PLACEHOLDERS = [
  "database",
  "table",
  "table_name",
  "limit",
  "pk",
] as const;
export type TableQueryPlaceholder = (typeof TABLE_QUERY_PLACEHOLDERS)[number];

/** 保存できるテンプレートの最大長 (設定ストアを肥大化させない)。 */
export const MAX_TABLE_QUERY_TEMPLATE_LENGTH = 4000;

export type TableQueryTemplateError =
  | { kind: "unknownPlaceholder"; name: string }
  | { kind: "multipleStatements" }
  | { kind: "notSelect" }
  | { kind: "syntax" }
  | { kind: "tooLong" };

/** テーブル別の上書き。秘密情報は含まない (設定ストアに保存してよい)。 */
export interface TableOpenQueryOverride {
  profileId: string;
  /** 設定画面の一覧表示用。保存時点のプロファイル名。 */
  profileName: string;
  database: string;
  table: string;
  template: string;
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface PlaceholderHit {
  start: number;
  end: number;
  name: string;
}

/**
 * テンプレート中のプレースホルダを位置付きで返す。文字列リテラル・コメント・
 * クォート識別子の中の `{...}` はマスクされるので対象にならない (JSON リテラル等を
 * 誤って置換しない)。
 */
function findPlaceholders(template: string, driver?: string): PlaceholderHit[] {
  const masked = maskLiterals(template, driver);
  const hits: PlaceholderHit[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(masked)) !== null) {
    hits.push({ start: m.index, end: m.index + m[0].length, name: m[1] });
  }
  return hits;
}

function isKnownPlaceholder(name: string): name is TableQueryPlaceholder {
  return (TABLE_QUERY_PLACEHOLDERS as readonly string[]).includes(name);
}

/** テンプレートが `{name}` を (リテラル外で) 使っているか。 */
export function templateUsesPlaceholder(
  template: string,
  name: TableQueryPlaceholder,
  driver?: string,
): boolean {
  return findPlaceholders(template, driver).some((h) => h.name === name);
}

function substitute(
  template: string,
  values: Record<TableQueryPlaceholder, string>,
  driver?: string,
): string {
  const hits = findPlaceholders(template, driver);
  let out = "";
  let pos = 0;
  for (const h of hits) {
    out += template.slice(pos, h.start);
    out += isKnownPlaceholder(h.name) ? values[h.name] : template.slice(h.start, h.end);
    pos = h.end;
  }
  return out + template.slice(pos);
}

/**
 * 引用符・コメントが閉じていて、括弧の対応が取れているか。構文として成立しない
 * テンプレートを保存時に弾くための軽量チェック (SQL パーサではない)。
 */
function isBalanced(sql: string): boolean {
  let depth = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "\\" && c === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          // 二重化した引用符はエスケープ。
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return false;
      i = j + 1;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth < 0) return false;
    }
    i++;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// トップレベルの句の解析
// ---------------------------------------------------------------------------

interface TopLevelWord {
  word: string;
  start: number;
  end: number;
}

/** マスク済み SQL から、括弧の外 (深さ 0) にある単語と `,` / `*` の位置を返す。 */
function topLevelWords(masked: string): TopLevelWord[] {
  const out: TopLevelWord[] = [];
  let depth = 0;
  const re = /[A-Za-z_][A-Za-z0-9_$]*|[(),*;]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const w = m[0];
    if (w === "(") {
      depth++;
      continue;
    }
    if (w === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out.push({ word: w.toLowerCase(), start: m.index, end: m.index + w.length });
  }
  return out;
}

/** FROM 以降の区切りになる句のキーワード。 */
const CLAUSE_KEYWORDS = new Set([
  "where",
  "group",
  "having",
  "order",
  "limit",
  "offset",
  "fetch",
  "window",
  "union",
  "intersect",
  "except",
  "for",
]);
const JOIN_KEYWORDS = new Set(["join", "inner", "left", "right", "full", "cross", "natural", "straight_join"]);

interface TemplateShape {
  /** SELECT と FROM の間 (選択リスト) の元テキスト。 */
  selectList: string;
  /** DISTINCT / ALL の有無 (先頭)。 */
  distinct: boolean;
  /** FROM 直後のテーブル参照 (次の句まで) の元テキスト。 */
  fromSegment: string;
  /** FROM 直後に結合・カンマがあるか。 */
  hasJoin: boolean;
  /** FROM 以降に現れたトップレベル句 (小文字キーワード → 開始位置)。 */
  clauses: Map<string, number>;
  /** LIMIT/OFFSET/FETCH のうち最も手前の位置 (無ければ null)。 */
  limitStart: number | null;
}

/** 展開後の単一 SELECT から構造を取り出す。解析できなければ null。 */
function analyzeShape(sql: string, driver?: string): TemplateShape | null {
  const masked = maskLiterals(sql, driver);
  const words = topLevelWords(masked);
  if (words.length === 0 || words[0].word !== "select") return null;
  const fromIdx = words.findIndex((w) => w.word === "from");
  if (fromIdx < 0) return null;
  const from = words[fromIdx];
  const clauses = new Map<string, number>();
  let hasJoin = false;
  let segEnd = sql.length;
  for (let k = fromIdx + 1; k < words.length; k++) {
    const w = words[k];
    if (CLAUSE_KEYWORDS.has(w.word)) {
      if (!clauses.has(w.word)) clauses.set(w.word, w.start);
      if (segEnd === sql.length) segEnd = w.start;
      continue;
    }
    if (segEnd === sql.length && (JOIN_KEYWORDS.has(w.word) || w.word === ",")) hasJoin = true;
  }
  const limitCandidates = ["limit", "offset", "fetch"]
    .map((k) => clauses.get(k))
    .filter((v): v is number => v !== undefined);
  const second = words[1]?.word;
  return {
    selectList: sql.slice(words[0].end, from.start),
    distinct: second === "distinct" || second === "distinctrow",
    fromSegment: sql.slice(from.end, segEnd),
    hasJoin,
    clauses,
    limitStart: limitCandidates.length > 0 ? Math.min(...limitCandidates) : null,
  };
}

/** トップレベルのカンマで区切る (マスク済みテキストで位置を決め、元テキストを切る)。 */
function splitTopLevelCommas(text: string, driver?: string): string[] {
  const masked = maskLiterals(text, driver);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** 引用符を外した識別子の並び (`"db"."t"` → `db.t`)。空白を含むなら null。 */
function normalizeIdentPath(text: string): string | null {
  const s = text.trim();
  if (!s || /\s/.test(s.replace(/"[^"]*"|`[^`]*`/g, "x"))) return null;
  const parts: string[] = [];
  const re = /"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|([^.]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) return null;
    if (m[1] !== undefined) parts.push(m[1].replace(/""/g, '"'));
    else if (m[2] !== undefined) parts.push(m[2].replace(/``/g, "`"));
    else parts.push(m[3]);
    consumed = re.lastIndex;
    if (s[consumed] === ".") consumed++;
    re.lastIndex = consumed;
  }
  if (consumed !== s.length) return null;
  return parts.join(".");
}

function lastPathPart(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
}

/** FROM のテーブル参照が開こうとしているテーブル自身か (引用符の有無は問わない)。 */
function isTargetTable(fromSegment: string, driver: string, database: string, table: string): boolean {
  const path = normalizeIdentPath(fromSegment);
  if (path === null) return false;
  if (path === table) return true;
  return driver !== "sqlite" && path === `${database}.${table}`;
}

/**
 * ORDER BY 句が「主キー列をその順で昇順に並べるだけ」か。キーセット・ページネーション
 * (#1150) は主キー昇順を前提にしているので、これ以外の並びは OFFSET に回す。
 * `orderBody` は `ORDER BY` の後ろ (キーワード自体は含まない) の元テキスト。
 */
export function isPrimaryKeyAscOrder(orderBody: string, pkColumns: string[], driver?: string): boolean {
  if (pkColumns.length === 0) return false;
  const items = splitTopLevelCommas(orderBody, driver);
  if (items.length !== pkColumns.length) return false;
  return items.every((item, i) => {
    const m = /^(.*?)(?:\s+(asc))?$/i.exec(item.trim());
    if (!m) return false;
    const path = normalizeIdentPath(m[1]);
    return path !== null && lastPathPart(path) === pkColumns[i];
  });
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

/** 検証用のダミー値 (構文判定にだけ使う)。 */
const DUMMY_VALUES: Record<TableQueryPlaceholder, string> = {
  database: "noobdb_db",
  table: "noobdb_table",
  table_name: "noobdb_table",
  limit: "100",
  pk: "noobdb_pk",
};

function checkExpanded(sql: string, driver?: string): TableQueryTemplateError | null {
  if (!isBalanced(sql)) return { kind: "syntax" };
  const masked = trimTrailingSeparators(maskLiterals(sql, driver));
  if (masked.includes(";")) return { kind: "multipleStatements" };
  const body = masked.trim().toLowerCase();
  if (!/^select\b/.test(body)) return { kind: "notSelect" };
  if (!isReadOnlySql(sql, driver)) return { kind: "notSelect" };
  if (!analyzeShape(trimTrailingSeparators(sql), driver)) return { kind: "syntax" };
  return null;
}

/**
 * 保存前の検証。空文字列は「未設定 (従来クエリ)」なので有効。拒否するのは
 * 未知のプレースホルダ・複数文・SELECT 以外 (更新系・DDL・ロック句)・
 * 構文として成立しないもの (引用符/括弧の不一致・FROM が無い)。
 */
export function validateTableQueryTemplate(
  template: string,
  driver?: string,
): TableQueryTemplateError | null {
  if (template.trim() === "") return null;
  if (template.length > MAX_TABLE_QUERY_TEMPLATE_LENGTH) return { kind: "tooLong" };
  for (const h of findPlaceholders(template, driver)) {
    if (!isKnownPlaceholder(h.name)) return { kind: "unknownPlaceholder", name: h.name };
  }
  return checkExpanded(substitute(template, DUMMY_VALUES, driver), driver);
}

// ---------------------------------------------------------------------------
// 解決と展開
// ---------------------------------------------------------------------------

/** 2 つのテーブル参照が同じ上書き対象か。 */
function overrideMatches(
  o: TableOpenQueryOverride,
  profileId: string,
  database: string,
  table: string,
): boolean {
  return o.profileId === profileId && o.database === database && o.table === table;
}

/** テーブル別の上書きを探す。 */
export function findTableOpenQueryOverride(
  overrides: readonly TableOpenQueryOverride[],
  profileId: string | null | undefined,
  database: string,
  table: string,
): TableOpenQueryOverride | null {
  if (!profileId) return null;
  return overrides.find((o) => overrideMatches(o, profileId, database, table)) ?? null;
}

/**
 * 使うテンプレートを解決する: テーブル別の上書き > 全体テンプレート > 従来 (null)。
 * 空のテンプレートは未設定扱いで次へ進む。
 */
export function resolveTableOpenTemplate(
  globalTemplate: string,
  overrides: readonly TableOpenQueryOverride[],
  profileId: string | null | undefined,
  database: string,
  table: string,
): { template: string; source: "override" | "global" } | null {
  const o = findTableOpenQueryOverride(overrides, profileId, database, table);
  if (o && o.template.trim() !== "") return { template: o.template, source: "override" };
  if (globalTemplate.trim() !== "") return { template: globalTemplate, source: "global" };
  return null;
}

/**
 * 上書き一覧に 1 件を反映する (同じキーは置き換え、空テンプレートは削除)。
 * 元の配列は変更しない。
 */
export function upsertTableOpenQueryOverride(
  overrides: readonly TableOpenQueryOverride[],
  entry: TableOpenQueryOverride,
): TableOpenQueryOverride[] {
  const rest = overrides.filter((o) => !overrideMatches(o, entry.profileId, entry.database, entry.table));
  if (entry.template.trim() === "") return rest;
  return [...rest, { ...entry, template: entry.template.trim() }];
}

export interface TableOpenContext {
  driver: string;
  database: string;
  table: string;
  /** 1 ページの件数 (`{limit}`)。 */
  limit: number;
  /** 主キー列 (定義順)。 */
  pkColumns: string[];
  /** 主キーが無いときの行識別疑似列 (SQLite `rowid` / PostgreSQL `ctid`)。 */
  hiddenColumn: string | null;
}

export type TableOpenPlan =
  | { kind: "legacy" }
  | {
      kind: "template";
      /** 初回に実行する SQL。 */
      sql: string;
      /** ページネーションの土台 (LIMIT/OFFSET を持たない SELECT)。 */
      base: string;
      /** 行を特定できる形か。偽なら読み取り専用で開く。 */
      editable: boolean;
      /** キーセット・ページネーション (#1150) を使ってよいか。 */
      keyset: boolean;
      /**
       * サーバ側のソート/フィルタ (#792) を付けるとき、`base` を派生テーブルで包む
       * 必要があるか (`base` が既に WHERE / ORDER BY 等を持つ)。
       */
      wrapBrowse: boolean;
    };

/** テンプレートの各プレースホルダに入れる実際の値。`{pk}` が作れなければ空文字列。 */
function placeholderValues(ctx: TableOpenContext): Record<TableQueryPlaceholder, string> {
  const q = (s: string) => quoteIdentFor(ctx.driver, s);
  const tableRef =
    ctx.driver === "sqlite" ? q(ctx.table) : `${q(ctx.database)}.${q(ctx.table)}`;
  let pk: string | null = null;
  if (ctx.pkColumns.length > 0) pk = ctx.pkColumns.map(q).join(", ");
  else if (ctx.hiddenColumn && (ctx.driver === "sqlite" || ctx.driver === "postgres")) pk = ctx.hiddenColumn;
  return {
    database: q(ctx.database),
    table: tableRef,
    table_name: q(ctx.table),
    limit: String(Math.max(1, Math.floor(ctx.limit))),
    pk: pk ?? "",
  };
}

/** 選択リストが行を特定できる列を含むか。 */
function selectListIdentifiesRow(selectList: string, ctx: TableOpenContext): boolean {
  const items = splitTopLevelCommas(selectList, ctx.driver);
  const paths = items.map((it) => (it === "*" || /\.\*$/.test(it) ? "*" : normalizeIdentPath(it)));
  if (ctx.pkColumns.length > 0) {
    if (paths.includes("*")) return true;
    return ctx.pkColumns.every((pk) => paths.some((p) => p !== null && p !== "*" && lastPathPart(p) === pk));
  }
  if (ctx.hiddenColumn && (ctx.driver === "sqlite" || ctx.driver === "postgres")) {
    return paths.some((p) => p === ctx.hiddenColumn);
  }
  return false;
}

/**
 * テンプレートを展開し、テーブルタブの開き方を決める。テンプレートが無い・
 * 検証に通らない・`{pk}` を作れない場合は `legacy` (従来の `SELECT * ... LIMIT n`)。
 */
export function planTableOpenQuery(template: string | null, ctx: TableOpenContext): TableOpenPlan {
  if (!template || template.trim() === "") return { kind: "legacy" };
  if (validateTableQueryTemplate(template, ctx.driver)) return { kind: "legacy" };
  const values = placeholderValues(ctx);
  if (values.pk === "" && templateUsesPlaceholder(template, "pk", ctx.driver)) return { kind: "legacy" };
  const expanded = trimTrailingSeparators(substitute(template, values, ctx.driver)).trim();
  // 展開後の識別子 (クォート済みテーブル名など) で壊れていないかを再確認する。
  if (checkExpanded(expanded, ctx.driver)) return { kind: "legacy" };
  const shape = analyzeShape(expanded, ctx.driver);
  if (!shape) return { kind: "legacy" };

  const limit = values.limit;
  let base = shape.limitStart !== null ? expanded.slice(0, shape.limitStart).trimEnd() : expanded;
  const sql = shape.limitStart !== null ? expanded : `${expanded} LIMIT ${limit}`;

  const singleTable =
    !shape.hasJoin && isTargetTable(shape.fromSegment, ctx.driver, ctx.database, ctx.table);
  const blocking = ["where", "group", "having", "window", "union", "intersect", "except", "for"];
  const hasBlockingClause = blocking.some((k) => shape.clauses.has(k));
  const editable =
    singleTable &&
    !shape.distinct &&
    !["group", "having", "window", "union", "intersect", "except"].some((k) => shape.clauses.has(k)) &&
    selectListIdentifiesRow(shape.selectList, ctx);

  // キーセットは「単一テーブル・WHERE 等なし・ORDER BY 無しか主キー昇順のみ」。
  // その場合は ORDER BY を外した素の SELECT を土台にする (キーセット側が主キー順を付ける)。
  let keyset = false;
  const orderPos = shape.clauses.get("order");
  if (editable && ctx.pkColumns.length > 0 && !hasBlockingClause) {
    if (orderPos === undefined) {
      keyset = true;
    } else {
      const orderBody = base.slice(orderPos).replace(/^order\s+by\b/i, "");
      if (isPrimaryKeyAscOrder(orderBody, ctx.pkColumns, ctx.driver)) {
        keyset = true;
        base = base.slice(0, orderPos).trimEnd();
      }
    }
  }
  const baseShape = analyzeShape(base, ctx.driver);
  const wrapBrowse = !baseShape || baseShape.clauses.size > 0 || baseShape.hasJoin || shape.distinct;
  return { kind: "template", sql, base, editable, keyset, wrapBrowse };
}

/** 保存する上書きの最大件数。 */
const MAX_TABLE_OPEN_QUERY_OVERRIDES = 500;

/**
 * 永続化された上書き一覧を検証して取り込む (設定ストアの `normalizeSettings` 用)。
 * 形の壊れた要素・検証に通らないテンプレート・重複キーは捨てる。
 */
export function sanitizeTableOpenQueryOverrides(input: unknown): TableOpenQueryOverride[] {
  if (!Array.isArray(input)) return [];
  let out: TableOpenQueryOverride[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (
      typeof o.profileId !== "string" ||
      typeof o.database !== "string" ||
      typeof o.table !== "string" ||
      typeof o.template !== "string" ||
      o.profileId === "" ||
      o.table === "" ||
      o.template.trim() === "" ||
      validateTableQueryTemplate(o.template) !== null
    ) {
      continue;
    }
    out = upsertTableOpenQueryOverride(out, {
      profileId: o.profileId,
      profileName: typeof o.profileName === "string" ? o.profileName : "",
      database: o.database,
      table: o.table,
      template: o.template,
    });
    if (out.length >= MAX_TABLE_OPEN_QUERY_OVERRIDES) break;
  }
  return out;
}

/** テンプレートで開いたテーブルタブが持つ状態 (Tab.openTemplate)。 */
export interface TableOpenTemplateState {
  /** どの設定から来たか (バッジのツールチップ用)。 */
  source: "override" | "global";
  editable: boolean;
  keyset: boolean;
  wrapBrowse: boolean;
}

/**
 * `open_table` の結果 (従来の base / sql・列・行識別) にテンプレートを適用する。
 * テンプレートが無い・使えないときは従来の base / sql をそのまま返す。
 */
export function applyTableOpenTemplate(args: {
  resolved: { template: string; source: "override" | "global" } | null;
  driver: string;
  database: string;
  table: string;
  limit: number;
  columns: readonly { name: string; key: string }[];
  rowIdentity: { strategy: string; hidden_column: string | null } | null;
  legacyBase: string;
  legacySql: string;
}): { base: string; sql: string; openTemplate: TableOpenTemplateState | null } {
  const legacy = { base: args.legacyBase, sql: args.legacySql, openTemplate: null };
  if (!args.resolved) return legacy;
  const pkColumns = args.columns.filter((c) => c.key.toUpperCase() === "PRI").map((c) => c.name);
  const id = args.rowIdentity;
  const hiddenColumn =
    id && (id.strategy === "rowid" || id.strategy === "ctid") ? id.hidden_column : null;
  const plan = planTableOpenQuery(args.resolved.template, {
    driver: args.driver,
    database: args.database,
    table: args.table,
    limit: args.limit,
    pkColumns,
    hiddenColumn,
  });
  if (plan.kind === "legacy") return legacy;
  return {
    base: plan.base,
    sql: plan.sql,
    openTemplate: {
      source: args.resolved.source,
      editable: plan.editable,
      keyset: plan.keyset,
      wrapBrowse: plan.wrapBrowse,
    },
  };
}

/** 検証エラーを表示用の i18n キー + 差し込み値へ変換する。 */
export function tableQueryTemplateErrorMessage(
  err: TableQueryTemplateError,
): { key: TableQueryTemplateErrorKey; vars?: Record<string, string | number> } {
  switch (err.kind) {
    case "unknownPlaceholder":
      return { key: "tableOpenQueryErrorUnknownPlaceholder", vars: { name: `{${err.name}}` } };
    case "multipleStatements":
      return { key: "tableOpenQueryErrorMultiple" };
    case "notSelect":
      return { key: "tableOpenQueryErrorNotSelect" };
    case "tooLong":
      return { key: "tableOpenQueryErrorTooLong", vars: { max: MAX_TABLE_QUERY_TEMPLATE_LENGTH } };
    case "syntax":
      return { key: "tableOpenQueryErrorSyntax" };
  }
}

export type TableQueryTemplateErrorKey =
  | "tableOpenQueryErrorUnknownPlaceholder"
  | "tableOpenQueryErrorMultiple"
  | "tableOpenQueryErrorNotSelect"
  | "tableOpenQueryErrorTooLong"
  | "tableOpenQueryErrorSyntax";
