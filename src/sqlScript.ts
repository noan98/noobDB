// SQL スクリプト (複数文) のバッチ実行の文分割 (純ロジック)。
//
// トップレベルの `;` で文を分割する。文字列リテラル・識別子クオート・コメント
// (`--` / `#` の行コメント、`/* */` のブロックコメント)・PostgreSQL のドル引用
// ($tag$...$tag$) の内側にある `;` では分割しない (文字列内セミコロンの誤検出を
// 防ぐ)。
//
// **マスクは `src/dangerousSql.ts` の `maskLiterals` をそのまま使う (#1074)。**
// 以前は文分割器がマスク処理を独自に再実装しており、`maskLiterals` / バックエンド
// `mask_for_analysis_impl` (src-tauri/src/db/mod.rs、`maskVectors.json` で一致を
// 固定済み、#988) と次の点で乖離していた:
//
// - MySQL バージョンコメント `/*! … */` を素のブロックコメントとして丸ごと
//   スキップしていた (マスクは本体を実行対象として残す)。→
//   `SELECT 1 /*!40000 ; DELETE FROM t */` を 1 文と誤読していた。
// - 閉じタグの無いドル引用で EOF まで飲み込んでいた (マスクは `$` を露出させて
//   走査を続ける)。→ `SELECT $$ oops ; DROP TABLE users` の `;` を隠していた。
//
// マスク後の文字列は長さが元と同じで、コメント/リテラルの中身は空白になる。
// したがって「マスク後に残っている `;` = トップレベルの `;`」であり、その位置で
// 元の SQL を切ればよい。これで「文分割 (バッチ実行・カーソル文実行・フライト
// レコーダの単位)」と「危険 SQL 判定 (analyzeDangerousSql / isReadOnlySql)」が
// 構造的に同じ文字を同じ意味で扱う。`#` を行コメント扱いするのも同じ理由 (#J3):
// PostgreSQL では `#`/`#>>` は演算子であり実行結果とは乖離する既知の限界だが、
// 安全側 (見逃さない) を優先する。文字列内バックスラッシュの解釈もマスクと同じく
// ドライバ対応で、MySQL/MariaDB だけ `\` をエスケープと読む (#852、#1004)。
// `driver?` は省略可能で、省略時は保守的 (非 MySQL) 解釈になる。
//
// 文境界は共有ゴールデン `src/__tests__/fixtures/statementSplitVectors.json` で
// 固定し、バック側 (`src-tauri/tests/statement_split_golden.rs`) も同じ JSON を
// バックエンドのマスクで分割して一致を検証する。
//
// 副作用が無いので Vitest でユニットテストする。

import { maskLiterals } from "./dangerousSql";

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
 * コメント・ドル引用の内側のセミコロンでは分割しない (判定は `maskLiterals` と
 * 完全に同一)。
 *
 * `driver` は `'...'` 内のバックスラッシュ解釈を選ぶ (#852、#1004)。省略時は
 * `driverBackslashEscapes(undefined)` と同じ保守的 (非 MySQL) 解釈になる。
 */
export function splitSqlStatementRanges(sql: string, driver?: string): StatementRange[] {
  const masked = maskLiterals(sql, driver);
  const ranges: StatementRange[] = [];
  let segStart = 0;

  const pushSegment = (end: number) => {
    // コメントだけの断片 (例: `SELECT 1; -- note` の `-- note`) は実行文ではないので
    // 数えない。複数文判定 (isMultiStatement) が誤って true にならないようにする。
    if (!hasExecutableSql(masked.slice(segStart, end))) return;
    const raw = sql.slice(segStart, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    ranges.push({ from: segStart + leading, to: end - trailing, text: raw.trim() });
  };

  for (let i = 0; i < masked.length; i++) {
    // マスク後に残る `;` はすべてトップレベル (コメント/リテラル内は空白化済み)。
    if (masked[i] === ";") {
      pushSegment(i);
      segStart = i + 1;
    }
  }
  pushSegment(masked.length);
  return ranges;
}

/**
 * `sql` をトップレベルの `;` で分割し、空文を除いた各文 (末尾セミコロンなし) を返す。
 * 文字列 (`'...'` / `"..."` / `` `...` ``)・行/ブロックコメント・ドル引用の内側の
 * セミコロンでは分割しない。`driver` は `splitSqlStatementRanges` と同じ (#1004)。
 */
export function splitSqlStatements(sql: string, driver?: string): string[] {
  return splitSqlStatementRanges(sql, driver).map((r) => r.text);
}

/**
 * カーソル (オフセット `offset`) が乗っている単一ステートメントを返す。選択が無い
 * ときに「いま編集している 1 文だけ」を実行する (#555) ための判定。
 *
 * カーソルはトリム前の文セグメント (前後の空白・コメント込み) に属するものとして
 * 帰属させる: 「`offset <= 文の末尾` を満たす最初の文」を選び、どれにも満たない
 * (= 末尾の空白/コメント上) ときは最後の文へフォールバックする。実行可能な文が
 * 一つも無ければ `null`。`driver` は `splitSqlStatementRanges` と同じ (#1004)。
 */
export function statementAtOffset(sql: string, offset: number, driver?: string): StatementRange | null {
  const ranges = splitSqlStatementRanges(sql, driver);
  if (ranges.length === 0) return null;
  for (const r of ranges) {
    if (offset <= r.to) return r;
  }
  return ranges[ranges.length - 1];
}

// マスク済みの断片に実行可能な SQL が残るか。コメントはマスクで空白化済みなので
// 空白を除けばよい。ただし MySQL バージョンコメントの閉じ `*/` はマスクが素通し
// にする (本体を実行対象として残すため) ので、`/*!40000 SET x = 1; */` を分割した
// 後ろ側の `*/` だけの断片は実行文として数えない。
function hasExecutableSql(maskedFragment: string): boolean {
  return maskedFragment.replace(/\*\//g, "").trim().length > 0;
}

/**
 * `sql` が複数の実行可能文を含むか (バッチ実行を提案する判定に使う)。`driver` は
 * `splitSqlStatements` と同じ (#1004)。
 */
export function isMultiStatement(sql: string, driver?: string): boolean {
  return splitSqlStatements(sql, driver).length > 1;
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
