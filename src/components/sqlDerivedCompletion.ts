import {
  COMMENT_OR_STRING_RE,
  mask,
  quoteIfNeeded,
  unquote,
} from "./sqlJoinCompletion";

/**
 * エディタ本文の構造から補完候補を作る純ロジック (#1419)。CodeMirror には依存せず、
 * `QueryEditor.tsx` が結果を `CompletionResult` に包む。
 *
 * - `WITH x AS (SELECT a, b ...) SELECT |`  : CTE 名 `x` と列 `x.a` / `x.b`
 * - `FROM (SELECT a ...) d WHERE d.|`       : 派生表の別名 `d` と列 `d.a`
 * - `SELECT a AS n FROM t ORDER BY |`        : SELECT 別名 `n`
 *   別名の参照可否は DB ごとに違うため次のとおり (それ以外では出さない):
 *   ORDER BY / GROUP BY = 全 DB、HAVING = MySQL・SQLite、WHERE = SQLite のみ
 *   (MySQL / PostgreSQL は WHERE で列別名を参照できない)
 *
 * 方針は「誤爆 (存在しない列を出す) より取りこぼし」。解決できないものは出さない:
 * - `SELECT *` を含む CTE / 派生表は列を出さない (名前だけ出す)
 * - UNION / INTERSECT / EXCEPT を含む本体、WITH 入りの派生表本体、名前の無い式
 *   (`count(*)` など) は列にしない
 * - 文字列・コメントの中では何も出さない
 * - 派生表の別名は、そのサブクエリを囲む括弧グループがカーソルを含むときだけ見せる
 * - 句は、カーソルを囲む括弧のうち SELECT で始まるサブクエリ (と文全体) から決める。
 *   関数呼び出し・式の括弧 (`sum(x.` / `WHERE (x.`) の中でも外側の句で候補を出す
 *
 * 既知の制約 (安全側に倒して補完を止める / 対象外):
 * - MySQL のバックスラッシュエスケープ (`\'`) と `#` コメント、PostgreSQL のドル引用 (`$$`)
 *   は文字列・コメントとして正しく読めない。その後ろの補完は出ないことがある
 * - カンマ区切りの派生表 (`FROM t, (SELECT ...) d`) と LATERAL は対象外
 * - 候補の種別 (cte / derived / alias) は呼び出し側で表示語に変換する (i18n)
 */

/** 候補の種別。表示語 (CTE / 派生表 / 別名) への変換は呼び出し側 (i18n) が行う。 */
export type DerivedKind = "cte" | "derived" | "alias";

export interface DerivedCandidate {
  label: string;
  apply: string;
  type: string;
  kind: DerivedKind;
}

interface DerivedCompletion {
  /** 置換開始位置 (`text` 内のオフセット)。入力中の語 (修飾子付きを含む) の先頭。 */
  from: number;
  options: DerivedCandidate[];
}

interface Source {
  name: string;
  kind: "cte" | "derived";
  /** 解決できた列名。解決できなければ空 (名前だけは候補に出す)。 */
  columns: string[];
}

interface SelectItem {
  name: string;
  /** `expr AS name` / `expr name` の別名なら true。列参照 `t.a` は false。 */
  alias: boolean;
}

interface SelectInfo {
  items: SelectItem[];
  /** `*` または `t.*` を含む。列名の全体が決まらない。 */
  star: boolean;
}

const IDENT = "(?:`[^`]+`|\"[^\"]+\"|[A-Za-z_]\\w*)";
const KW_RE =
  /\b(SELECT|FROM|JOIN|WHERE|ON|HAVING|GROUP\s+BY|ORDER\s+BY|UNION|INTERSECT|EXCEPT|LIMIT|SET|VALUES|WITH|INTO|RETURNING|UPDATE|DELETE|INSERT)\b/gi;

/**
 * 別名・派生表の別名として取らない語。句の区切りや式の途中で現れる語
 * (`a IS NULL` の NULL、`x BETWEEN 1 AND 2` の AND など) を別名と誤認しないため。
 */
const ALIAS_STOP = new Set([
  "AND", "OR", "NOT", "IS", "IN", "LIKE", "ILIKE", "BETWEEN", "NULL", "TRUE", "FALSE",
  "CASE", "WHEN", "THEN", "ELSE", "END", "DESC", "ASC", "OVER", "FILTER", "COLLATE",
  "ESCAPE", "DISTINCT", "ON", "USING", "FROM", "WHERE", "GROUP", "ORDER", "HAVING",
  "LIMIT", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER",
  "UNION", "WINDOW", "FETCH", "OFFSET", "LATERAL", "WITH", "SET", "AS", "INTO",
  "SELECT", "BY", "RETURNING", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP",
  // 派生表の直後に来うる集合演算・ロック・サンプリング指定など (別名と誤認しない)。
  "EXCEPT", "INTERSECT", "FOR", "LOCK", "TABLESAMPLE", "STRAIGHT_JOIN", "QUALIFY",
]);

/**
 * 括弧の中身と引用識別子の中身を空白にした同長の文字列。FROM・カンマ・SELECT など
 * 「その階層の構文」だけを正規表現で見るために使う。
 */
function topView(s: string): string {
  const out = s.split("");
  let depth = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote !== "") {
      if (c === quote) quote = "";
      else out[i] = " ";
      continue;
    }
    if (c === '"' || c === "`") {
      quote = c;
    } else if (c === "(") {
      if (depth > 0) out[i] = " ";
      depth++;
    } else if (c === ")") {
      if (depth > 0) {
        depth--;
        if (depth > 0) out[i] = " ";
      }
    } else if (depth > 0) {
      out[i] = " ";
    }
  }
  return out.join("");
}

/** `open` の `(` に対応する `)` の位置。閉じていなければ -1。 */
function matchClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `idx` の位置で閉じていない `(` の位置一覧 (外側から内側の順)。 */
function openGroups(s: string, idx: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < idx && i < s.length; i++) {
    if (s[i] === "(") stack.push(i);
    else if (s[i] === ")") stack.pop();
  }
  return stack;
}

/**
 * カーソル直前が文字列 / コメントの閉じていない途中かどうか。途中なら補完しない。
 * `mask` と同じ規則 (`COMMENT_OR_STRING_RE`) で末尾の範囲を見る。
 */
function cursorInLiteral(pre: string): boolean {
  let last: RegExpMatchArray | null = null;
  for (const m of pre.matchAll(COMMENT_OR_STRING_RE)) last = m;
  if (!last) return false;
  const t = last[0];
  if ((last.index ?? 0) + t.length !== pre.length) return false;
  if (t.startsWith("--")) return true;
  if (t.startsWith("/*")) return !t.endsWith("*/") || t.length < 4;
  if (t.startsWith("'")) return t.length < 2 || !t.endsWith("'");
  return false;
}

/** 別名・名前として妥当なら SelectItem を返す。予約語・数字始まりは null。 */
function named(raw: string, alias: boolean): SelectItem | null {
  const name = unquote(raw);
  const plain = raw[0] !== '"' && raw[0] !== "`";
  if (name === "") return null;
  if (plain && (/^\d/.test(name) || ALIAS_STOP.has(name.toUpperCase()))) return null;
  return { name, alias };
}

/** SELECT リストの 1 項目 (カンマで区切られた 1 つ分) を解釈する。 */
function itemOf(raw: string): SelectItem | "star" | null {
  const s = raw.trim();
  if (s === "") return null;
  if (/(?:^|\.)\s*\*$/.test(s)) return "star";
  const as = new RegExp(`\\bAS\\s+(${IDENT})$`, "i").exec(s);
  if (as) return named(as[1], true);
  // 式の後ろの素の語は別名とみなす。ただし前が `)` か単一の列参照のときだけ
  // (`a + b c` のような曖昧な形は取らない)。
  const ref = `(?:${IDENT}\\.)*${IDENT}`;
  const impl = new RegExp(`^(?:.*\\)|${ref})\\s+(${IDENT})$`, "s").exec(s);
  if (impl) return named(impl[1], true);
  const col = new RegExp(`^(?:${IDENT}\\.)*(${IDENT})$`).exec(s);
  return col ? named(col[1], false) : null;
}

/**
 * `SELECT ...` で始まる本体の出力列を解釈する。SELECT で始まらない / UNION 系を含む /
 * 解釈できない場合は null。
 */
function selectInfo(body: string): SelectInfo | null {
  const top = topView(body);
  const head = /^\s*SELECT\b/i.exec(top);
  if (!head || /\b(?:UNION|INTERSECT|EXCEPT)\b/i.test(top)) return null;
  const from = /\bFROM\b/i.exec(top.slice(head[0].length));
  const end = from ? head[0].length + from.index : top.length;
  const distinct = /^\s*(?:DISTINCT\s+ON\s*\([^()]*\)|DISTINCT|ALL)\b/i.exec(
    body.slice(head[0].length, end),
  );
  const start = head[0].length + (distinct ? distinct[0].length : 0);
  const listTop = top.slice(start, end);
  const items: SelectItem[] = [];
  let star = false;
  let itemStart = start;
  for (let i = 0; i <= listTop.length; i++) {
    if (i < listTop.length && listTop[i] !== ",") continue;
    const r = itemOf(body.slice(itemStart, start + i));
    itemStart = start + i + 1;
    if (r === "star") star = true;
    else if (r) items.push(r);
  }
  const seen = new Set<string>();
  return {
    items: items.filter((i) => {
      const k = i.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    star,
  };
}

/** `(a, b)` の列リスト。識別子以外が混ざれば解釈不能として空を返す。 */
function explicitColumns(list: string): string[] {
  const names = list.split(",").map((p) => p.trim());
  if (!names.every((n) => new RegExp(`^${IDENT}$`).test(n))) return [];
  return names.map((n) => unquote(n));
}

function columnsOf(info: SelectInfo | null, explicit: string[] | null): string[] {
  if (explicit !== null) return explicit;
  if (info === null || info.star) return [];
  return info.items.map((i) => i.name);
}

/** `WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] (body), ...` を読む。 */
function parseCtes(s: string, cursor: number): Source[] {
  const head = /^\s*WITH(?:\s+RECURSIVE)?\b/i.exec(s);
  if (!head) return [];
  const out: Source[] = [];
  const defRe = new RegExp(
    `\\s*(${IDENT})(?:\\s*\\(([^()]*)\\))?\\s*AS\\s*(?:NOT\\s+)?(?:MATERIALIZED\\s+)?\\(`,
    "iy",
  );
  const commaRe = /\s*,/y;
  let p = head[0].length;
  for (;;) {
    defRe.lastIndex = p;
    const m = defRe.exec(s);
    if (!m) break;
    const open = p + m[0].length - 1;
    const close = matchClose(s, open);
    // 閉じていない / カーソルを含む定義は、まだ確定していないので候補にしない。
    if (close < 0 || (open < cursor && cursor <= close)) break;
    const explicit = m[2] !== undefined ? explicitColumns(m[2]) : null;
    out.push({
      name: unquote(m[1]),
      kind: "cte",
      columns: columnsOf(selectInfo(s.slice(open + 1, close)), explicit),
    });
    commaRe.lastIndex = close + 1;
    const c = commaRe.exec(s);
    if (!c) break;
    p = close + 1 + c[0].length;
  }
  return out;
}

/**
 * `FROM (SELECT ...) [AS] d [(cols)]` / `JOIN (SELECT ...) d` を読む。
 * 別名が無いもの・本体が SELECT で始まらないものは対象外。
 */
function parseDerived(s: string, cursor: number, tokenEnd: number): Source[] {
  const out: Source[] = [];
  const cur = openGroups(s, cursor);
  const aliasRe = new RegExp(`\\s*(?:AS\\s+)?(${IDENT})(?:\\s*\\(([^()]*)\\))?`, "iy");
  for (const m of s.matchAll(/\b(?:FROM|JOIN)\s*\(/gi)) {
    const kw = m.index ?? 0;
    const open = kw + m[0].length - 1;
    const close = matchClose(s, open);
    if (close < 0 || (open < cursor && cursor <= close)) continue;
    if (!/^\s*SELECT\b/i.test(s.slice(open + 1, close))) continue;
    // 派生表を囲む括弧グループがカーソルを含むときだけ見える (兄弟のサブクエリの別名は除外)。
    const owner = openGroups(s, kw);
    const ownerOpen = owner.length > 0 ? owner[owner.length - 1] : -1;
    if (ownerOpen >= 0 && !cur.includes(ownerOpen)) continue;
    aliasRe.lastIndex = close + 1;
    const a = aliasRe.exec(s);
    if (!a) continue;
    // 入力中の語そのもの (今まさに打っている別名) は候補にしない。
    const aliasEnd = close + 1 + a[0].length;
    if (close + 1 < tokenEnd && aliasEnd > cursor) continue;
    const name = named(a[1], false);
    if (!name) continue;
    const explicit = a[2] !== undefined ? explicitColumns(a[2]) : null;
    out.push({
      name: name.name,
      kind: "derived",
      columns: columnsOf(selectInfo(s.slice(open + 1, close)), explicit),
    });
  }
  return out;
}

/**
 * カーソルを含むグループ内で最後に現れる SELECT の別名一覧。ORDER BY / GROUP BY /
 * (MySQL・SQLite の) WHERE / HAVING で参照できる。
 */
function selectAliases(gText: string): string[] {
  let at = -1;
  for (const m of topView(gText).matchAll(/\bSELECT\b/gi)) at = m.index ?? at;
  if (at < 0) return [];
  const info = selectInfo(gText.slice(at));
  return info ? info.items.filter((i) => i.alias).map((i) => i.name) : [];
}

function eqIdent(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function candidate(
  label: string,
  apply: string,
  type: string,
  kind: DerivedKind,
): DerivedCandidate {
  return { label, apply, type, kind };
}

function finish(from: number, options: DerivedCandidate[]): DerivedCompletion | null {
  const seen = new Set<string>();
  const uniq = options.filter((o) => {
    if (seen.has(o.label)) return false;
    seen.add(o.label);
    return true;
  });
  return uniq.length > 0 ? { from, options: uniq } : null;
}

/**
 * `text` の `pos` (カーソル位置) から CTE / 派生表 / SELECT 別名の補完候補を返す。
 * 該当文脈でなければ null。
 */
export function derivedCompletions(opts: {
  driver: string;
  text: string;
  pos: number;
}): DerivedCompletion | null {
  const { driver, text } = opts;
  const pos = Math.max(0, Math.min(opts.pos, text.length));
  // 入力中の語: 識別子・引用符・ドット。`x.` / `d.a` のような修飾子付きも 1 語として扱う。
  const token = /[\w`".]*$/.exec(text.slice(Math.max(0, pos - 256), pos))?.[0] ?? "";
  const tokenStart = pos - token.length;
  if (cursorInLiteral(text.slice(0, pos))) return null;
  const parts = token.split(".");
  if (parts.length > 2) return null;
  const qualRaw = parts.length === 2 ? parts[0] : null;
  if (qualRaw === "") return null;

  // 構造は文字列・コメントを除いた全文で見る。文は `;` で区切る。
  const full = mask(text);
  const semi = tokenStart > 0 ? full.lastIndexOf(";", tokenStart - 1) : -1;
  const stmtStart = semi + 1;
  const endSemi = full.indexOf(";", pos);
  const s = full.slice(stmtStart, endSemi < 0 ? full.length : endSemi);
  const cursor = tokenStart - stmtStart;
  const tokenEnd = pos - stmtStart;

  // カーソルを囲む括弧グループを内側から順に見て、句キーワードを持つ最初のグループで文脈を決める。
  // 関数呼び出し・式の括弧 (`sum(x.` / `(x.`) は句を持たないので飛ばし、サブクエリ (SELECT で
  // 始まる括弧) と文全体 (最外) だけを句の所有者とみなす。
  let gText = s.slice(0, cursor);
  let lastKw = "";
  const owners = openGroups(s, cursor);
  for (let k = owners.length; k >= 0; k--) {
    const start = k === 0 ? 0 : owners[k - 1] + 1;
    const text = s.slice(start, cursor);
    if (k > 0 && !/^\s*(?:SELECT|WITH)\b/i.test(text)) continue;
    let kw = "";
    for (const m of topView(text).matchAll(KW_RE)) kw = m[1].toUpperCase().replace(/\s+/g, " ");
    if (kw !== "") {
      gText = text;
      lastKw = kw;
      break;
    }
  }
  const gTop = topView(gText);
  const trimmed = gTop.trimEnd();
  // `SELECT a AS |` は別名の命名位置。ここでは候補を出さない。
  if (/\bAS$/i.test(s.slice(0, cursor).trimEnd())) return null;
  // FROM / JOIN の直後、または FROM 句のカンマ区切りの次だけテーブル位置。
  const isTable =
    /\b(?:FROM|JOIN)$/i.test(trimmed) || (trimmed.endsWith(",") && lastKw === "FROM");

  let mode: "table" | "expr" | null = null;
  let aliasOk = false;
  if (isTable) mode = "table";
  else if (lastKw === "SELECT" || lastKw === "ON") mode = "expr";
  else if (lastKw === "WHERE") {
    // MySQL / PostgreSQL は WHERE で列別名を参照できない (Unknown column)。SQLite だけ可。
    mode = "expr";
    aliasOk = driver === "sqlite";
  } else if (lastKw === "HAVING") {
    // HAVING は MySQL / SQLite で別名を参照できる。PostgreSQL は不可。
    mode = "expr";
    aliasOk = driver !== "postgres";
  } else if (lastKw === "ORDER BY" || lastKw === "GROUP BY") {
    mode = "expr";
    aliasOk = true;
  }
  if (mode === null) return null;

  const sources: Source[] = [
    ...parseCtes(s, cursor),
    ...parseDerived(s, cursor, tokenEnd),
  ];
  const qa = (name: string) => quoteIfNeeded(driver, name);

  if (qualRaw !== null) {
    // `x.` / `d.a`: 修飾子に一致する唯一の名前の列だけを出す。曖昧なら出さない。
    if (mode !== "expr") return null;
    const qual = unquote(qualRaw);
    const matches = sources.filter((src) => eqIdent(src.name, qual));
    if (matches.length !== 1) return null;
    const src = matches[0];
    return finish(
      tokenStart,
      src.columns.map((c) =>
        candidate(`${qualRaw}.${c}`, `${qa(src.name)}.${qa(c)}`, "property", src.kind),
      ),
    );
  }

  const options: DerivedCandidate[] = [];
  if (mode === "table") {
    for (const src of sources) {
      if (src.kind === "cte") options.push(candidate(src.name, qa(src.name), "class", "cte"));
    }
  } else {
    for (const src of sources) {
      options.push(candidate(src.name, qa(src.name), "class", src.kind));
      for (const c of src.columns) {
        options.push(candidate(`${src.name}.${c}`, `${qa(src.name)}.${qa(c)}`, "property", src.kind));
      }
    }
    if (aliasOk) {
      for (const a of selectAliases(gText)) {
        options.push(candidate(a, qa(a), "variable", "alias"));
      }
    }
  }
  return finish(tokenStart, options);
}
