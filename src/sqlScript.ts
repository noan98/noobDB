// SQL スクリプト (複数文) のバッチ実行の文分割 (純ロジック)。
//
// トップレベルの `;` で文を分割する。文字列リテラル・識別子クオート・コメント・
// PostgreSQL のドル引用 ($tag$...$tag$) の内側にある `;` では分割しない
// (文字列内セミコロンの誤検出を防ぐ)。副作用が無いので Vitest でユニットテストする。

/**
 * 1 文の範囲。`from` / `to` は元の `sql` 内における**トリム済み本文**の絶対
 * オフセット (先頭/末尾の空白・改行を除いた位置) で、`text` はその本文 (末尾
 * セミコロンなし)。カーソル位置の文を一瞬ハイライトする (#555) のに `from`/`to`
 * を使う。
 */
export interface StatementRange {
  from: number;
  to: number;
  text: string;
}

/**
 * `sql` をトップレベルの `;` で分割し、空文・コメントのみの断片を除いた各文を
 * **範囲付き**で返す。文字列 (`'...'` / `"..."` / `` `...` ``)・行/ブロック
 * コメント・ドル引用の内側のセミコロンでは分割しない。
 */
export function splitSqlStatementRanges(sql: string): StatementRange[] {
  const ranges: StatementRange[] = [];
  let segStart = 0;
  let i = 0;
  const n = sql.length;

  const pushSegment = (end: number) => {
    const raw = sql.slice(segStart, end);
    const trimmed = raw.trim();
    // コメントだけの断片 (例: `SELECT 1; -- note` の `-- note`) は実行文ではないので
    // 数えない。複数文判定 (isMultiStatement) が誤って true にならないようにする。
    if (trimmed.length > 0 && hasExecutableSql(trimmed)) {
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      ranges.push({ from: segStart + leading, to: end - trailing, text: trimmed });
    }
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行コメント -- ... 改行まで
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    // ブロックコメント /* ... */
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // 文字列 / 識別子クオート: ' " `
    if (ch === "'" || ch === '"' || ch === "`") {
      i = scanQuoted(sql, i, ch);
      continue;
    }
    // ドル引用 $tag$ ... $tag$ (PostgreSQL)。tag は省略可 ($$)。直前が単語文字の
    // `$` は識別子の一部 (MySQL は名前に `$` を許す) なので開始タグとみなさない。
    if (ch === "$" && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const open = matchDollarTag(sql, i);
      if (open) {
        const closeIdx = sql.indexOf(open, i + open.length);
        i = closeIdx === -1 ? n : closeIdx + open.length;
        continue;
      }
    }
    // トップレベルのセミコロン → 文の区切り
    if (ch === ";") {
      pushSegment(i);
      segStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  pushSegment(n);
  return ranges;
}

/**
 * `sql` をトップレベルの `;` で分割し、空文を除いた各文 (末尾セミコロンなし) を返す。
 * 文字列 (`'...'` / `"..."` / `` `...` ``)・行/ブロックコメント・ドル引用の内側の
 * セミコロンでは分割しない。
 */
export function splitSqlStatements(sql: string): string[] {
  return splitSqlStatementRanges(sql).map((r) => r.text);
}

/**
 * カーソル (オフセット `offset`) が乗っている単一ステートメントを返す。選択が無い
 * ときに「いま編集している 1 文だけ」を実行する (#555) ための判定。
 *
 * カーソルはトリム前の文セグメント (前後の空白・コメント込み) に属するものとして
 * 帰属させる: 「`offset <= 文の末尾` を満たす最初の文」を選び、どれにも満たない
 * (= 末尾の空白/コメント上) ときは最後の文へフォールバックする。実行可能な文が
 * 一つも無ければ `null`。
 */
export function statementAtOffset(sql: string, offset: number): StatementRange | null {
  const ranges = splitSqlStatementRanges(sql);
  if (ranges.length === 0) return null;
  for (const r of ranges) {
    if (offset <= r.to) return r;
  }
  return ranges[ranges.length - 1];
}

/** コメント (行 `--` / ブロック `/* *​/`) を除いて実行可能な SQL が残るか。 */
function hasExecutableSql(fragment: string): boolean {
  const stripped = fragment
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n\r]*/g, "")
    .trim();
  return stripped.length > 0;
}

/** `sql` が複数の実行可能文を含むか (バッチ実行を提案する判定に使う)。 */
export function isMultiStatement(sql: string): boolean {
  return splitSqlStatements(sql).length > 1;
}

import type { CellValue, Column } from "./api/tauri";

/** バッチ実行における 1 文の実行結果。 */
export interface BatchStatementResult {
  /** 実行した SQL 文。 */
  sql: string;
  status: "ok" | "error" | "skipped";
  /** 結果セットを返した SELECT 系のときの列 (なければ null)。 */
  columns?: Column[];
  /** 結果行 (表示は上限件数に丸める)。 */
  rows?: CellValue[][];
  /** 書き込み系の影響行数。 */
  rowsAffected?: number;
  /** 実行時間 (ms)。 */
  elapsedMs?: number;
  /** エラー時のメッセージ。 */
  error?: string;
}

/** 開始クオート `start` (= sql[i]) の対応する閉じ位置の次のインデックスを返す。 */
function scanQuoted(sql: string, i: number, quote: string): number {
  let j = i + 1;
  const n = sql.length;
  while (j < n) {
    const c = sql[j];
    if (c === quote) {
      // 二重化 ('' / "" / ``) はエスケープとして 1 文字進めて継続。
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    // MySQL の文字列ではバックスラッシュエスケープを尊重 (識別子クオートでは無視)。
    if (c === "\\" && quote === "'") {
      j += 2;
      continue;
    }
    j++;
  }
  return n;
}

/**
 * `sql[i]` が `$` のとき、ドル引用の開始タグ (`$$` / `$tag$`) を返す。無効なら null。
 * タグは識別子風で数字始まりは不可 (`$1` は PostgreSQL のパラメータプレースホルダ)。
 */
function matchDollarTag(sql: string, i: number): string | null {
  // $tag$ : $ の後に数字以外で始まる [A-Za-z0-9_]* が続き、再び $ で閉じる。
  let j = i + 1;
  if (/[0-9]/.test(sql[j] ?? "")) return null;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
  if (sql[j] === "$") return sql.slice(i, j + 1);
  return null;
}
