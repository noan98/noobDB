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
 *   WHERE 述語 (PostgreSQL `->`/`->>`、MySQL `JSON_EXTRACT`、SQLite `json_extract`)
 *   を生成する。生成した SQL はクリップボードへコピーするだけで、DB へは何も
 *   書き込まない。
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
      if (node.value.length > max) return s.slice(0, -1) + '…"';
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

  // 子ごとにパス配列を複製しない。フレームには (ノード, 親フレーム, 自身のセグメント, 次の子の
  // 添字) だけを積み、一致したときにだけ親鎖からパスを組み立てる。
  interface Frame {
    node: JsonNode;
    parent: Frame | null;
    segment: JsonPathSegment | null;
    next: number;
    count: number;
  }
  const buildPath = (parent: Frame | null, segment: JsonPathSegment | null): JsonPathSegment[] => {
    const out: JsonPathSegment[] = [];
    if (segment !== null) out.push(segment);
    for (let f = parent; f !== null; f = f.parent) {
      if (f.segment !== null) out.push(f.segment);
    }
    return out.reverse();
  };
  // ノードを訪問 (一致判定)。打ち切りになったら true。
  const visit = (node: JsonNode, parent: Frame | null, segment: JsonPathSegment | null): boolean => {
    const keyHit = typeof segment === "string" && segment.toLowerCase().includes(needle);
    const text = scalarSearchText(node);
    const valueHit = text !== null && text.toLowerCase().includes(needle);
    if (!keyHit && !valueHit) return false;
    if (paths.length >= limit) {
      truncated = true;
      return true;
    }
    const path = buildPath(parent, segment);
    matches.add(pathKey(path));
    paths.push(path);
    for (let i = 0; i < path.length; i++) ancestors.add(pathKey(path.slice(0, i)));
    return false;
  };

  const frames: Frame[] = [];
  if (!visit(root, null, null)) {
    const n = childCount(root);
    if (n > 0) frames.push({ node: root, parent: null, segment: null, next: 0, count: n });
  }
  while (frames.length > 0 && !truncated) {
    const frame = frames[frames.length - 1];
    if (frame.next >= frame.count) {
      frames.pop();
      continue;
    }
    const i = frame.next++;
    let child: JsonNode;
    let seg: JsonPathSegment;
    if (frame.node.kind === "object") {
      const e = frame.node.entries[i];
      child = e.value;
      seg = e.key;
    } else if (frame.node.kind === "array") {
      child = frame.node.items[i];
      seg = i;
    } else {
      frames.pop();
      continue;
    }
    if (visit(child, frame, seg)) break;
    const n = childCount(child);
    if (n > 0) frames.push({ node: child, parent: frame, segment: seg, next: 0, count: n });
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
 * SQLite / PostgreSQL jsonpath が共通して受け付ける。
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
 * (PostgreSQL `->>`、MySQL `JSON_UNQUOTE(JSON_EXTRACT(...))`)、偽なら JSON 断片
 * として (PostgreSQL `->`、MySQL `JSON_EXTRACT`) 取り出す。ルート (空パス) は
 * 列そのもの。未知のドライバは MySQL 扱い (`quoteIdentFor` と同じ規約)。
 * MariaDB が `->>` を持たないため MySQL は関数形で書く。
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
    default:
      return scalar ? `JSON_UNQUOTE(JSON_EXTRACT(${col}, ${p}))` : `JSON_EXTRACT(${col}, ${p})`;
  }
}

/**
 * パスの値が `node` (スカラ) と等しい行を選ぶ WHERE 述語。コンテナ・ルートは null。
 *
 * 数値は元テキストのまま埋め込み、比較は方言ごとに数値として行う (PostgreSQL は
 * `::numeric` で任意精度)。JSON の null はパス欠如とも一致する `IS NULL` になる
 * (MySQL のみ `JSON_TYPE` で null 値を区別する)。
 */
export function jsonPathSqlPredicate(
  driver: string,
  column: string,
  path: readonly JsonPathSegment[],
  node: JsonNode,
): string | null {
  if (path.length === 0 || isContainer(node)) return null;
  const scalarExpr = jsonPathSqlExpression(driver, column, path, true);
  const isMysql = !["postgres", "sqlite"].includes(driver);
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
        default:
          return `${jsonPathSqlExpression(driver, column, path, false)} = ${node.raw}`;
      }
  }
}

/**
 * 選択ノードを書き換える `UPDATE` 文を方言別に組み立てる (#1541)。クリップボードへ
 * コピーするだけで実行はしない。値は**現在のノードの内容**を JSON として埋め込むので、
 * 貼り付けた後に新しい値へ書き換えて使う。
 *
 * - PostgreSQL: `jsonb_set(col::jsonb, '{"a","0"}', '<json>'::jsonb)`。パスは text[] リテラル
 *   (各要素を二重引用符で囲み `\` と `"` をエスケープ) を SQL 文字列として渡す。json 型の列でも
 *   `::jsonb` を経由する。JSON の null は SQL の NULL ではなく `'null'::jsonb` にする
 *   (SQL NULL を渡すと jsonb_set の結果ごと NULL になるため)。
 * - MySQL: `JSON_SET(col, '$.a[0]', JSON_EXTRACT('<json>', '$'))`。
 * - SQLite: `json_set(col, '$.a[0]', json('<json>'))` (`json()` で文字列でなく JSON として扱わせる)。
 *
 * パス・値・テーブル参照はすべて既存の引用ヘルパー (`sqlString` / `quoteIdentFor`) を通すので、
 * キーや文字列値に含まれる引用符は SQL に漏れない。`where` は呼び出し側が行の主キーから
 * 作った述語 (`buildRowWhere`)。ルート (空パス)、および SQLite で `"` / `\` を含むキーを
 * 通るパス (JSON パスで表せない) は null。
 *
 * PostgreSQL の `json` 型の列は `::jsonb` を経由して書き戻されるため、更新後はキーの順序・重複キー・
 * 空白・数値の表記が jsonb 流に正規化される (`jsonb` 列では変わらない)。
 */
export function jsonPathSqlUpdate(
  driver: string,
  tableRef: string,
  column: string,
  path: readonly JsonPathSegment[],
  node: JsonNode,
  where: string,
): string | null {
  if (path.length === 0 || where.trim() === "") return null;
  // SQLite の JSON パスは引用符付きキーの中のエスケープを解釈しない (`"` や `\` を含むキーは
  // 別のキーとして追加されてしまう) ので、安全に表せないパスは生成しない。
  if (driver === "sqlite" && path.some((seg) => typeof seg === "string" && /["\\]/.test(seg))) {
    return null;
  }
  const col = quoteIdentFor(driver, column);
  const json = sqlString(driver, serializeJson(node));
  let set: string;
  if (driver === "postgres") {
    const arr =
      "{" +
      path.map((seg) => '"' + String(seg).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") +
      "}";
    set = `jsonb_set(${col}::jsonb, ${sqlString(driver, arr)}, ${json}::jsonb)`;
  } else if (driver === "sqlite") {
    set = `json_set(${col}, ${sqlString(driver, formatJsonPath(path))}, json(${json}))`;
  } else {
    set = `JSON_SET(${col}, ${sqlString(driver, formatJsonPath(path))}, JSON_EXTRACT(${json}, '$'))`;
  }
  return `UPDATE ${tableRef} SET ${col} = ${set} WHERE ${where};`;
}

/**
 * RFC 6901 の JSON Pointer (`/a/0/b`)。ルートは空文字。キー中の `~` は `~0`、`/` は `~1` に
 * エスケープする (`~` を先に置換する)。アプリケーションコードや JSON Patch に貼れる形式 (#1628)。
 */
export function formatJsonPointer(path: readonly JsonPathSegment[]): string {
  return path.map((seg) => `/${String(seg).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** 深さ指定の一括展開で展開するコンテナ数の上限 (巨大 JSON で Set が膨らまないように)。 */
export const JSON_EXPAND_LIMIT = 5000;

/**
 * ルートから `depth` 段目より浅いコンテナの `pathKey` 集合 (#1628)。`depth = 1` はルートだけ、
 * `Infinity` は全コンテナ。コンテナ数が `JSON_EXPAND_LIMIT` に達したら打ち切り、`truncated` を立てる。
 * 描画は従来どおり 1 ノードあたり `CHILD_PAGE_SIZE` 件までなので、ここで開いても描画量は抑えられる。
 * 明示的なスタックで走査し、深いネストでも再帰が溢れない。
 */
export function expandKeysToDepth(
  root: JsonNode,
  depth: number,
  limit = JSON_EXPAND_LIMIT,
): { keys: Set<string>; truncated: boolean } {
  const keys = new Set<string>();
  let truncated = false;
  const stack: { node: JsonNode; path: JsonPathSegment[]; level: number }[] = [
    { node: root, path: [], level: 0 },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || !isContainer(cur.node) || cur.level >= depth) continue;
    if (keys.size >= limit) {
      truncated = true;
      break;
    }
    keys.add(pathKey(cur.path));
    for (const c of childSlice(cur.node, 0, childCount(cur.node))) {
      if (isContainer(c.node))
        stack.push({ node: c.node, path: [...cur.path, c.segment], level: cur.level + 1 });
    }
  }
  return { keys, truncated };
}

type ColumnKind = "number" | "string" | "boolean" | "json";

/** 行展開 SQL で列を作るキー数の上限。 */
const ROWS_SQL_MAX_COLUMNS = 30;
/** 列・型の推定に見る要素数の上限。 */
const ROWS_SQL_SAMPLE = 200;

/** 要素の値種別 (null は型を決めないので undefined)。 */
function kindOf(node: JsonNode): ColumnKind | undefined {
  switch (node.kind) {
    case "number":
    case "string":
    case "boolean":
      return node.kind;
    case "null":
      return undefined;
    default:
      return "json";
  }
}

function mergeKind(cur: ColumnKind | undefined, next: ColumnKind | undefined): ColumnKind | undefined {
  if (next === undefined) return cur;
  if (cur === undefined) return next;
  return cur === next ? cur : "json";
}

/** 配列要素から列 (オブジェクトの共通キーと推定型) を求める。オブジェクト以外が混じるなら null (スカラ展開)。 */
function inferRowColumns(items: readonly JsonNode[]): { key: string; kind: ColumnKind }[] | null {
  const sample = items.slice(0, ROWS_SQL_SAMPLE);
  if (sample.length === 0 || sample.some((n) => n.kind !== "object")) return null;
  const cols = new Map<string, ColumnKind | undefined>();
  for (const n of sample) {
    if (n.kind !== "object") continue;
    const seen = new Set<string>();
    for (const e of n.entries) {
      // JSON パスで表せないキー (SQLite は `"` / `\` を解釈しない) は列にしない。
      if (/["\\]/.test(e.key) || seen.has(e.key)) continue;
      seen.add(e.key);
      if (cols.size >= ROWS_SQL_MAX_COLUMNS && !cols.has(e.key)) continue;
      cols.set(e.key, mergeKind(cols.get(e.key), kindOf(e.value)));
    }
  }
  const out = [...cols].map(([key, kind]) => ({ key, kind: kind ?? ("json" as ColumnKind) }));
  return out.length > 0 ? out : null;
}

function scalarKind(items: readonly JsonNode[]): ColumnKind {
  let k: ColumnKind | undefined;
  for (const n of items.slice(0, ROWS_SQL_SAMPLE)) k = mergeKind(k, kindOf(n));
  return k ?? "json";
}

const MYSQL_COLUMN_TYPE: Record<ColumnKind, string> = {
  number: "DOUBLE",
  string: "TEXT",
  boolean: "JSON",
  json: "JSON",
};
const POSTGRES_COLUMN_TYPE: Record<ColumnKind, string> = {
  number: "numeric",
  string: "text",
  boolean: "boolean",
  json: "jsonb",
};

/**
 * 選択中の JSON 配列を**行として**取り出す SELECT を方言別に組み立てる (#1628)。クリップボードへ
 * コピーするだけで実行はしない (`jsonPathSqlExpression` / `jsonPathSqlUpdate` と同じ方針)。
 *
 * - MySQL: `JSON_TABLE(col, '$.a[*]' COLUMNS (...))`
 * - PostgreSQL: オブジェクト配列は `jsonb_to_recordset(...) AS x(col type, ...)`、スカラ配列は
 *   `jsonb_array_elements(...)`
 * - SQLite: `json_each(col, '$.a')` と `json_extract(j.value, '$.k')`
 *
 * 要素が全てオブジェクトならキーごとに列を作り (最大 30 列、型は要素から推定)、そうでなければ
 * `value` 1 列に展開する。`where` があれば PostgreSQL / SQLite は先に 1 行へ絞った副問い合わせを展開元に
 * する (MySQL は JSON_TABLE の制約で外側の WHERE)。配列でないノードは null。
 */
export function jsonArrayRowsSql(
  driver: string,
  tableRef: string,
  column: string,
  path: readonly JsonPathSegment[],
  node: JsonNode,
  where: string | null,
): string | null {
  if (node.kind !== "array") return null;
  if (driver === "sqlite" && path.some((seg) => typeof seg === "string" && /["\\]/.test(seg))) return null;
  const col = quoteIdentFor(driver, column);
  const w = where && where.trim() !== "" ? ` WHERE ${where}` : "";
  const src = `(SELECT ${col} FROM ${tableRef}${w}) AS t`;
  const cols = inferRowColumns(node.items);
  const qi = (n: string) => quoteIdentFor(driver, n);
  const valueKind = scalarKind(node.items);

  if (driver === "postgres") {
    const arrPath =
      "{" +
      path.map((seg) => '"' + String(seg).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") +
      "}";
    const arr = path.length === 0 ? `t.${col}::jsonb` : `(t.${col}::jsonb #> ${sqlString(driver, arrPath)})`;
    if (cols) {
      const defs = cols.map((c) => `${qi(c.key)} ${POSTGRES_COLUMN_TYPE[c.kind]}`).join(", ");
      return `SELECT x.*\nFROM ${src}\nCROSS JOIN LATERAL jsonb_to_recordset(${arr}) AS x(${defs});`;
    }
    return `SELECT x.value\nFROM ${src}\nCROSS JOIN LATERAL jsonb_array_elements(${arr}) AS x(value);`;
  }
  if (driver === "sqlite") {
    const p = path.length === 0 ? "" : `, ${sqlString(driver, formatJsonPath(path))}`;
    const sel = cols
      ? cols
          .map((c) => `json_extract(j.value, ${sqlString(driver, formatJsonPath([c.key]))}) AS ${qi(c.key)}`)
          .join(",\n       ")
      : "j.value AS value";
    return `SELECT ${sel}\nFROM ${src}, json_each(t.${col}${p}) AS j;`;
  }
  // MySQL (未知のドライバも MySQL 扱い)。JSON_TABLE は派生テーブルの列を引数にできない (ERROR 1210)
  // ので、テーブルを直接 FROM に置き、主キー述語は外側の WHERE に書く。展開列の名前が WHERE 内の
  // 列名と衝突すると曖昧になるため、衝突する展開列だけ出力名の末尾に `_` を付ける (PATH は元のキーのまま)。
  const arrPath = sqlString(driver, `${formatJsonPath(path)}[*]`);
  const outName = (key: string) => (w !== "" && where?.includes(qi(key)) ? `${key}_` : key);
  const defs = cols
    ? cols
        .map(
          (c) =>
            `${qi(outName(c.key))} ${MYSQL_COLUMN_TYPE[c.kind]} PATH ${sqlString(driver, formatJsonPath([c.key]))}`,
        )
        .join(",\n    ")
    : `${qi(outName("value"))} ${MYSQL_COLUMN_TYPE[valueKind]} PATH '$'`;
  return `SELECT jt.*\nFROM ${tableRef} AS t,\nJSON_TABLE(t.${col}, ${arrPath} COLUMNS (\n    ${defs}\n)) AS jt${w};`;
}
