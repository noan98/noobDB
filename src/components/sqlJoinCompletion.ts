import type { ForeignKey } from "../api/tauri";
import { maskLiterals } from "../dangerousSql";
import { quoteIdentFor } from "./sqlDialect";

/**
 * FK メタデータから JOIN 補完 (#1356) を作る純ロジック。CodeMirror には依存せず、
 * `QueryEditor.tsx` が結果を `CompletionResult` に包む。
 *
 * - `JOIN |`        : FROM/JOIN 済みのテーブルと FK で繋がる相手テーブルを `table ON 条件` で提案
 * - `JOIN t ON |`   : 結合した `t` と先行テーブルの FK 条件を提案
 */

export interface JoinCandidate {
  /** 絞り込みに使う表示名。テーブル候補はテーブル名、ON 候補は条件式。 */
  label: string;
  /** 挿入するテキスト。 */
  apply: string;
  /** 補足 (テーブル候補では ON 条件)。 */
  detail?: string;
}

export interface JoinCompletion {
  /** 置換開始位置 (`text` 内のオフセット)。終端はカーソル。 */
  from: number;
  options: JoinCandidate[];
}

interface TableRef {
  table: string;
  /** SQL 内での参照名 (別名があれば別名、無ければテーブル名。クォートは入力のまま)。 */
  key: string;
}

const IDENT = "(?:`[^`]+`|\"[^\"]+\"|\\w+)";
const NOT_KEYWORD =
  "(?!(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|OUTER|JOIN|ON|USING|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|SET|WINDOW|FETCH|OFFSET)\\b)";
// `[db.]table [[AS] alias]`
const REF = `((?:${IDENT}\\.)?${IDENT})(?:\\s+(?:AS\\s+)?${NOT_KEYWORD}(${IDENT}))?`;

const RESERVED = new Set([
  "order", "group", "user", "select", "table", "from", "join", "where", "index",
  "key", "desc", "asc", "limit", "references", "constraint", "primary", "check",
  "column", "default", "range", "rank", "row", "rows", "partition", "window",
  "to", "end", "in", "is", "on", "as", "all", "and", "or", "not", "null", "case",
  "when", "then", "else", "values", "for", "by", "into", "distinct", "having",
  "union", "using", "exists", "like", "between", "insert", "update", "delete",
  "create", "drop", "alter", "set", "with", "true", "false", "unique", "foreign",
]);

export function unquote(ident: string): string {
  const q = ident[0];
  if ((q === "`" || q === '"') && ident.length >= 2) {
    return ident.slice(1, -1).replace(new RegExp(q + q, "g"), q);
  }
  return ident;
}

/** `db.table` なら `table` を返す。 */
function lastPart(ref: string): string {
  const m = ref.match(new RegExp(`(${IDENT})$`));
  return unquote(m ? m[1] : ref);
}

export function quoteIfNeeded(driver: string, name: string): string {
  const plain = driver === "postgres" ? /^[a-z_][a-z0-9_]*$/ : /^[A-Za-z_]\w*$/;
  const lower = name.toLowerCase();
  return plain.test(name) && !RESERVED.has(lower) ? name : quoteIdentFor(driver, name);
}

function parseRefs(masked: string): TableRef[] {
  const refs: TableRef[] = [];
  const re = new RegExp(`\\b(?:FROM|JOIN)\\s+${REF}`, "gi");
  for (const m of masked.matchAll(re)) {
    const table = lastPart(m[1]);
    refs.push({ table, key: m[2] ?? m[1] });
  }
  return refs;
}

interface Link {
  /** [既存テーブル側の列, 新テーブル側の列] (複合キーは複数)。 */
  pairs: Array<[string, string]>;
}

/** `existing` テーブルと `other` テーブルを繋ぐ FK を制約単位にまとめる。 */
function linksBetween(fks: ForeignKey[], existing: string, other: string): Link[] {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const groups = new Map<string, Link>();
  let anon = 0;
  for (const fk of fks) {
    if (fk.referenced_column === null) continue;
    let pair: [string, string];
    if (eq(fk.table, existing) && eq(fk.referenced_table, other)) {
      pair = [fk.column, fk.referenced_column];
    } else if (eq(fk.table, other) && eq(fk.referenced_table, existing)) {
      pair = [fk.referenced_column, fk.column];
    } else {
      continue;
    }
    const id = `${fk.table}\u0000${fk.constraint_name ?? `#${anon++}`}`;
    const g = groups.get(id);
    if (g) g.pairs.push(pair);
    else groups.set(id, { pairs: [pair] });
  }
  // PostgreSQL は複合 FK を交差積で返し、列順も分からないため正しく復元できない。
  // 同じ列が左右どちらかに 2 回以上出るグループは捨てる。
  return [...groups.values()].filter((g) => {
    const l = g.pairs.map((p) => p[0].toLowerCase());
    const r = g.pairs.map((p) => p[1].toLowerCase());
    return new Set(l).size === l.length && new Set(r).size === r.length;
  });
}

function condition(driver: string, link: Link, existingKey: string, otherKey: string): string {
  return link.pairs
    .map(
      ([ec, oc]) =>
        `${otherKey}.${quoteIfNeeded(driver, oc)} = ${existingKey}.${quoteIfNeeded(driver, ec)}`,
    )
    .join(" AND ");
}

/**
 * `text` (ドキュメント先頭からカーソルまで) を見て JOIN 補完候補を返す。該当文脈でなければ null。
 */
export function joinCompletions(opts: {
  driver: string;
  text: string;
  fks: ForeignKey[];
}): JoinCompletion | null {
  const { driver, fks } = opts;
  if (fks.length === 0) return null;
  // 毎打鍵の全文マスクを避ける: カーソル直前が JOIN / ON 文脈でなければ即終了。
  if (!/\b(?:JOIN|ON)\s+[\w`".]*$/i.test(opts.text.slice(-400))) return null;
  // 文字列・コメントは方言つきのマスク (`maskLiterals`) で潰す。識別子は残す (列名を読むため)。
  // キャッシュは使わない (安全網の判定用エントリを毎打鍵で押し出さないため)。
  const full = maskLiterals(opts.text, driver, { keepQuotedIdentifiers: true, cache: false });
  const start = full.lastIndexOf(";") + 1;
  const masked = full.slice(start);

  // JOIN t [alias] ON <partial>
  const on = masked.match(new RegExp(`\\bJOIN\\s+${REF}\\s+ON\\s+([\\w\`".]*)$`, "i"));
  if (on) {
    const joined: TableRef = { table: lastPart(on[1]), key: on[2] ?? on[1] };
    const others = parseRefs(masked.slice(0, on.index));
    const options: JoinCandidate[] = [];
    for (const o of others) {
      for (const link of linksBetween(fks, o.table, joined.table)) {
        const cond = condition(driver, link, o.key, joined.key);
        options.push({ label: cond, apply: cond });
      }
    }
    if (options.length === 0) return null;
    return { from: opts.text.length - on[3].length, options };
  }

  // JOIN <partial>
  const jt = masked.match(/\bJOIN\s+([\w`"]*)$/i);
  if (jt) {
    // NATURAL / CROSS JOIN は ON を取らない。
    if (/\b(?:NATURAL|CROSS)\s+(?:(?:INNER|LEFT|RIGHT|FULL)\s+)?(?:OUTER\s+)?$/i.test(masked.slice(0, jt.index))) {
      return null;
    }
    const refs = parseRefs(masked.slice(0, jt.index));
    const options: JoinCandidate[] = [];
    const seen = new Set<string>();
    for (const r of refs) {
      const others = new Set(
        fks.flatMap((fk) =>
          fk.table.toLowerCase() === r.table.toLowerCase()
            ? [fk.referenced_table]
            : fk.referenced_table.toLowerCase() === r.table.toLowerCase()
              ? [fk.table]
              : [],
        ),
      );
      for (const t of others) {
        // 同名テーブルが既にあれば (自己結合・重複 JOIN) 別名を付ける。
        const taken = refs.some((x) => x.key.toLowerCase() === t.toLowerCase());
        const name = quoteIfNeeded(driver, t);
        const key = taken ? quoteIfNeeded(driver, `${t}_2`) : name;
        for (const link of linksBetween(fks, r.table, t)) {
          const cond = condition(driver, link, r.key, key);
          const id = `${t}\u0000${cond}`;
          if (seen.has(id)) continue;
          seen.add(id);
          options.push({
            label: t,
            apply: `${taken ? `${name} ${key}` : name} ON ${cond}`,
            detail: `ON ${cond}`,
          });
        }
      }
    }
    if (options.length === 0) return null;
    return { from: opts.text.length - jt[1].length, options };
  }
  return null;
}
