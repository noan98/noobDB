// INSERT ... VALUES の「列リストと値のタプルの対応付け」の純ロジック (#2424)。
//
// エディタの VALUES 列名インレイヒント (`insertHintsExtension.ts`) と、値の数の不一致を警告する lint
// (`sqlSemanticLint.ts` の `insertArityDiagnostics`) が共有する。DOM / CodeMirror に触れないので Vitest で
// 境界ケース (文字列・コメント・括弧のネスト・3 ドライバの引用符) を固定する。
//
// 方針は「見逃しても誤検出しない」。次のものは対象外 (解析を打ち切って次の `;` まで読み飛ばす)。
// - `INSERT ... SELECT` / `DEFAULT VALUES` / MySQL の `INSERT ... SET` / `WITH ... INSERT`
// - 文の先頭が INSERT / REPLACE でないもの (ストアドの本体に埋まった INSERT は `;` 区切りの先頭なら拾う)
//
// 走査は 1 回のストリーミング (トークン配列を持たない) で、`to` を超えたところで止まる。1 万行の
// INSERT でも表示範囲までしか読まず、範囲外の行は値の位置を保持しない (件数だけ数える)。

/** 文書内の範囲 (`from` 以上 `to` 未満)。 */
export interface Span {
  from: number;
  to: number;
}

/** 列リストの 1 列。`name` は引用符を外した元の綴り、`norm` は小文字化したもの。 */
export interface InsertColumn extends Span {
  name: string;
  norm: string;
}

/** VALUES の 1 タプル。`values` は走査範囲と重なる行だけ保持する (範囲外は null)。 */
export interface InsertRow extends Span {
  /** 値の数。`()` は 0、`(1,)` のような空の値も数える。 */
  count: number;
  values: Span[] | null;
  /** 閉じ括弧に達する前に走査範囲の末尾で打ち切られた行。値の数は不完全。 */
  partial: boolean;
}

/** 1 つの `INSERT ... VALUES` 文。 */
export interface InsertStatement {
  /** 文の先頭 (INSERT / REPLACE の位置)。 */
  from: number;
  /** 表名 (最後の要素、小文字)。 */
  table: string;
  /** `schema.table` の `schema` (小文字)。修飾が無ければ null。 */
  qualifier: string | null;
  /** 明示された列リスト。省略 (または空 `()`) は null。 */
  columns: InsertColumn[] | null;
  rows: InsertRow[];
  /** `maxRows` に達して以降の行を読まなかった。 */
  truncated: boolean;
}

export interface ScanOptions {
  /** `postgres` / `sqlite` / それ以外は MySQL 系として扱う。 */
  driver?: string | null;
  /** 値の位置を保持する範囲の先頭。既定は 0。 */
  from?: number;
  /** ここを超えたら走査を止める。既定は文書末尾まで。 */
  to?: number;
  /** 1 文あたりに読む行数の上限。既定は無制限。 */
  maxRows?: number;
  /**
   * `from` が文書の奥にあるとき、文書の先頭から全部は読まず、`from` を含む文の先頭 (直前の `;` + 改行) から読み、
   * 巨大な VALUES は `from` 直前のタプルの境界 (`), (`) へ飛ぶ (ヒューリスティック)。表示範囲だけが欲しい
   * エディタ向け。境界を誤っても、その表示範囲のヒントが欠けるか不正確になるだけで、警告には使わない。
   */
  seek?: boolean;
}

/** `seek` でタプルの境界を探すときに `from` から遡る最大文字数。 */
const SEEK_WINDOW = 20_000;
/** `from` がこれ以上先頭から離れているときだけ飛ぶ。 */
const SEEK_MIN_DISTANCE = 2_000;

// ---------------------------------------------------------------------------
// トークナイザ
// ---------------------------------------------------------------------------

type TokKind = "word" | "qid" | "str" | "num" | "punct" | "bad";

interface Tok {
  kind: TokKind;
  /** word は小文字化、qid は引用符を外して小文字化、punct はその文字。 */
  norm: string;
  /** qid は引用符を外した元の綴り。word はそのまま。 */
  raw: string;
  from: number;
  to: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
const SQLITE_BRACKET = /\[[^\]\n]+\]/y;

/** 開き引用符の位置 `start` から、閉じ引用符の次の位置を返す。閉じていなければ -1。 */
function scanQuoted(text: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (backslash && c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

/** 区切りのトークンをコールバックへ渡す。コールバックが false を返したら止める。 */
function forEachToken(
  text: string,
  driver: string | null | undefined,
  cb: (t: Tok) => boolean,
  startAt = 0,
): void {
  const postgres = driver === "postgres";
  const sqlite = driver === "sqlite";
  const mysql = !postgres && !sqlite;
  const n = text.length;
  const emit = (kind: TokKind, from: number, to: number, norm?: string, raw?: string) =>
    cb({ kind, norm: norm ?? text.slice(from, to), raw: raw ?? text.slice(from, to), from, to });
  let i = startAt;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "#" && mysql) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      // PostgreSQL のブロックコメントは入れ子にできる (MySQL / SQLite はできない)。
      let end = -1;
      if (postgres) {
        let depth = 1;
        let k = i + 2;
        while (k < n && depth > 0) {
          if (text[k] === "/" && text[k + 1] === "*") {
            depth++;
            k += 2;
          } else if (text[k] === "*" && text[k + 1] === "/") {
            depth--;
            k += 2;
          } else k++;
        }
        end = depth === 0 ? k - 2 : -1;
      } else {
        end = text.indexOf("*/", i + 2);
      }
      if (end < 0) {
        emit("bad", i, n);
        return;
      }
      i = end + 2;
      continue;
    }
    if (c === "'" || (c === '"' && mysql)) {
      const end = scanQuoted(text, i, c, mysql);
      if (end < 0) {
        emit("bad", i, n);
        return;
      }
      if (!emit("str", i, end)) return;
      i = end;
      continue;
    }
    if (c === '"' || (c === "`" && !postgres)) {
      const end = scanQuoted(text, i, c, false);
      if (end < 0) {
        emit("bad", i, n);
        return;
      }
      const raw = text
        .slice(i + 1, end - 1)
        .split(c + c)
        .join(c);
      if (!emit("qid", i, end, raw.toLowerCase(), raw)) return;
      i = end;
      continue;
    }
    if (c === "[" && sqlite) {
      SQLITE_BRACKET.lastIndex = i;
      const m = SQLITE_BRACKET.exec(text);
      if (m) {
        const raw = m[0].slice(1, -1);
        if (!emit("qid", i, i + m[0].length, raw.toLowerCase(), raw)) return;
        i += m[0].length;
        continue;
      }
    }
    if (c === "$" && postgres) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(text);
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        if (end < 0) {
          emit("bad", i, n);
          return;
        }
        if (!emit("str", i, end + m[0].length)) return;
        i = end + m[0].length;
        continue;
      }
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j])) j++;
      // E'..' / B'..' / X'..' / N'..' の接頭辞は文字列の一部。
      if (j === i + 1 && text[j] === "'" && /[eEbBxXnN]/.test(c)) {
        const end = scanQuoted(text, j, "'", c === "e" || c === "E" || mysql);
        if (end < 0) {
          emit("bad", i, n);
          return;
        }
        if (!emit("str", i, end)) return;
        i = end;
        continue;
      }
      const raw = text.slice(i, j);
      if (!emit("word", i, j, raw.toLowerCase(), raw)) return;
      i = j;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && text[i + 1] >= "0" && text[i + 1] <= "9")) {
      let j = i + 1;
      while (j < n && ((text[j] >= "0" && text[j] <= "9") || text[j] === ".")) j++;
      if ((text[j] === "e" || text[j] === "E") && /[\d+-]/.test(text[j + 1] ?? "")) {
        j += 2;
        while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      }
      if (!emit("num", i, j)) return;
      i = j;
      continue;
    }
    if (!emit("punct", i, i + 1)) return;
    i++;
  }
}

// ---------------------------------------------------------------------------
// INSERT ... VALUES の走査
// ---------------------------------------------------------------------------

const MODIFIERS = new Set([
  "or",
  "ignore",
  "low_priority",
  "delayed",
  "high_priority",
  "replace",
  "abort",
  "fail",
  "rollback",
]);

type State =
  | "start"
  | "skip"
  | "head"
  | "table"
  | "alias"
  | "cols"
  | "afterCols"
  | "overriding"
  | "rowsExpect"
  | "inRow"
  | "afterRow";

const isName = (t: Tok) => t.kind === "word" || t.kind === "qid";
const isPunct = (t: Tok, ch: string) => t.kind === "punct" && t.norm === ch;
const isWord = (t: Tok, ...ws: string[]) => t.kind === "word" && ws.includes(t.norm);

/** `pos` より前で最後の「`;` + 改行」の直後。無ければ 0 (文字列の値に `;` が混ざっても拾いにくい形だけを見る)。 */
function statementStartBefore(text: string, pos: number): number {
  const a = text.lastIndexOf(";\n", pos - 1);
  const b = text.lastIndexOf(";\r\n", pos - 1);
  const m = Math.max(a, b);
  return m < 0 ? 0 : m + 1;
}

/**
 * 最初のタプル (`firstRow`) より先にある `from` の直前の、タプルの境界 (`) , (`) の `(` の位置。
 * `from` から `SEEK_WINDOW` 文字だけ遡って探し、無ければ -1 (飛ばない)。
 */
function findRowBoundary(text: string, firstRow: number, from: number): number {
  if (from - firstRow < SEEK_MIN_DISTANCE) return -1;
  const start = Math.max(firstRow + 1, from - SEEK_WINDOW);
  const re = /\)\s*,\s*\(/g;
  const win = text.slice(start, Math.min(text.length, from + 1));
  let last = -1;
  for (let m = re.exec(win); m; m = re.exec(win)) last = start + m.index + m[0].length - 1;
  return last;
}

/**
 * `text` の `INSERT ... VALUES` 文を列リストと各タプルの値の範囲つきで返す。
 * `opts.to` を超えたトークンは読まない。壊れた (引用符が閉じていない) 箇所に達したら、そこまでの結果を返す。
 */
export function scanInsertValues(text: string, opts: ScanOptions = {}): InsertStatement[] {
  const rangeFrom = opts.from ?? 0;
  const rangeTo = opts.to ?? Number.POSITIVE_INFINITY;
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const out: InsertStatement[] = [];

  let state: State = "start";
  let stmtFrom = 0;
  let chain: Tok[] = [];
  let expectName = false;
  let aliased = false;
  let columns: InsertColumn[] = [];
  let expectCol = true;
  let colCount = 0;
  let skipLeft = 0;
  let cur: InsertStatement | null = null;
  // 現在の行
  let depth = 0;
  let rowFrom = 0;
  let count = 0;
  let vals: Span[] = [];
  let valFrom = -1;
  let valTo = -1;
  // seek 用
  let seeking = !!opts.seek && rangeFrom > 0;
  let resumeAt = -1;

  const abort = () => {
    state = "skip";
    cur = null;
  };
  const closeValue = (at: number) => {
    vals.push(valFrom >= 0 ? { from: valFrom, to: valTo } : { from: at, to: at });
    count++;
    valFrom = -1;
  };
  /** 閉じていない行を、そこまでの値で途中の行として積む (入力中・表示範囲の端で切れた行)。 */
  const pushPartial = (to: number) => {
    if (valFrom >= 0) closeValue(to);
    pushRow(to, true);
  };
  const pushRow = (to: number, partial: boolean) => {
    if (!cur) return;
    const overlaps = to >= rangeFrom && rowFrom <= rangeTo;
    cur.rows.push({ from: rowFrom, to, count, values: overlaps ? vals : null, partial });
  };
  const enterTable = () => {
    state = "table";
    expectName = true;
    aliased = false;
    chain = [];
  };
  /** 表名の確定。`INSERT INTO a.b.c` の最後と、その手前の要素を使う。 */
  const beginStatement = (colList: InsertColumn[] | null) => {
    const last = chain[chain.length - 1];
    cur = {
      from: stmtFrom,
      table: last.norm,
      qualifier: chain.length >= 2 ? chain[chain.length - 2].norm : null,
      columns: colList && colList.length > 0 ? colList : null,
      rows: [],
      truncated: false,
    };
  };

  const handle = (t: Tok): boolean => {
    if (t.kind === "bad") {
      return false;
    }
    if (t.from > rangeTo) {
      if (state === "inRow" && cur) {
        pushPartial(t.from);
        state = "skip";
      }
      return false;
    }
    if (isPunct(t, ";")) {
      // 閉じていない行の途中でも `;` で文が終わる (入力中に後続の文を飲み込まない)。途中の行は残す。
      if (state === "inRow" && cur) pushPartial(t.from);
      state = "start";
      cur = null;
      return true;
    }
    switch (state) {
      case "skip":
        return true;
      case "start":
        if (isWord(t, "insert", "replace")) {
          state = "head";
          stmtFrom = t.from;
        } else {
          state = "skip";
        }
        return true;
      case "head":
        if (isWord(t, "into")) enterTable();
        else if (isWord(t, ...MODIFIERS)) return true;
        else if (isName(t)) {
          // INTO を省略した MySQL の `INSERT t VALUES ...`。
          state = "table";
          expectName = false;
          aliased = false;
          chain = [t];
        } else abort();
        return true;
      case "table":
        if (expectName) {
          if (isName(t)) {
            chain.push(t);
            expectName = false;
          } else abort();
          return true;
        }
        if (isPunct(t, ".")) {
          expectName = true;
        } else if (isWord(t, "as") && !aliased) {
          state = "alias";
        } else if (isPunct(t, "(")) {
          state = "cols";
          columns = [];
          expectCol = true;
          colCount = 0;
        } else if (isWord(t, "values", "value")) {
          beginStatement(null);
          state = "rowsExpect";
        } else if (isWord(t, "overriding")) {
          state = "overriding";
          skipLeft = 2;
        } else abort();
        return true;
      case "alias":
        if (isName(t)) {
          aliased = true;
          state = "table";
        } else abort();
        return true;
      case "cols":
        if (isPunct(t, ")")) {
          beginStatement(columns);
          state = "afterCols";
        } else if (isPunct(t, ",")) {
          expectCol = true;
        } else if (expectCol && isName(t) && !(colCount === 0 && isWord(t, "select", "with"))) {
          columns.push({ from: t.from, to: t.to, name: t.raw, norm: t.norm });
          expectCol = false;
          colCount++;
        } else abort();
        return true;
      case "afterCols":
        if (isWord(t, "values", "value")) state = "rowsExpect";
        else if (isWord(t, "overriding")) {
          state = "overriding";
          skipLeft = 2;
        } else abort();
        return true;
      case "overriding":
        // OVERRIDING SYSTEM|USER VALUE の残り 2 語を読み飛ばし、その次の VALUES を待つ。
        if (skipLeft > 0) {
          skipLeft--;
          return true;
        }
        if (isWord(t, "values", "value")) {
          if (!cur) beginStatement(columns.length > 0 ? columns : null);
          state = "rowsExpect";
        } else abort();
        return true;
      case "rowsExpect":
        if (isWord(t, "row")) return true;
        if (isPunct(t, "(")) {
          if (!cur) {
            abort();
            return true;
          }
          if (seeking) {
            // 最初のタプルに来た。表示範囲がずっと先なら、その直前のタプルの境界へ飛ぶ。
            seeking = false;
            const target = findRowBoundary(text, t.from, rangeFrom);
            if (target > t.from) {
              resumeAt = target;
              return false;
            }
          }
          if (cur.rows.length === 0 && !out.includes(cur)) out.push(cur);
          state = "inRow";
          depth = 1;
          rowFrom = t.from;
          count = 0;
          vals = [];
          valFrom = -1;
        } else abort();
        return true;
      case "inRow": {
        const open = isPunct(t, "(") || isPunct(t, "[");
        const close = isPunct(t, ")") || isPunct(t, "]");
        if (open) depth++;
        if (close) {
          depth--;
          if (depth === 0) {
            if (valFrom >= 0 || count > 0) closeValue(t.from);
            pushRow(t.to, false);
            state = "afterRow";
            return true;
          }
        }
        if (depth === 1 && isPunct(t, ",")) {
          closeValue(t.from);
          return true;
        }
        if (valFrom < 0) valFrom = t.from;
        valTo = t.to;
        return true;
      }
      case "afterRow":
        if (isPunct(t, ",")) {
          if (cur && cur.rows.length >= maxRows) {
            cur.truncated = true;
            abort();
          } else state = "rowsExpect";
        } else abort();
        return true;
    }
  };

  let startAt = 0;
  if (seeking) startAt = statementStartBefore(text, rangeFrom);
  forEachToken(text, opts.driver, handle, startAt);
  if (resumeAt >= 0) {
    // 飛び先はタプルの開き括弧。ヘッダ (cur) を引き継いで、そこから読み直す。
    state = "rowsExpect";
    forEachToken(text, opts.driver, handle, resumeAt);
  }
  // 文書 (または `to`) の終わりで閉じていない行も、途中の行として残す。
  const finalState = state as State;
  if (finalState === "inRow" && (cur as InsertStatement | null)) pushPartial(text.length);
  return out;
}

// ---------------------------------------------------------------------------
// 列の解決・ヒント・不一致
// ---------------------------------------------------------------------------

/** 表名 (小文字) → 列名 (定義順)。不明なら null。 */
export type ColumnLookup = (table: string, qualifier: string | null) => readonly string[] | null;

/**
 * 文の対象列。明示の列リストがあればそれ、無ければスキーマの定義順。
 *
 * 既知の制限: スキーマの列一覧が `INSERT INTO t VALUES (...)` の暗黙の列と一致しないことがある
 * (MySQL の INVISIBLE 列 / GIPK の `my_row_id`、PostgreSQL の生成列など)。列リストを省略した文の
 * ヒントと列数の警告はベストエフォートで、ずれうる。確実に合わせたいときは列リストを書く。
 */
export function resolveInsertColumns(stmt: InsertStatement, lookup: ColumnLookup): string[] | null {
  if (stmt.columns) return stmt.columns.map((c) => c.name);
  const cols = lookup(stmt.table, stmt.qualifier);
  return cols && cols.length > 0 ? [...cols] : null;
}

/** 値の直前に出す 1 つのヒント。 */
export interface ValueHint {
  /** 挿入位置 (値の先頭)。 */
  pos: number;
  /** 列名 (長いものは切り詰め済み)。 */
  label: string;
  /** 値の範囲。カーソルがこの上にあるかの判定に使う。 */
  from: number;
  to: number;
}

export type HintMode = "off" | "cursor" | "always";

export interface HintOptions {
  mode: Exclude<HintMode, "off">;
  /** カーソル位置。`cursor` モードでは必須。 */
  cursor?: number;
  lookup: ColumnLookup;
  /** 1 回に返すヒント数の上限。 */
  maxHints?: number;
}

/** これより長い 1 行は、カーソルのある行でなければヒントを出さない (巨大な 1 行 INSERT で UI を止めない)。 */
export const MAX_HINT_LINE_LENGTH = 10_000;
/** ヒントに載せる列名の最大文字数 (超えたら `…` で切る)。 */
export const MAX_HINT_LABEL = 24;
const DEFAULT_MAX_HINTS = 2000;

/** 列名を `MAX_HINT_LABEL` 文字までに切り詰める (サロゲートペアを割らない)。 */
export function truncateLabel(name: string): string {
  const chars = Array.from(name);
  return chars.length <= MAX_HINT_LABEL ? name : `${chars.slice(0, MAX_HINT_LABEL - 1).join("")}…`;
}

/** `pos` を含む行の範囲。 */
function lineBounds(text: string, pos: number): Span {
  const p = Math.min(Math.max(pos, 0), text.length);
  const start = p <= 0 ? 0 : text.lastIndexOf("\n", p - 1) + 1;
  const nl = text.indexOf("\n", p);
  return { from: start, to: nl === -1 ? text.length : nl };
}

/**
 * 走査済みの文から値のヒントを作る。
 * - `cursor` モード: カーソルのある行と重なる行 (タプル) の値だけ。複数行にまたがる 1 タプルは、
 *   どの行にカーソルがあってもそのタプルの全値に出る。
 * - `always` モード: 走査範囲内の全タプル。ただし長い 1 行は除く。
 * 値より列が少ない分の余りには出さない。空の値 (`(1,,2)` の隙間) と未完の行には出さない。
 */
export function insertValueHints(
  text: string,
  stmts: readonly InsertStatement[],
  opts: HintOptions,
): ValueHint[] {
  const max = opts.maxHints ?? DEFAULT_MAX_HINTS;
  const out: ValueHint[] = [];
  const cursor = opts.cursor ?? -1;
  const cursorLine = opts.mode === "cursor" && cursor >= 0 ? lineBounds(text, cursor) : null;
  if (opts.mode === "cursor" && !cursorLine) return out;
  let cachedLine: Span | null = null;
  const lineOf = (pos: number): Span => {
    if (cachedLine && pos >= cachedLine.from && pos <= cachedLine.to) return cachedLine;
    cachedLine = lineBounds(text, pos);
    return cachedLine;
  };
  for (const stmt of stmts) {
    const names = resolveInsertColumns(stmt, opts.lookup);
    if (!names) continue;
    for (const row of stmt.rows) {
      if (!row.values || (row.partial && row.count === 0)) continue;
      const containsCursor = cursor >= row.from && cursor <= row.to;
      if (cursorLine) {
        if (row.to < cursorLine.from || row.from > cursorLine.to) continue;
        // カーソル行が極端に長いときは、カーソルのあるタプルだけに絞る。
        if (cursorLine.to - cursorLine.from > MAX_HINT_LINE_LENGTH && !containsCursor) continue;
      } else {
        const line = lineOf(row.from);
        if (line.to - line.from > MAX_HINT_LINE_LENGTH && !containsCursor) continue;
      }
      const limit = Math.min(row.values.length, names.length);
      for (let i = 0; i < limit; i++) {
        const v = row.values[i];
        if (v.to <= v.from) continue;
        out.push({ pos: v.from, label: truncateLabel(names[i]), from: v.from, to: v.to });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/** 値の数が列数と合わない 1 タプル。 */
export interface ArityIssue extends Span {
  /** 期待する列の数。 */
  columns: number;
  /** 実際の値の数。 */
  values: number;
}

export interface ArityOptions {
  driver?: string | null;
  lookup: ColumnLookup;
  /** カーソル位置。タプルの内側 (入力中) は報告しない。 */
  cursor?: number;
  /** 返す件数の上限。 */
  max?: number;
}

/**
 * 値の数が列数と合わないタプルを返す。
 * - 列リストを省略した PostgreSQL の INSERT は、後ろの列が既定値になるので「値が少ない」は正常 (多いときだけ)。
 * - `()` (0 値、MySQL の全列既定値) と、未完の行は対象外。
 * - SQLite は、表名そのものを列に書く FTS の特殊コマンド (`INSERT INTO docs(docs) VALUES('optimize')`) を除く。
 */
export function insertArityIssues(stmts: readonly InsertStatement[], opts: ArityOptions): ArityIssue[] {
  const max = opts.max ?? 100;
  const cursor = opts.cursor ?? -1;
  const out: ArityIssue[] = [];
  for (const stmt of stmts) {
    const names = resolveInsertColumns(stmt, opts.lookup);
    if (!names) continue;
    if (opts.driver === "sqlite" && stmt.columns?.some((c) => c.norm === stmt.table)) continue;
    const allowFewer = opts.driver === "postgres" && !stmt.columns;
    for (const row of stmt.rows) {
      if (row.partial || row.count === 0) continue;
      if (row.count === names.length) continue;
      if (allowFewer && row.count < names.length) continue;
      if (cursor >= row.from && cursor <= row.to) continue;
      out.push({ from: row.from, to: row.to, columns: names.length, values: row.count });
      if (out.length >= max) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// スキーマの索引と、スクリプト内で DDL の対象になった表
// ---------------------------------------------------------------------------

/** 表名 (小文字) → 定義順の列名。同名 (大文字小文字違い) の衝突は null (使わない)。 */
export type ColumnIndex = Map<string, readonly string[] | null>;

/**
 * スキーマ概観から `ColumnIndex` を作る。概観で列が空の表は `schemaTable` (アクティブテーブル) の列で補う。
 * 大文字小文字だけ違う表名が複数あるときは、どちらの列か決められないので null にして検査・ヒントを止める。
 */
export function buildColumnIndex(
  overview: ReadonlyArray<{ name: string; columns: readonly string[] }> | null | undefined,
  schemaTable?: { name: string; columns: readonly string[] } | null,
): ColumnIndex {
  const index: ColumnIndex = new Map();
  for (const t of overview ?? []) {
    let cols = t.columns;
    if (cols.length === 0 && schemaTable && schemaTable.name === t.name) cols = schemaTable.columns;
    const key = t.name.toLowerCase();
    index.set(key, index.has(key) ? null : cols.length > 0 ? cols : null);
  }
  return index;
}

/** `ColumnIndex` と、既定 DB / DDL の対象表から `ColumnLookup` を作る。 */
export function indexLookup(
  index: ColumnIndex,
  defaultDatabase: string | null | undefined,
  ddlTables?: ReadonlySet<string>,
): ColumnLookup {
  const db = defaultDatabase ? defaultDatabase.toLowerCase() : null;
  return (table, qualifier) => {
    if (qualifier !== null && qualifier !== db) return null;
    // 同じスクリプトで作り直した / 変更した表は、接続中のスキーマの列とは限らない。
    if (ddlTables?.has(table)) return null;
    return index.get(table) ?? null;
  };
}

const DDL_TABLE_RE =
  /\b(create|alter|drop|rename)\s+(?:(?:or\s+replace|temporary|temp|unlogged|global|local|virtual|only)\s+)*table\b([^;]*)/gi;
const RENAME_TO_RE = /\brename\s+(?:to|as)\s+((?:[`"[]?[\w$]+[`"\]]?\s*\.\s*)*[`"[]?[\w$]+[`"\]]?)/gi;
const NAME_RE = /[`"[]?([\w$\u0080-\uffff]+)[`"\]]?/g;

/**
 * スクリプト内で CREATE / ALTER / DROP / RENAME TABLE の対象になった表名 (小文字、修飾は最後の要素) を集める。
 * mysqldump の DROP / CREATE / INSERT や、ALTER ... ADD COLUMN の後の INSERT を、接続中の (古い) スキーマの列数と
 * 比べて全行警告しないための除外リスト。文字列やコメントの中の `drop table x` も拾うが、拾い過ぎは「警告しない」
 * 側に倒れるだけで安全。
 */
export function ddlTargetTables(text: string): Set<string> {
  const out = new Set<string>();
  if (!/(?:create|alter|drop|rename)/i.test(text)) return out;
  DDL_TABLE_RE.lastIndex = 0;
  for (let m = DDL_TABLE_RE.exec(text); m; m = DDL_TABLE_RE.exec(text)) {
    const verb = m[1].toLowerCase();
    // `DROP TABLE a, b` / `RENAME TABLE a TO b, c TO d` は複数の表を持つ。他は最初の 1 つ。
    const body = m[2].replace(/\bif\s+(?:not\s+)?exists\b/gi, " ");
    if (verb === "drop" || verb === "rename") {
      for (const n of body.matchAll(NAME_RE)) out.add(n[1].toLowerCase());
    } else {
      const head = body.trimStart();
      const chain = /^((?:[`"[]?[\w$\u0080-\uffff]+[`"\]]?\s*\.\s*)*)[`"[]?([\w$\u0080-\uffff]+)[`"\]]?/.exec(
        head,
      );
      if (chain) out.add(chain[2].toLowerCase());
    }
  }
  RENAME_TO_RE.lastIndex = 0;
  for (let m = RENAME_TO_RE.exec(text); m; m = RENAME_TO_RE.exec(text)) {
    const last = m[1].split(".").pop() ?? "";
    out.add(last.replace(/[`"[\]\s]/g, "").toLowerCase());
  }
  return out;
}
