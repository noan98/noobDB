// SQL エディタの識別子を Ctrl/Cmd+クリックして、スキーマツリーのテーブル / 列へ移動するための
// 純ロジック (#1629)。クリック位置の識別子 (`a.b.c` の連なりのうち、どの要素か) を取り出し、
// エディタの補完用スキーマ (`TableSchema[]`) と突き合わせて移動先を決める。一致しなければ null
// (呼び出し側は何もしない)。DOM / CodeMirror に触れないので Vitest で境界を固定できる。

import type { TableSchema } from "../api/tauri";

/** クリック位置の識別子の連なり (`schema.table.column`) と、その中でクリックされた要素。 */
export interface IdentifierChain {
  /** 引用符を外した各要素。 */
  parts: string[];
  /** クリックされた要素の位置 (`parts` の添字)。 */
  index: number;
}

const WORD = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * `pos` (文字オフセット) にある識別子の連なりを返す。バッククォート / ダブルクォート / 角括弧で
 * 引用された要素 (空白や記号を含みうる) も 1 要素として扱う。識別子の上でなければ null。
 */
export function identifierChainAt(text: string, pos: number): IdentifierChain | null {
  if (pos < 0 || pos > text.length) return null;
  // 先頭から連なりを走査し、`pos` を含む連なりを探す (引用符の途中から逆走査すると曖昧になるため)。
  const lineStart = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  const nl = text.indexOf("\n", pos);
  const lineEnd = nl === -1 ? text.length : nl;
  let i = lineStart;
  while (i < lineEnd) {
    const start = i;
    // 文字列リテラルと行コメントの中は識別子として扱わない。
    if (text[i] === "'") {
      const close = text.indexOf("'", i + 1);
      if (pos > i && (close === -1 || pos <= close)) return null;
      i = close === -1 || close >= lineEnd ? lineEnd : close + 1;
      continue;
    }
    if (text[i] === "-" && text[i + 1] === "-") {
      if (pos >= i) return null;
      break;
    }
    const parts: { text: string; from: number; to: number }[] = [];
    // 連なりを 1 つ読む: 要素 ('.' 要素)*
    for (;;) {
      const part = readPart(text, i, lineEnd);
      if (!part) break;
      parts.push(part);
      i = part.to;
      if (text[i] === "." && readPart(text, i + 1, lineEnd)) {
        i += 1;
        continue;
      }
      break;
    }
    if (parts.length > 0) {
      if (pos >= start && pos <= i) {
        const index = parts.findIndex((p) => pos >= p.from && pos <= p.to);
        if (index === -1) return null;
        return { parts: parts.map((p) => p.text), index };
      }
      continue;
    }
    i += 1;
  }
  return null;
}

/** `from` から 1 要素 (単語または引用符つき) を読む。引用符は `from..to` に含め、`text` は外した中身。 */
function readPart(
  text: string,
  from: number,
  limit: number,
): { text: string; from: number; to: number } | null {
  const c = text[from];
  if (from >= limit || c === undefined) return null;
  if (c === "`" || c === '"') {
    let j = from + 1;
    let out = "";
    while (j < limit) {
      if (text[j] === c) {
        if (text[j + 1] === c) {
          out += c;
          j += 2;
          continue;
        }
        return out ? { text: out, from, to: j + 1 } : null;
      }
      out += text[j];
      j += 1;
    }
    return null;
  }
  if (c === "[") {
    const close = text.indexOf("]", from + 1);
    if (close === -1 || close >= limit) return null;
    const inner = text.slice(from + 1, close);
    return inner ? { text: inner, from, to: close + 1 } : null;
  }
  if (!WORD.test(c)) return null;
  let j = from;
  while (j < limit && WORD.test(text[j])) j += 1;
  return { text: text.slice(from, j), from, to: j };
}

/** 移動先。`column` が無ければテーブル行を、あれば列行を指す。 */
export interface SchemaJumpTarget {
  database: string;
  table: string;
  column?: string;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const SCOPE_KEYWORDS = new Set([
  "where",
  "on",
  "using",
  "group",
  "order",
  "having",
  "limit",
  "set",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  "outer",
  "union",
  "values",
  "returning",
  "select",
  "from",
  "into",
  "update",
  "as",
  "window",
  "offset",
  "fetch",
  "for",
]);

/**
 * `pos` を含む文 (`;` で区切る) の中で、`FROM` / `JOIN` / `UPDATE` / `INTO` の後ろに書かれた
 * テーブル参照を `別名 → テーブル名` の対応で返す。別名の無い参照はテーブル名自身を別名とみなす。
 * 簡易な字句走査で、サブクエリの入れ子やコメント内の語は区別しない (候補を絞るための目安)。
 */
export function tableRefsInStatement(text: string, pos: number): Map<string, string> {
  const start = pos === 0 ? 0 : text.lastIndexOf(";", pos - 1) + 1;
  const semi = text.indexOf(";", pos);
  const stmt = text.slice(start, semi === -1 ? text.length : semi);
  const refs = new Map<string, string>();
  const re =
    /\b(?:from|join|update|into)\s+((?:[`"\w$]|\[[^\]]+\])+(?:\.(?:[`"\w$]|\[[^\]]+\])+)*)(?:\s+(?:as\s+)?([`"\w$]+))?/gi;
  for (const m of stmt.matchAll(re)) {
    const chain = identifierChainAt(m[1], 0);
    if (!chain) continue;
    const table = chain.parts[chain.parts.length - 1];
    refs.set(table.toLowerCase(), table);
    const alias = m[2]?.replace(/^[`"]|[`"]$/g, "");
    if (alias && !SCOPE_KEYWORDS.has(alias.toLowerCase())) refs.set(alias.toLowerCase(), table);
  }
  return refs;
}

/**
 * クリックされた識別子の移動先を決める。`tables` は補完用スキーマ (エディタのデータベース内の
 * テーブルと列)、`defaultDatabase` はそのデータベース名。次の場合だけ移動先を返し、他は null。
 *
 * - `table` / `別名`: そのテーブル。
 * - `table.column` / `別名.column`: 列要素なら列、テーブル要素ならテーブル。
 * - `db.table[.column]`: `db` がエディタのデータベースと同じときだけ (別のデータベースの
 *   スキーマは持っていない)。`db` 要素そのものをクリックしたときは移動しない。
 * - 修飾の無い列名: 同じ文の `FROM` / `JOIN` で参照しているテーブルのうち、その列を持つ最初の 1 つ。
 */
export function resolveSchemaJump(args: {
  text: string;
  pos: number;
  tables: readonly TableSchema[] | null | undefined;
  defaultDatabase: string | null | undefined;
}): SchemaJumpTarget | null {
  const { text, pos, tables, defaultDatabase } = args;
  if (!tables || tables.length === 0 || !defaultDatabase) return null;
  const chain = identifierChainAt(text, pos);
  if (!chain) return null;
  const findTable = (name: string) => tables.find((t) => eq(t.name, name));
  const refs = tableRefsInStatement(text, pos);
  const resolveRef = (name: string) => findTable(refs.get(name.toLowerCase()) ?? name);
  const colOf = (tbl: TableSchema, name: string) => tbl.columns.find((c) => eq(c, name));

  let { parts, index } = chain;
  // `db.` 修飾はエディタのデータベースと同じときだけ外して続きを解決する。
  if (parts.length >= 2 && eq(parts[0], defaultDatabase) && !findTable(parts[0])) {
    if (index === 0) return null;
    parts = parts.slice(1);
    index -= 1;
  }
  if (parts.length === 1) {
    const tbl = resolveRef(parts[0]);
    if (tbl) return { database: defaultDatabase, table: tbl.name };
    // 修飾の無い列名: 同じ文で参照しているテーブルから探す。
    const seen = new Set<string>();
    for (const tableName of refs.values()) {
      if (seen.has(tableName.toLowerCase())) continue;
      seen.add(tableName.toLowerCase());
      const t = findTable(tableName);
      const col = t && colOf(t, parts[0]);
      if (t && col) return { database: defaultDatabase, table: t.name, column: col };
    }
    return null;
  }
  if (parts.length === 2) {
    const tbl = resolveRef(parts[0]);
    if (!tbl) return null;
    if (index === 0) return { database: defaultDatabase, table: tbl.name };
    const col = colOf(tbl, parts[1]);
    return col ? { database: defaultDatabase, table: tbl.name, column: col } : null;
  }
  return null;
}
