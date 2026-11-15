// SQL エディタの識別子ホバーカードと、Ctrl/Cmd 押下中のジャンプ下線 (#2352) の純ロジック。
// 「どの識別子がどの対象に解決できるか」は `identifierJump.ts` の `resolveSchemaJump` を再利用し、
// ここでは (1) ホバー位置の識別子の範囲と移動先、(2) 表示範囲内でジャンプできる識別子の範囲、
// (3) テーブルカードの内容、を決める。DOM / CodeMirror に触れないので Vitest で境界を固定できる。

import type { TableColumnInfo, TableSchema } from "../api/tauri";
import { resolveSchemaJump, scanLineChains, type SchemaJumpTarget } from "./identifierJump";

interface SchemaArgs {
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
  const { text, pos, side = 1, tables, defaultDatabase } = args;
  if (!tables || tables.length === 0 || !defaultDatabase) return null;
  if (pos < 0 || pos > text.length) return null;
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
  const { text, from, to, tables, defaultDatabase } = args;
  if (!tables || tables.length === 0 || !defaultDatabase) return [];
  const out: JumpRange[] = [];
  let lineStart = lineBounds(text, Math.max(0, Math.min(from, text.length))).start;
  const limit = Math.min(to, text.length);
  while (lineStart <= limit) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    for (const parts of scanLineChains(text, lineStart, lineEnd)) {
      for (const p of parts) {
        if (p.to < from || p.from > limit) continue;
        if (resolveSchemaJump({ text, pos: p.from, tables, defaultDatabase })) {
          out.push({ from: p.from, to: p.to });
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

/** 列メタからテーブルカードの内容を作る。PK / FK の列は上限を超えても先に並べる。 */
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
  // 上限の外にある PK / FK は落とさず、末尾に足す (制約の印は省略しない)。
  const marked = all.slice(limit).filter((c) => c.pk || c.fk);
  const columnsOut = [...shown, ...marked];
  return {
    columns: columnsOut,
    more: all.length - columnsOut.length,
    rowEstimate: typeof rowEstimate === "number" ? rowEstimate : null,
  };
}
