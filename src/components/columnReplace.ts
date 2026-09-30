import type { CellValue, Column } from "../api/tauri";
import type { BulkEditTarget } from "./bulkEdit";
import { editIsNoop, qualifiedTableRef, quoteString, rowEditKey } from "./cellEdit";
import { computeColumnMatchRows } from "./gridFind";
import { quoteIdentFor } from "./sqlDialect";

/**
 * 結果グリッド列の「検索して置換」(#1242) の純ロジック。
 *
 * 範囲は 2 モード:
 *
 * - **在グリッド (`planGridReplace`)**: 取得済み行のうち対象列のヒットセルだけを
 *   `gridFind.ts` の探索で見つけ、置換後の値を pending edit として積む
 *   (`bulkEdit.ts` と同じ `BulkEditTarget`)。SQL は `buildUpdateStatements` が
 *   PK 指定の個別 UPDATE として組み、`run_query_transaction` の all-or-nothing に乗る。
 * - **列全体 (`buildColumnReplaceSql`)**: 行を取得済みかに関わらず
 *   `UPDATE t SET c = REPLACE(c, 'a', 'b') WHERE ...` を 1 文で発行する。文字列 /
 *   識別子のエスケープは `cellEdit.ts` の `quoteString` / `qualifiedTableRef` を共有する。
 *
 * ## 方言差 (3 ドライバに固定)
 *
 * | 検索 | MySQL | PostgreSQL | SQLite |
 * |---|---|---|---|
 * | 通常 + 大小区別 | `REPLACE` | `REPLACE` | `REPLACE` |
 * | 通常 + 大小無視 | `REGEXP_REPLACE` (エスケープ済み) | `regexp_replace` | 非対応 |
 * | 正規表現 | `REGEXP_REPLACE` (MySQL 8) | `regexp_replace` | 非対応 |
 *
 * SQLite は組み込みの正規表現置換を持たないため、列全体モードでは正規表現・大小無視を
 * 無効化する (`columnReplaceUnsupported` が理由を返す)。
 *
 * DOM 非依存・副作用なしで Vitest から直接検証する (`__tests__/columnReplace.test.ts`)。
 */

export interface ReplaceOptions {
  /** true なら大文字小文字を区別する。 */
  caseSensitive: boolean;
  /** true なら検索文字列を正規表現として解釈する。 */
  regex: boolean;
}

/** 列全体モードが使えない理由 (UI が i18n キーへ写す)。 */
export type ColumnReplaceUnsupported = "sqliteRegex" | "sqliteCaseInsensitive";

/**
 * 列全体モードがこのドライバ + オプションで使えない理由。使えるなら null。
 * 通常の置換 (大小区別) は 3 ドライバとも `REPLACE` で表せる。
 */
export function columnReplaceUnsupported(
  driver: string,
  options: ReplaceOptions,
): ColumnReplaceUnsupported | null {
  if (driver !== "sqlite") return null;
  if (options.regex) return "sqliteRegex";
  if (!options.caseSensitive) return "sqliteCaseInsensitive";
  return null;
}

/**
 * 文字列置換 (`REPLACE`) が安全に効く列型か。数値・日付・JSON・バイナリなどは
 * `REPLACE` が型エラーになる (PostgreSQL) か暗黙変換で値を壊すため対象外にする。
 */
export function isTextColumnType(typeName: string): boolean {
  const t = typeName.trim().toLowerCase();
  if (t === "") return false;
  if (/blob|binary|bytea/.test(t)) return false;
  return /char|text|string|clob|citext|bpchar|^name$/.test(t);
}

/** 正規表現のメタ文字をエスケープして「文字どおりに一致するパターン」にする。 */
export function escapeRegexLiteral(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * 通常置換を `regexp_replace` / `REGEXP_REPLACE` に載せるとき、置換文字列側の
 * 特殊文字 (バックスラッシュ・MySQL の `$`) を文字どおりに直す。
 */
function escapeRegexReplacement(driver: string, s: string): string {
  const bs = s.replace(/\\/g, "\\\\");
  return driver === "postgres" ? bs : bs.replace(/\$/g, "\\$");
}

export interface ColumnReplaceSqlInput {
  driver: string;
  database: string;
  table: string;
  column: string;
  find: string;
  replace: string;
  options: ReplaceOptions;
  /**
   * 追加の WHERE 条件 (テーブルブラウズのサーバ側フィルタ句など)。**呼び出し側が
   * 明示した条件だけ**を渡す — グリッドの元クエリ条件を推測して付けない。
   */
  extraWhere?: string | null;
}

export type ColumnReplaceSql =
  | { ok: true; sql: string }
  | { ok: false; reason: "emptyFind" | ColumnReplaceUnsupported };

/**
 * `UPDATE t SET c = <置換式> WHERE [<extraWhere> AND] <検索文字列を含む行>;` を組み立てる。
 *
 * 検索文字列を含む行だけを対象にするため、必ず WHERE が付く (無変更行の書き換えを
 * 避け、影響行数を実際に変わる行数に近づける)。NULL 行は条件に合致しないので除外される。
 */
export function buildColumnReplaceSql(input: ColumnReplaceSqlInput): ColumnReplaceSql {
  const { driver, options } = input;
  if (input.find === "") return { ok: false, reason: "emptyFind" };
  const unsupported = columnReplaceUnsupported(driver, options);
  if (unsupported) return { ok: false, reason: unsupported };

  const col = quoteIdentFor(driver, input.column);
  let expr: string;
  let cond: string;
  if (!options.regex && options.caseSensitive) {
    const f = quoteString(driver, input.find);
    const r = quoteString(driver, input.replace);
    expr = `REPLACE(${col}, ${f}, ${r})`;
    cond = driver === "postgres" ? `POSITION(${f} IN ${col}) > 0` : `INSTR(${col}, ${f}) > 0`;
  } else {
    const pattern = quoteString(driver, options.regex ? input.find : escapeRegexLiteral(input.find));
    const repl = quoteString(
      driver,
      options.regex ? input.replace : escapeRegexReplacement(driver, input.replace),
    );
    if (driver === "postgres") {
      expr = `regexp_replace(${col}, ${pattern}, ${repl}, '${options.caseSensitive ? "g" : "gi"}')`;
      cond = `${col} ${options.caseSensitive ? "~" : "~*"} ${pattern}`;
    } else {
      const flag = quoteString(driver, options.caseSensitive ? "c" : "i");
      expr = `REGEXP_REPLACE(${col}, ${pattern}, ${repl}, 1, 0, ${flag})`;
      cond = `REGEXP_LIKE(${col}, ${pattern}, ${flag})`;
    }
  }
  const extra = input.extraWhere?.trim();
  const where = extra ? `(${extra}) AND ${cond}` : cond;
  const ref = qualifiedTableRef(driver, input.database, input.table);
  return { ok: true, sql: `UPDATE ${ref} SET ${col} = ${expr} WHERE ${where};` };
}

/**
 * セル文字列 1 件へ置換を適用する (在グリッドモード用)。
 * 正規表現モードは JS の置換記法 (`$1` / `$&`)、通常モードは置換文字列を文字どおりに扱う。
 * 正規表現が不正なら null。
 */
export function replaceInText(
  text: string,
  find: string,
  replace: string,
  options: ReplaceOptions,
): string | null {
  const replacer = buildReplacer(find, replace, options);
  return replacer ? replacer(text) : null;
}

/**
 * `replaceInText` の RegExp を 1 回だけコンパイルして使い回す版 (#1257)。
 * 多数のセルへ同じ置換を適用する呼び出し側 (`planGridReplace`) 用。正規表現が
 * 不正なら null。`g` フラグ付きだが `String.prototype.replace` は毎回 lastIndex を
 * 0 から始めるので、使い回しても結果は変わらない。
 */
export function buildReplacer(
  find: string,
  replace: string,
  options: ReplaceOptions,
): ((text: string) => string) | null {
  const flags = options.caseSensitive ? "g" : "gi";
  let re: RegExp;
  try {
    re = new RegExp(options.regex ? find : escapeRegexLiteral(find), flags);
  } catch {
    return null;
  }
  if (options.regex) return (text) => text.replace(re, replace);
  return (text) => text.replace(re, () => replace);
}

export interface GridReplaceInput {
  rows: CellValue[][];
  columns: Column[];
  /** 行の識別に使う列添字 (空なら対象外)。 */
  pkIndices: number[];
  /** 置換対象の列添字。 */
  colIdx: number;
  find: string;
  replace: string;
  options: ReplaceOptions;
  /** 列が編集可能か (BLOB 等は false)。 */
  isColEditable: (colIdx: number) => boolean;
  /** 値が列型に対して妥当なら null (`validateCellInput` をラップして渡す)。 */
  validate: (colIdx: number, value: string) => unknown;
}

export interface GridReplacePlan {
  /** 実際に値が変わるセル (pending edit として積む)。 */
  applied: BulkEditTarget[];
  /** 検索にヒットした取得済みセル数 (スキップ分を含む)。 */
  hitCount: number;
  /** 値が変わる個別の行数。 */
  rowCount: number;
  /** PK 欠如のため対象外にしたヒット数。 */
  skippedNoPk: number;
  /** 編集不可列 (BLOB 等) のため対象外にしたヒット数。 */
  skippedReadonly: number;
  /** 置換後の値が列型に対して不正 (または NULL と解釈されてしまう) ためのスキップ数。 */
  skippedInvalid: number;
  /** 置換しても値が変わらなかったヒット数 (空マッチの正規表現など)。 */
  unchanged: number;
  /** 正規表現がコンパイルできなかったとき true。 */
  invalidRegex: boolean;
}

const EMPTY_PLAN: GridReplacePlan = {
  applied: [],
  hitCount: 0,
  rowCount: 0,
  skippedNoPk: 0,
  skippedReadonly: 0,
  skippedInvalid: 0,
  unchanged: 0,
  invalidRegex: false,
};

/**
 * 取得済み行の対象列から検索文字列を含むセルを探し、置換後の値を pending edit へ
 * 展開する計画を作る。探索は `computeFindMatches` を再利用する (大小・正規表現の解釈が
 * 「結果内検索」と一致する)。
 *
 * `bulkEdit.ts` と同じ保守方針: PK 欠如は全件スキップ、編集不可列は全件スキップ、
 * 置換後の値が列型に不正なセルは個別にスキップし、件数を返して UI が提示できるようにする。
 * グリッドの入力欄は "NULL" を SQL NULL と解釈するため、置換結果がちょうど "NULL" (大小・
 * 前後空白無視) になるセルは文字列 "NULL" として書けず、不正扱いでスキップする。
 */
export function planGridReplace(input: GridReplaceInput): GridReplacePlan {
  const { rows, columns, colIdx, find, options } = input;
  if (find === "" || !columns[colIdx]) return EMPTY_PLAN;
  // 対象列だけを走査する (他列の全セルを String() しない, #1257)。
  const found = computeColumnMatchRows(rows, colIdx, find, {
    caseSensitive: options.caseSensitive,
    wholeCell: false,
    regex: options.regex,
  });
  if (found.invalidRegex) return { ...EMPTY_PLAN, invalidRegex: true };
  const hits = found.rowIdxs;
  if (hits.length === 0) return EMPTY_PLAN;
  if (input.pkIndices.length === 0) {
    return { ...EMPTY_PLAN, hitCount: hits.length, skippedNoPk: hits.length };
  }
  if (!input.isColEditable(colIdx)) {
    return { ...EMPTY_PLAN, hitCount: hits.length, skippedReadonly: hits.length };
  }
  const applied: BulkEditTarget[] = [];
  const touched = new Set<string>();
  let skippedInvalid = 0;
  let unchanged = 0;
  // RegExp は 1 回だけコンパイルして全セルで使い回す。
  const replacer = buildReplacer(find, input.replace, options);
  if (!replacer) return { ...EMPTY_PLAN, invalidRegex: true };
  for (const rowIdx of hits) {
    const row = rows[rowIdx];
    const cur = row?.[colIdx];
    if (!row || cur === null || cur === undefined) continue;
    const next = replacer(String(cur));
    if (next === String(cur)) {
      unchanged++;
      continue;
    }
    if (/^null$/i.test(next.trim()) || input.validate(colIdx, next)) {
      skippedInvalid++;
      continue;
    }
    if (editIsNoop(next, columns[colIdx], cur)) {
      unchanged++;
      continue;
    }
    const rowKey = rowEditKey(row, input.pkIndices, rowIdx);
    applied.push({ rowKey, colIdx, value: next });
    touched.add(rowKey);
  }
  return {
    applied,
    hitCount: hits.length,
    rowCount: touched.size,
    skippedNoPk: 0,
    skippedReadonly: 0,
    skippedInvalid,
    unchanged,
    invalidRegex: false,
  };
}
