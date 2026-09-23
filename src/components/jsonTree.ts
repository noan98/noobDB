import { literalFromCellValue } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";

/**
 * JSON / JSONB セルのツリービューア (#1026) の純ロジック。
 *
 * - **ロスレスなパース / 整形**: `JSON.parse` は数値を IEEE 754 double に変換する
 *   ため、`9007199254740993` のような JS の安全整数を超える 64bit 整数や桁数の多い
 *   小数が**黙って丸められる**。セルビューアの整形表示・ツリー表示・編集時の
 *   整形/最小化がこれを経由すると、表示が嘘になるだけでなく丸めた値を書き戻して
 *   しまう。ここでは数値を**元テキストのまま** (`raw`) 保持する独自パーサを使う。
 * - **ツリー構築 / 検索**: 描画側 (`JsonTreeView.tsx`) は展開済みノードの子だけを
 *   描くため、ここではパース結果をそのまま木として公開し、検索だけを明示的な
 *   スタックで走査する (巨大 JSON で再帰が溢れないように)。
 * - **パス生成**: ノード単位の `$.a.b[0]` 形式のパスと、方言別の SQL 抽出式・
 *   WHERE 述語 (PostgreSQL `->`/`->>`、MySQL `JSON_EXTRACT`、SQLite `json_extract`、
 *   DuckDB `json_extract_string`、MSSQL `JSON_VALUE`/`JSON_QUERY`) を生成する。
 *   生成した SQL はクリップボードへコピーするだけで、DB へは何も書き込まない。
 */

export type JsonNode =
  | { kind: "object"; entries: JsonEntry[] }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "string"; value: string }
  /** 数値は元テキストのまま保持する (丸めない)。 */
  | { kind: "number"; raw: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

export interface JsonEntry {
  key: string;
  value: JsonNode;
}

/** パスの 1 区間。文字列はオブジェクトのキー、数値は配列の添字。 */
export type JsonPathSegment = string | number;

/**
 * ネストの上限。これを超える入力はツリー表示を諦めて (null を返して) テキスト
 * 表示にフォールバックする。整形・シリアライズが再帰なので、呼び出しスタックを
 * 食い潰さない深さに抑える。
 */
export const JSON_MAX_DEPTH = 512;

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// 制御文字 (U+0000〜U+001F) を生で含まない、JSON として正しい文字列リテラル。
const STRING_RE = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

class JsonSyntaxError extends Error {}

/**
 * JSON テキストをロスレスにパースする。不正な JSON・深すぎるネストでは null。
 * 重複キーも捨てずに出現順どおり保持する。
 */
export function parseJsonLossless(text: string): JsonNode | null {
  let pos = 0;
  const len = text.length;

  const skipWs = () => {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };

  const readString = (): string => {
    STRING_RE.lastIndex = pos;
    const m = STRING_RE.exec(text);
    if (!m) throw new JsonSyntaxError();
    pos += m[0].length;
    // 文字列のデコードは JSON.parse に任せる (文字列は丸めの心配がない)。
    return JSON.parse(m[0]) as string;
  };

  const parseValue = (depth: number): JsonNode => {
    if (depth > JSON_MAX_DEPTH) throw new JsonSyntaxError();
    skipWs();
    if (pos >= len) throw new JsonSyntaxError();
    const c = text[pos];
    if (c === "{") {
      pos++;
      const entries: JsonEntry[] = [];
      skipWs();
      if (text[pos] === "}") {
        pos++;
        return { kind: "object", entries };
      }
      for (;;) {
        skipWs();
        if (text[pos] !== '"') throw new JsonSyntaxError();
        const key = readString();
        skipWs();
        if (text[pos] !== ":") throw new JsonSyntaxError();
        pos++;
        entries.push({ key, value: parseValue(depth + 1) });
        skipWs();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return { kind: "object", entries };
        }
        throw new JsonSyntaxError();
      }
    }
    if (c === "[") {
      pos++;
      const items: JsonNode[] = [];
      skipWs();
      if (text[pos] === "]") {
        pos++;
        return { kind: "array", items };
      }
      for (;;) {
        items.push(parseValue(depth + 1));
        skipWs();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return { kind: "array", items };
        }
        throw new JsonSyntaxError();
      }
    }
    if (c === '"') return { kind: "string", value: readString() };
    if (text.startsWith("true", pos)) {
      pos += 4;
      return { kind: "boolean", value: true };
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      return { kind: "boolean", value: false };
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      return { kind: "null" };
    }
    NUMBER_RE.lastIndex = pos;
    const m = NUMBER_RE.exec(text);
    if (!m) throw new JsonSyntaxError();
    pos += m[0].length;
    return { kind: "number", raw: m[0] };
  };

  try {
    const root = parseValue(0);
    skipWs();
    if (pos !== len) return null;
    return root;
  } catch (e) {
    // 構文エラー / 深すぎるネストのどちらもテキスト表示へのフォールバックで扱う。
    // それ以外 (想定外) はそのまま投げる。
    if (e instanceof JsonSyntaxError || e instanceof RangeError) return null;
    throw e;
  }
}

/**
 * ノードを JSON テキストへ戻す。`indent` を与えると `JSON.stringify(v, null, indent)`
 * と同じ体裁で整形し、省略すると最小化する。数値は元テキストのまま出力する。
 */
export function serializeJson(node: JsonNode, indent?: number): string {
  const unit = indent && indent > 0 ? " ".repeat(indent) : "";
  const out: string[] = [];
  const write = (n: JsonNode, level: number) => {
    switch (n.kind) {
      case "null":
        out.push("null");
        return;
      case "boolean":
        out.push(n.value ? "true" : "false");
        return;
      case "number":
        out.push(n.raw);
        return;
      case "string":
        out.push(JSON.stringify(n.value));
        return;
      case "array": {
        if (n.items.length === 0) {
          out.push("[]");
          return;
        }
        const inner = unit ? "\n" + unit.repeat(level + 1) : "";
        out.push("[");
        n.items.forEach((item, i) => {
          if (i > 0) out.push(",");
          out.push(inner);
          write(item, level + 1);
        });
        out.push(unit ? "\n" + unit.repeat(level) : "", "]");
        return;
      }
      case "object": {
        if (n.entries.length === 0) {
          out.push("{}");
          return;
        }
        const inner = unit ? "\n" + unit.repeat(level + 1) : "";
        out.push("{");
        n.entries.forEach((entry, i) => {
          if (i > 0) out.push(",");
          out.push(inner, JSON.stringify(entry.key), unit ? ": " : ":");
          write(entry.value, level + 1);
        });
        out.push(unit ? "\n" + unit.repeat(level) : "", "}");
        return;
      }
    }
  };
  write(node, 0);
  return out.join("");
}

/**
 * JSON テキストをロスレスに整形 (`indent` 指定) / 最小化 (`indent` 省略) する。
 * 不正な JSON なら null。`JSON.stringify(JSON.parse(s))` の丸めない版。
 */
export function formatJsonLossless(text: string, indent?: number): string | null {
  const node = parseJsonLossless(text);
  return node ? serializeJson(node, indent) : null;
}

export function isContainer(node: JsonNode): node is Extract<JsonNode, { kind: "object" | "array" }> {
  return node.kind === "object" || node.kind === "array";
}

/** コンテナの子の数 (スカラは 0)。 */
export function childCount(node: JsonNode): number {
  if (node.kind === "object") return node.entries.length;
  if (node.kind === "array") return node.items.length;
  return 0;
}

export interface JsonChild {
  segment: JsonPathSegment;
  node: JsonNode;
}

/**
 * コンテナの子を `[start, end)` の範囲だけ取り出す。描画側はこれで展開済み
 * ノードの見えている分だけを作るため、巨大配列でも一度に全件の要素を生成しない。
 */
export function childSlice(node: JsonNode, start: number, end: number): JsonChild[] {
  if (node.kind === "object") {
    return node.entries.slice(start, end).map((e) => ({ segment: e.key, node: e.value }));
  }
  if (node.kind === "array") {
    const out: JsonChild[] = [];
    const stop = Math.min(end, node.items.length);
    for (let i = start; i < stop; i++) out.push({ segment: i, node: node.items[i] });
    return out;
  }
  return [];
}

/** 展開状態・検索結果を集合で持つためのパスの一意キー。 */
export function pathKey(path: readonly JsonPathSegment[]): string {
  return JSON.stringify(path);
}

/**
 * スカラ値の 1 行プレビュー。文字列は JSON 表記 (引用符付き)、長すぎる値は
 * `max` 文字で切って末尾に `…` を付ける。数値は元テキスト。
 */
export function scalarPreview(node: JsonNode, max = 200): string {
  let s: string;
  switch (node.kind) {
    case "string":
      // 巨大文字列を丸ごと JSON.stringify しないよう、先に切ってからエスケープする。
      s = JSON.stringify(node.value.length > max ? node.value.slice(0, max) : node.value);
      if (node.value.length > max) return s.slice(0, -1) + "…\"";
      return s;
    case "number":
      s = node.raw;
      break;
    case "boolean":
      s = node.value ? "true" : "false";
      break;
    case "null":
      s = "null";
      break;
    default:
      return "";
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 検索で拾うスカラ値の比較用テキスト (文字列は引用符なしの中身)。 */
function scalarSearchText(node: JsonNode): string | null {
  switch (node.kind) {
    case "string":
      return node.value;
    case "number":
      return node.raw;
    case "boolean":
      return node.value ? "true" : "false";
    case "null":
      return "null";
    default:
      return null;
  }
}

/** 取得件数の既定上限。これを超えたら打ち切って `truncated` を立てる。 */
export const JSON_SEARCH_LIMIT = 1000;

export interface JsonSearchResult {
  /** 一致したノードのパスキー (キー名 or スカラ値が一致)。 */
  matches: Set<string>;
  /** 一致ノードの祖先のパスキー (自動展開と子の絞り込みに使う)。ルートを含む。 */
  ancestors: Set<string>;
  /** 一致ノードの順序付きパス (出現順)。 */
  paths: JsonPathSegment[][];
  /** 上限で打ち切ったか。 */
  truncated: boolean;
}

/**
 * キー名とスカラ値を大文字小文字を無視した部分一致で検索する。明示的なスタックで
 * 深さ優先 (文書順) に走査するので、深い入力でも呼び出しスタックを消費しない。
 * 空クエリは null。
 */
export function searchJsonTree(
  root: JsonNode,
  query: string,
  limit = JSON_SEARCH_LIMIT,
): JsonSearchResult | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const matches = new Set<string>();
  const ancestors = new Set<string>();
  const paths: JsonPathSegment[][] = [];
  let truncated = false;

  const stack: { node: JsonNode; path: JsonPathSegment[] }[] = [{ node: root, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    const last = path[path.length - 1];
    const keyHit = typeof last === "string" && last.toLowerCase().includes(needle);
    const text = scalarSearchText(node);
    const valueHit = text !== null && text.toLowerCase().includes(needle);
    if (keyHit || valueHit) {
      if (paths.length >= limit) {
        truncated = true;
        break;
      }
      matches.add(pathKey(path));
      paths.push(path);
      for (let i = 0; i < path.length; i++) ancestors.add(pathKey(path.slice(0, i)));
    }
    // 文書順に取り出せるよう、子は逆順で積む。
    const n = childCount(node);
    if (n > 0) {
      const kids = childSlice(node, 0, n);
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ node: kids[i].node, path: [...path, kids[i].segment] });
      }
    }
  }
  return { matches, ancestors, paths, truncated };
}

/** パスを辿ってノードを取り出す (無ければ null)。 */
export function nodeAtPath(root: JsonNode, path: readonly JsonPathSegment[]): JsonNode | null {
  let cur: JsonNode = root;
  for (const seg of path) {
    if (cur.kind === "object" && typeof seg === "string") {
      // 重複キーは MySQL / PostgreSQL (jsonb) と同じく最後の値を採る。
      let found: JsonNode | null = null;
      for (const e of cur.entries) if (e.key === seg) found = e.value;
      if (!found) return null;
      cur = found;
    } else if (cur.kind === "array" && typeof seg === "number") {
      const next = cur.items[seg];
      if (!next) return null;
      cur = next;
    } else {
      return null;
    }
  }
  return cur;
}

const PLAIN_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * SQL/JSON パス表記 (`$.a.b[0]`)。識別子として安全でないキー (空白・記号・数字
 * 始まり・空文字など) は `$."a b"` のように二重引用符で囲む。この表記は MySQL /
 * SQLite / DuckDB / SQL Server / PostgreSQL jsonpath が共通して受け付ける。
 */
export function formatJsonPath(path: readonly JsonPathSegment[]): string {
  let s = "$";
  for (const seg of path) {
    if (typeof seg === "number") s += `[${seg}]`;
    else if (PLAIN_KEY_RE.test(seg)) s += `.${seg}`;
    else s += `.${JSON.stringify(seg)}`;
  }
  return s;
}

/** SQL 文字列リテラル (方言ごとのエスケープは既存のセル編集と共有)。 */
function sqlString(driver: string, s: string): string {
  return literalFromCellValue(driver, s);
}

/**
 * パスが指す値を取り出す方言別の SQL 式。`scalar` が真ならテキスト/スカラとして
 * (PostgreSQL `->>`、MySQL `JSON_UNQUOTE(JSON_EXTRACT(...))`、MSSQL `JSON_VALUE`)、
 * 偽なら JSON 断片として (PostgreSQL `->`、MySQL `JSON_EXTRACT`、MSSQL
 * `JSON_QUERY`) 取り出す。ルート (空パス) は列そのもの。未知のドライバは MySQL 扱い
 * (`quoteIdentFor` と同じ規約)。MariaDB が `->>` を持たないため MySQL は関数形で書く。
 */
export function jsonPathSqlExpression(
  driver: string,
  column: string,
  path: readonly JsonPathSegment[],
  scalar: boolean,
): string {
  const col = quoteIdentFor(driver, column);
  if (path.length === 0) return col;
  if (driver === "postgres") {
    let expr = col;
    path.forEach((seg, i) => {
      const op = scalar && i === path.length - 1 ? "->>" : "->";
      expr += ` ${op} ${typeof seg === "number" ? String(seg) : sqlString(driver, seg)}`;
    });
    return expr;
  }
  const p = sqlString(driver, formatJsonPath(path));
  switch (driver) {
    case "sqlite":
      return `json_extract(${col}, ${p})`;
    case "duckdb":
      return scalar ? `json_extract_string(${col}, ${p})` : `json_extract(${col}, ${p})`;
    case "mssql":
      return scalar ? `JSON_VALUE(${col}, ${p})` : `JSON_QUERY(${col}, ${p})`;
    default:
      return scalar ? `JSON_UNQUOTE(JSON_EXTRACT(${col}, ${p}))` : `JSON_EXTRACT(${col}, ${p})`;
  }
}

/**
 * パスの値が `node` (スカラ) と等しい行を選ぶ WHERE 述語。コンテナ・ルートは null。
 *
 * 数値は元テキストのまま埋め込み、比較は方言ごとに数値として行う (PostgreSQL は
 * `::numeric` で任意精度、SQL Server は `JSON_VALUE` が元テキストを返すので文字列
 * 比較)。JSON の null はパス欠如とも一致する `IS NULL` になる (MySQL のみ
 * `JSON_TYPE` で null 値を区別する)。
 */
export function jsonPathSqlPredicate(
  driver: string,
  column: string,
  path: readonly JsonPathSegment[],
  node: JsonNode,
): string | null {
  if (path.length === 0 || isContainer(node)) return null;
  const scalarExpr = jsonPathSqlExpression(driver, column, path, true);
  const isMysql = !["postgres", "sqlite", "duckdb", "mssql"].includes(driver);
  switch (node.kind) {
    case "null":
      if (isMysql) {
        return `JSON_TYPE(${jsonPathSqlExpression(driver, column, path, false)}) = 'NULL'`;
      }
      return `${scalarExpr} IS NULL`;
    case "string":
      return `${scalarExpr} = ${sqlString(driver, node.value)}`;
    case "boolean":
      // SQLite の json_extract は真偽を 1/0 の整数で返す。他はテキスト 'true'/'false'。
      if (driver === "sqlite") return `${scalarExpr} = ${node.value ? 1 : 0}`;
      return `${scalarExpr} = ${sqlString(driver, node.value ? "true" : "false")}`;
    case "number":
      switch (driver) {
        case "postgres":
          return `(${scalarExpr})::numeric = ${node.raw}`;
        case "sqlite":
          return `${scalarExpr} = ${node.raw}`;
        case "duckdb":
          return `TRY_CAST(${scalarExpr} AS DOUBLE) = ${node.raw}`;
        case "mssql":
          return `${scalarExpr} = ${sqlString(driver, node.raw)}`;
        default:
          return `${jsonPathSqlExpression(driver, column, path, false)} = ${node.raw}`;
      }
  }
}
