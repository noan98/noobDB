// SQL エディタの識別子ホバーカードと、Ctrl/Cmd 押下中のジャンプ下線 (#2352) の純ロジック。
// 「どの識別子がどの対象に解決できるか」は `identifierJump.ts` の `resolveSchemaJump` を再利用し、
// ここでは (1) ホバー位置の識別子の範囲と移動先、(2) 表示範囲内でジャンプできる識別子の範囲、
// (3) テーブルカードの内容、を決める。DOM / CodeMirror に触れないので Vitest で境界を固定できる。

import type { TableColumnInfo, TableSchema } from "../api/tauri";
import { maskLiterals } from "../dangerousSql";
import {
  resolveChainJump,
  resolveSchemaJump,
  scanLineChains,
  tableRefsInStatement,
  type SchemaJumpTarget,
} from "./identifierJump";

/** これより長い 1 行は下線の対象外 (巨大な INSERT VALUES などで UI を止めない)。 */
export const MAX_LINKED_LINE_LENGTH = 10_000;

/**
 * コメント (`--` / `#` / ブロックコメント、複数行) と文字列リテラル (複数行) の中身を空白にした同じ長さの文字列。
 * 引用符つき識別子は残す。行単位の走査がこれらの中の語を識別子と誤認しない・複数行の文字列を
 * またいで本物の識別子を取りこぼさないために、解決の前に必ず通す。
 */
function maskForHover(text: string, driver: string | null | undefined): string {
  const masked = maskLiterals(text, driver ?? undefined, { keepQuotedIdentifiers: true, cache: false });
  // 中身を潰した文字列に残る区切りの `'` は、行単位の走査が次の行で「文字列の開始」と誤読するので消す。
  // 引用符つき識別子 (`"O'Reilly"` / `` `O'Reilly` ``) の中の `'` は識別子の一部なので残す。
  return masked.includes("'") ? blankStringDelimiters(masked) : masked;
}

/** 引用符つき識別子 (`"..."` / `` `...` ``) の外にある `'` だけを空白にする。 */
function blankStringDelimiters(masked: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of masked) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else {
      out += ch === "'" ? " " : ch;
    }
  }
  return out;
}

interface SchemaArgs {
  /** ドライバ名 (コメントの書式の扱いが変わる)。 */
  driver?: string | null;
  tables: readonly TableSchema[] | null | undefined;
  defaultDatabase: string | null | undefined;
}

/** ホバー位置の識別子 1 要素の範囲 (`from..to`) と、その解決先。 */
export interface IdentifierHover {
  from: number;
  to: number;
  target: SchemaJumpTarget;
}

/** `pos` を含む行の先頭 / 末尾。 */
function lineBounds(text: string, pos: number): { start: number; end: number } {
  const start = pos <= 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  const nl = text.indexOf("\n", pos);
  return { start, end: nl === -1 ? text.length : nl };
}

/**
 * `pos` にある識別子を解決する。`side` はポインタが文字のどちら側か (CodeMirror の `hoverTooltip` と
 * 同じく、負なら `pos` の手前)。行末で最後の文字の右側に当たったときは手前の文字を見る。
 * 解決できない語・文字列リテラル・コメントの中・`db.` 修飾そのものは null。
 */
export function resolveIdentifierHover(
  args: SchemaArgs & { text: string; pos: number; side?: number },
): IdentifierHover | null {
  const { pos, side = 1, tables, defaultDatabase } = args;
  if (!tables || tables.length === 0 || !defaultDatabase) return null;
  if (pos < 0 || pos > args.text.length) return null;
  const text = maskForHover(args.text, args.driver);
  const { start, end } = lineBounds(text, pos);
  for (const parts of scanLineChains(text, start, end)) {
    const last = parts[parts.length - 1];
    if (pos < parts[0].from || pos > last.to) continue;
    // 文字 `[from, to)` の上にあるときだけ。右端ちょうどは side が負のときだけ手前の要素とみなす。
    const hit = parts.find((p) => pos >= p.from && (pos < p.to || (pos === p.to && side < 0)));
    if (!hit) return null;
    const target = resolveSchemaJump({ text, pos: hit.from, tables, defaultDatabase });
    return target ? { from: hit.from, to: hit.to, target } : null;
  }
  return null;
}

/** 範囲 `from..to` の識別子の位置 (ジャンプ下線を引く範囲)。 */
export interface JumpRange {
  from: number;
  to: number;
}

/**
 * 文書 `text` の `from..to` (表示範囲) と重なる行のうち、ジャンプできる識別子 (`resolveSchemaJump` が
 * 移動先を返すもの) の範囲を昇順で返す。解決できない識別子・文字列・コメントは含めない。
 */
export function jumpableRanges(args: SchemaArgs & { text: string; from: number; to: number }): JumpRange[] {
  const { from, to, tables, defaultDatabase } = args;
  if (!tables || tables.length === 0 || !defaultDatabase) return [];
  const text = maskForHover(args.text, args.driver);
  const out: JumpRange[] = [];
  let lineStart = lineBounds(text, Math.max(0, Math.min(from, text.length))).start;
  const limit = Math.min(to, text.length);
  // 文ごとのテーブル参照を使い回す (識別子ごとに文全体を走査し直さない)。
  let stmtEnd = -1;
  let refs: Map<string, string> = new Map();
  while (lineStart <= limit) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - lineStart <= MAX_LINKED_LINE_LENGTH) {
      for (const parts of scanLineChains(text, lineStart, lineEnd)) {
        if (parts[parts.length - 1].to < from || parts[0].from > limit) continue;
        const names = parts.map((p) => p.text);
        for (let index = 0; index < parts.length; index++) {
          const p = parts[index];
          if (p.to < from || p.from > limit) continue;
          // 数字だけの要素 (数値リテラル) は識別子として解決しない。
          if (/^\d+$/.test(p.text)) continue;
          if (p.from > stmtEnd) {
            refs = tableRefsInStatement(text, p.from);
            const semi = text.indexOf(";", p.from);
            stmtEnd = semi === -1 ? Number.POSITIVE_INFINITY : semi;
          }
          if (resolveChainJump({ chain: { parts: names, index }, refs, tables, defaultDatabase })) {
            out.push({ from: p.from, to: p.to });
          }
        }
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return out;
}

/** テーブルカードの 1 列。 */
export interface TableCardColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

export interface TableCardModel {
  columns: TableCardColumn[];
  /** 省略した列数 (表示上限を超えた分)。 */
  more: number;
  /** 推定行数。不明 (ビュー・統計なし・SQLite) は null。 */
  rowEstimate: number | null;
}

/** カードに並べる列の上限。 */
export const TABLE_CARD_MAX_COLUMNS = 10;

/** 列メタからテーブルカードの内容を作る。列は定義順に先頭から `limit` 件までで、残りは `more` に数える。 */
export function describeTableCard(
  columns: readonly TableColumnInfo[],
  rowEstimate: number | null | undefined,
  limit: number = TABLE_CARD_MAX_COLUMNS,
): TableCardModel {
  const all: TableCardColumn[] = columns.map((c) => ({
    name: c.name,
    type: c.data_type,
    pk: c.key.toUpperCase() === "PRI",
    fk: !!c.referenced_table,
  }));
  const shown = all.slice(0, limit);
  return {
    columns: shown,
    more: all.length - shown.length,
    rowEstimate: typeof rowEstimate === "number" ? rowEstimate : null,
  };
}
