// 行の子レコードごとの複製 (#2304) の判定・整形の純ロジック。`CloneRowsModal` (副作用・描画) と対にする。
// どの行を集め、どの列をどう決めるかはバックエンド (`db/clone_rows.rs`) が持ち、ここは入力の検証と
// 表示用の整形だけを担う。

import type {
  CloneColumnRule,
  CloneRowsOutcome,
  CloneRowsPreview,
  CloneTablePreview,
  SubsetRequest,
} from "../api/tauri";
import type { I18nKey } from "../i18n";
import { parseBoundedInt, subsetMenuDisabledReason } from "./subsetExtract";

export const CLONE_DEFAULT_CHILD_DEPTH = 3;
export const CLONE_MAX_CHILD_DEPTH = 5;
export const CLONE_DEFAULT_CHILD_LIMIT = 1000;
export const CLONE_MAX_CHILD_LIMIT = 10_000;
/** 複製する行数の上限 (バックエンド `db::clone_rows::MAX_CLONE_ROWS` と揃える)。 */
export const CLONE_MAX_ROWS = 10_000;

export interface CloneInputs {
  sessionId: string;
  database: string | null;
  table: string;
  whereClause: string;
  rootLimit: number;
  childDepth: string;
  childLimit: string;
}

/** 入力から収集の指定を作る。数値が不正なら `null`。 */
export function buildCloneRequest(i: CloneInputs): SubsetRequest | null {
  const depth = parseBoundedInt(i.childDepth, 0, CLONE_MAX_CHILD_DEPTH);
  const limit = parseBoundedInt(i.childLimit, 1, CLONE_MAX_CHILD_LIMIT);
  if (depth === null || limit === null) return null;
  return {
    sourceSessionId: i.sessionId,
    sourceDatabase: i.database,
    table: i.table,
    whereClause: i.whereClause,
    rootRowLimit: i.rootLimit,
    childDepth: depth,
    childRowLimit: limit,
  };
}

/** プレビューが現在の指定 (収集 + 列の方針) のものか。変えたら取り直させる。 */
export function cloneKey(request: SubsetRequest | null, rules: CloneColumnRule[]): string | null {
  return request === null ? null : JSON.stringify({ request, rules });
}

export type RuleKind = "expression" | "value" | "null";

/** 入力欄から方針を作る。式 / 値が空なら `null` (NULL を選んだときは値が要らない)。 */
export function buildCloneRule(
  table: string,
  column: string,
  kind: RuleKind,
  text: string,
): CloneColumnRule | null {
  if (column === "") return null;
  if (kind === "null") return { table, column, rule: { kind: "literal", value: null } };
  if (kind === "value") return { table, column, rule: { kind: "literal", value: text } };
  const sql = text.trim();
  if (sql === "" || sql.includes(";")) return null;
  return { table, column, rule: { kind: "expression", sql } };
}

/**
 * 式の入力の誤りを文言キーで返す (バックエンド `db::clone_rows::validate_expression` と同じ字句検査)。
 * `;` と `{old}` は、文字列リテラル・引用識別子・コメントの外にだけ置ける。空欄は誤りではない。
 */
export function cloneExpressionError(text: string): I18nKey | null {
  if (text.trim() === "") return null;
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (comment !== null && text.startsWith("{old}", i)) return "cloneRowsErrOldInQuote";
    if (comment === "line") {
      if (c === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (c === "*" && next === "/") {
        comment = null;
        i++;
      }
      continue;
    }
    if (quote) {
      if (text.startsWith("{old}", i)) return "cloneRowsErrOldInQuote";
      if (c === quote) {
        // 引用符の重ね書き ('') は閉じない。
        if (next === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "-" && next === "-") comment = "line";
    else if (c === "/" && next === "*") comment = "block";
    else if (c === ";") return "cloneRowsErrSemicolon";
    else if (text.startsWith("{old}", i)) i += 4;
  }
  return null;
}

/** 同じ表・列の方針は後勝ち (置き換え) で足す。 */
export function upsertRule(rules: CloneColumnRule[], next: CloneColumnRule): CloneColumnRule[] {
  return [...rules.filter((r) => !(r.table === next.table && r.column === next.column)), next];
}

export function describeRule(r: CloneColumnRule): string {
  if (r.rule.kind === "expression") return r.rule.sql;
  return r.rule.value === null ? "NULL" : JSON.stringify(r.rule.value);
}

/** 実行を止める問題。 */
export type CloneBlocker =
  | { kind: "cycle"; tables: string[] }
  | { kind: "policy"; table: string }
  | { kind: "conflict"; table: string; index: string; columns: string[]; rows: number }
  | { kind: "empty" };

export function cloneBlockers(preview: CloneRowsPreview): CloneBlocker[] {
  const out: CloneBlocker[] = [];
  if (preview.totalRows === 0) out.push({ kind: "empty" });
  for (const c of preview.cycles) out.push({ kind: "cycle", tables: c });
  for (const t of preview.tables) {
    if (t.needsPolicy) out.push({ kind: "policy", table: t.table });
    for (const c of t.conflicts) {
      out.push({ kind: "conflict", table: t.table, index: c.index, columns: c.columns, rows: c.rows });
    }
  }
  return out;
}

export function keyStatusLabelKey(status: CloneTablePreview["keyColumns"][number]["status"]): I18nKey {
  switch (status) {
    case "auto":
      return "cloneKeyAuto";
    case "rule":
      return "cloneKeyRule";
    case "remapped":
      return "cloneKeyRemapped";
    case "unchanged":
      return "cloneKeyUnchanged";
  }
}

function cellText(v: unknown): string {
  return v === null || v === undefined ? "NULL" : String(v);
}

/** 旧キー → 新キーの対応表を TSV にする (表, 旧キー, 新キー。複合キーは `,` 区切り)。 */
export function mappingsToTsv(outcome: CloneRowsOutcome): string {
  const lines = ["table\told_key\tnew_key"];
  for (const t of outcome.tables) {
    for (const m of t.mappings) {
      lines.push(`${t.table}\t${m.oldKey.map(cellText).join(",")}\t${m.newKey.map(cellText).join(",")}`);
    }
  }
  return lines.join("\n");
}

/** 「子行ごと複製」メニューを無効にする理由の文言キー (主キーで行を特定できる表だけが対象)。 */
export function cloneMenuDisabledReason(
  input: Parameters<typeof subsetMenuDisabledReason>[0],
): I18nKey | null {
  const key = subsetMenuDisabledReason(input);
  return key === "gridExtractSubsetNoPk" ? "gridCloneRowsNoPk" : key;
}
