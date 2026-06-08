// SQL スクリプト (複数文) のバッチ実行 (#495) の文分割 (純ロジック)。
//
// トップレベルの `;` で文を分割する。文字列リテラル・識別子クオート・コメント・
// PostgreSQL のドル引用 ($tag$...$tag$) の内側にある `;` では分割しない (#393 と同じ
// 「文字列内セミコロン誤検出」観点)。副作用が無いので Vitest でユニットテストする。

/**
 * `sql` をトップレベルの `;` で分割し、空文を除いた各文 (末尾セミコロンなし) を返す。
 * 文字列 (`'...'` / `"..."` / `` `...` ``)・行/ブロックコメント・ドル引用の内側の
 * セミコロンでは分割しない。
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = "";
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行コメント -- ... 改行まで
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // ブロックコメント /* ... */
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // 文字列 / 識別子クオート: ' " `
    if (ch === "'" || ch === '"' || ch === "`") {
      const closeIdx = scanQuoted(sql, i, ch);
      current += sql.slice(i, closeIdx);
      i = closeIdx;
      continue;
    }
    // ドル引用 $tag$ ... $tag$ (PostgreSQL)。tag は省略可 ($$)。
    if (ch === "$") {
      const open = matchDollarTag(sql, i);
      if (open) {
        const closeIdx = sql.indexOf(open, i + open.length);
        const stop = closeIdx === -1 ? n : closeIdx + open.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // トップレベルのセミコロン → 文の区切り
    if (ch === ";") {
      pushCurrent();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  pushCurrent();
  return statements;
}

/** `sql` が複数の実行可能文を含むか (バッチ実行を提案する判定に使う)。 */
export function isMultiStatement(sql: string): boolean {
  return splitSqlStatements(sql).length > 1;
}

import type { CellValue, Column } from "./api/tauri";

/** バッチ実行 (#495) における 1 文の実行結果。 */
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

/** `sql[i]` が `$` のとき、ドル引用の開始タグ (`$$` / `$tag$`) を返す。無効なら null。 */
function matchDollarTag(sql: string, i: number): string | null {
  // $tag$ : $ の後に [A-Za-z0-9_]* が続き、再び $ で閉じる。
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
  if (sql[j] === "$") return sql.slice(i, j + 1);
  return null;
}
