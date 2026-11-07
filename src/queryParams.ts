import type { DriverKind } from "./api/tauri";
import { quoteString } from "./components/cellEdit";
import { maskLiterals } from "./dangerousSql";
import { quoteIdentFor } from "./components/sqlDialect";

/**
 * Interactive query parameters: `{{name}}` placeholders typed into the editor
 * that prompt for a value before the query runs. Detection and the
 * driver-aware, injection-safe substitution live here as pure functions so the
 * security-critical escaping is unit-testable without React. The input UI is in
 * `components/ParameterInputModal.tsx`; App wires detection into the run /
 * preview / explain gate.
 */

/**
 * How a parameter's value is rendered into SQL. The user picks this per
 * parameter (default `text`) so both data values and object names are handled
 * safely:
 *   - `text`       → a quoted, escaped string literal (`'...'`).
 *   - `number`     → a bare numeric literal (no quotes).
 *   - `identifier` → a quoted, escaped identifier (table/column name).
 *   - `null`       → the bare keyword `NULL` (the value text is ignored).
 */
export type ParamType = "text" | "number" | "identifier" | "null";

/** A `{{name}}` placeholder. `name` is one or more word chars (letters/digits/_). */
function paramRegex(): RegExp {
  // A fresh instance per call keeps `lastIndex` state from leaking between the
  // `matchAll` (extract) and `replace` (substitute) uses.
  return /\{\{(\w+)\}\}/g;
}

/** A numeric literal acceptable for the `number` parameter type. */
const NUMERIC_RE = /^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Whether `raw` is a plain numeric literal (used to validate `number` params). */
export function isNumericParam(raw: string): boolean {
  return NUMERIC_RE.test(raw.trim());
}

/** Extract the unique `{{name}}` placeholders in `sql`, in first-seen order. */
export function extractQueryParams(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of sql.matchAll(paramRegex())) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * `'{{name}}'` / `"{{name}}"` / `` `{{name}}` `` のように、プレースホルダが引用符で
 * 直接囲まれているパラメータ名を返す (初出順・重複なし)。text / identifier の値は
 * 置換時に自動で引用符が付くため、囲んで書くと `''abc''` のように二重引用になって
 * 構文エラーになる。入力モーダルで事前に注意するための検出 (置換結果は変えない)。
 */
export function findQuotedParams(sql: string, driver?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // 別の文字列リテラル / コメントの内側にある引用符 (`'a''{{x}}''b'` など) を除くため、
  // 既存のリテラルマスクで「開き・閉じの引用符が実際にマスク後も残る」ものだけを採用する。
  // マスクで長さが変わる場合は絞り込まない。
  const masked = maskLiterals(sql, driver);
  const aligned = masked.length === sql.length;
  for (const m of sql.matchAll(/(['"`])\{\{(\w+)\}\}\1/g)) {
    if (aligned) {
      const start = m.index ?? 0;
      const end = start + m[0].length - 1;
      if (masked[start] !== m[1] || masked[end] !== m[1]) continue;
    }
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      out.push(m[2]);
    }
  }
  return out;
}

/**
 * Render one parameter value into safe SQL for its type. **Every branch is
 * injection-safe regardless of input**: `text` and `identifier` go through the
 * driver-aware quoting helpers (which double the relevant quote char), and a
 * `number` whose value isn't actually numeric falls back to a quoted string
 * rather than being inlined raw.
 */
export function renderParamValue(driver: DriverKind, raw: string, type: ParamType): string {
  if (type === "null") return "NULL";
  if (type === "identifier") return quoteIdentFor(driver, raw);
  if (type === "number") return isNumericParam(raw) ? raw.trim() : quoteString(driver, raw);
  return quoteString(driver, raw);
}

/**
 * Replace every `{{name}}` in `sql` with the escaped value for its type. A
 * placeholder with no supplied value is left untouched, so a typo surfaces as a
 * literal `{{name}}` (a clear SQL error) rather than a silent empty match.
 */
export function substituteQueryParams(
  sql: string,
  driver: DriverKind,
  values: Record<string, string>,
  types: Record<string, ParamType>,
): string {
  return sql.replace(paramRegex(), (whole, name: string) => {
    if (!(name in values)) return whole;
    return renderParamValue(driver, values[name], types[name] ?? "text");
  });
}

// ---------------------------------------------------------------------------
// ネイティブプレースホルダ (`?` / `$n` / `:name`)
//
// ORM やアプリのログからコピーした SQL に入っているドライバ固有のプレースホルダを検出し、
// `{{name}}` と同じ安全なリテラル化で展開する (#2128)。検出は maskLiterals で
// コメント・文字列・引用識別子・ドル引用の中身を潰した SQL に対して行うので、これらの中の
// `?` / `$1` / `:x` は拾わない。
// ---------------------------------------------------------------------------

/** 検出した 1 個のネイティブプレースホルダ (元 SQL 上の範囲 `[start, end)`)。 */
export interface NativePlaceholder {
  /**
   * 値の割り当てキー。`?1`, `?2` … (位置、`?` の出現順)、`$1` … (PostgreSQL)、`:name`。
   * `{{name}}` のキー (英数字と `_` のみ) とは先頭記号で必ず区別できる。
   */
  key: string;
  start: number;
  end: number;
}

function isWordCh(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** 文頭が `PREPARE` / `CREATE [OR REPLACE] FUNCTION|PROCEDURE` か (マスク済みなのでコメントは空白)。 */
const DEFINITION_START_RE =
  /^\s*(?:PREPARE\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\b)/i;

/**
 * ネイティブ検出から外す範囲 `[start, end)`。`PREPARE p(int) AS ... $1` や
 * `CREATE FUNCTION f(int) ... RETURN $1 + 1` の `$n` は定義側の引数で、値に置き換えると
 * 意味の違う定義になる。複文は文ごと (マスク後に残る `;` で分割) に判定し、
 * `BEGIN ATOMIC ... END` の本体は `END` の文まで含める。
 */
function definitionRanges(masked: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  let inAtomic = false;
  let atomicFrom = 0;
  const flush = (end: number) => {
    const seg = masked.slice(start, end);
    if (inAtomic) {
      if (/^\s*END\b/i.test(seg)) {
        out.push([atomicFrom, end]);
        inAtomic = false;
      }
      return;
    }
    if (!DEFINITION_START_RE.test(seg)) return;
    if (/\bBEGIN\s+ATOMIC\b/i.test(seg)) {
      inAtomic = true;
      atomicFrom = start;
      return;
    }
    out.push([start, end]);
  };
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ";") {
      flush(i);
      start = i + 1;
    }
  }
  flush(masked.length);
  if (inAtomic) out.push([atomicFrom, masked.length]);
  return out;
}

/**
 * `sql` 中のネイティブプレースホルダを出現順に列挙する。
 *   - MySQL / SQLite: `?` (SQLite は `?NNN` の番号付きも)
 *   - PostgreSQL: `$n` (jsonb の `?` / `?|` / `?&` は検出しない)
 *   - 全ドライバ共通: `:name` (`::` キャスト・`:=`・`a[x:y]` のスライス・`@var` は除く)
 * SQLite の `$name` / `@name` と MySQL の `@var` は検出しない。`PREPARE` と
 * `CREATE FUNCTION|PROCEDURE` の文は丸ごと検出対象外 (中の `$n` は定義の引数)。
 */
export function scanNativePlaceholders(sql: string, driver?: string): NativePlaceholder[] {
  const masked = maskLiterals(sql, driver);
  // マスクは長さを変えない前提 (1 文字ずつ空白化する)。万一ずれたら安全側で何も検出しない。
  if (masked.length !== sql.length) return [];
  const out: NativePlaceholder[] = [];
  const n = masked.length;
  const excluded = definitionRanges(masked);
  let exIdx = 0;
  let maxIndex = 0;
  // `[` `]` の深さ。PostgreSQL の配列スライス (`arr[1 : n]` / `arr[:n]`) の `:n` を名前と誤認しない。
  let bracketDepth = 0;
  let i = 0;
  while (i < n) {
    while (exIdx < excluded.length && i >= excluded[exIdx][1]) exIdx++;
    if (exIdx < excluded.length && i >= excluded[exIdx][0]) {
      // PREPARE / 関数・プロシージャ定義の本文の `$n` / `?` は、その文自身の引数。展開しない。
      i = excluded[exIdx][1];
      continue;
    }
    const c = masked[i];
    if (c === "[") bracketDepth++;
    else if (c === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (c === "?" && (driver === "mysql" || driver === "sqlite")) {
      let j = i + 1;
      if (driver === "sqlite" && /[0-9]/.test(masked[j] ?? "")) {
        while (j < n && /[0-9]/.test(masked[j])) j++;
        const idx = Number(masked.slice(i + 1, j));
        maxIndex = Math.max(maxIndex, idx);
        out.push({ key: `?${idx}`, start: i, end: j });
      } else {
        maxIndex += 1;
        out.push({ key: `?${maxIndex}`, start: i, end: j });
      }
      i = j;
      continue;
    }
    if (c === "$" && driver === "postgres" && !isWordCh(masked[i - 1]) && /[0-9]/.test(masked[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(masked[j])) j++;
      // `$1abc` のように識別子が続くものはプレースホルダではない。
      if (!isWordCh(masked[j])) {
        out.push({ key: `$${Number(masked.slice(i + 1, j))}`, start: i, end: j });
        i = j;
        continue;
      }
    }
    if (c === ":") {
      if (masked[i + 1] === ":") {
        // `::` キャスト。2 文字とも読み飛ばす (`::int` の `int` を名前と誤認しない)。
        i += 2;
        continue;
      }
      const prev = masked[i - 1];
      if (
        bracketDepth === 0 &&
        /[A-Za-z_]/.test(masked[i + 1] ?? "") &&
        !isWordCh(prev) &&
        prev !== ":" &&
        prev !== "]" &&
        prev !== "@"
      ) {
        let j = i + 1;
        while (j < n && isWordCh(masked[j])) j++;
        out.push({ key: `:${masked.slice(i + 1, j)}`, start: i, end: j });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * 入力モーダルに出すネイティブプレースホルダのキー (重複なし)。位置パラメータ
 * (`?n` / `$n`) を番号順に、続いて `:name` を初出順に並べる。
 */
export function extractNativeParams(sql: string, driver?: string): string[] {
  const positional = new Map<string, number>();
  const named: string[] = [];
  for (const p of scanNativePlaceholders(sql, driver)) {
    if (p.key.startsWith(":")) {
      if (!named.includes(p.key)) named.push(p.key);
    } else if (!positional.has(p.key)) {
      positional.set(p.key, Number(p.key.slice(1)));
    }
  }
  const pos = [...positional.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  return [...pos, ...named];
}

/** キーが位置パラメータ (`?n` / `$n`) か。 */
export function isPositionalParamKey(key: string): boolean {
  return key.startsWith("?") || key.startsWith("$");
}

/**
 * ネイティブプレースホルダを値で置き換える。値が無いものはそのまま残す (DB のエラーで気付ける)。
 * 同じキー (`$1` の複数回出現・`:name`) は同じ値になる。
 */
export function substituteNativePlaceholders(
  sql: string,
  driver: DriverKind,
  values: Record<string, string>,
  types: Record<string, ParamType>,
): string {
  const found = scanNativePlaceholders(sql, driver);
  let out = "";
  let pos = 0;
  for (const p of found) {
    out += sql.slice(pos, p.start);
    out +=
      p.key in values
        ? renderParamValue(driver, values[p.key], types[p.key] ?? "text")
        : sql.slice(p.start, p.end);
    pos = p.end;
  }
  return out + sql.slice(pos);
}

/**
 * `{{name}}` とネイティブプレースホルダの両方を展開する。`{{name}}` を先に展開するのは、展開結果
 * (引用符付きリテラル / 検証済み数値 / 引用識別子) が後段のマスクで潰れて再検出されないため。
 * 逆順だとネイティブの値に含まれる `{{x}}` が二重に展開されてしまう。
 */
export function substituteAllParams(
  sql: string,
  driver: DriverKind,
  values: Record<string, string>,
  types: Record<string, ParamType>,
): string {
  return substituteNativePlaceholders(
    substituteQueryParams(sql, driver, values, types),
    driver,
    values,
    types,
  );
}

/** 貼り付けた 1 個の値の解釈結果。 */
export interface PastedValue {
  value: string;
  type: ParamType;
}

/**
 * 「ログから値を貼り付け」の解析。JSON 配列 (`[1, "active", null]`) か、カンマ区切り
 * (`1, 'active', NULL`) を受け付ける。
 *   - クォート無しの `NULL` / JSON の null → NULL
 *   - クォート無しの数値 / JSON の数値 → 数値
 *   - クォート付き / それ以外 → テキスト
 * 空入力は空配列。
 */
export function parsePastedValues(input: string, driver?: string): PastedValue[] {
  const text = input.trim();
  if (text === "") return [];
  if (text.startsWith("[")) {
    const items = parseJsonArrayItems(text, driver);
    if (items) return items;
    // JSON として読めなければ CSV として扱う
  }
  return splitCsv(text, driver).map(({ raw, quoted }) => {
    if (quoted) return { value: raw, type: "text" as const };
    if (/^null$/i.test(raw)) return { value: "", type: "null" as const };
    if (/^(?:true|false)$/i.test(raw)) return boolValue(raw.toLowerCase() === "true", driver);
    if (isNumericParam(raw)) return { value: raw, type: "number" as const };
    return { value: raw, type: "text" as const };
  });
}

/** JSON 数値トークン (JSON.parse に通さず生テキストのまま保つ。64bit 整数・小数・指数を丸めない)。 */
const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * JSON 配列の要素を、数値は生テキストのまま取り出して解釈する。
 * 配列でない・壊れている場合は null。
 */
function parseJsonArrayItems(text: string, driver?: string): PastedValue[] | null {
  try {
    if (!Array.isArray(JSON.parse(text))) return null;
  } catch {
    return null;
  }
  // 構文は検証済み。トップレベルの要素を文字列・入れ子を追いながら切り出す。
  const tokens: string[] = [];
  let depth = 0;
  let inStr = false;
  let from = 1;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if ((ch === "]" || ch === "}") && depth > 0) depth--;
    else if ((ch === "," && depth === 0) || (ch === "]" && depth === 0)) {
      tokens.push(text.slice(from, i).trim());
      from = i + 1;
      if (ch === "]") break;
    }
  }
  // `[]` は空配列 (トークンが空文字 1 個になるので除く)。
  const real = tokens.length === 1 && tokens[0] === "" ? [] : tokens;
  return real.map((tok) =>
    JSON_NUMBER_RE.test(tok)
      ? { value: tok, type: "number" as const }
      : fromJsonValue(JSON.parse(tok), driver),
  );
}

/** 真偽値の貼り付け (JSON でも裸の true/false でも同じ)。MySQL / SQLite は 1 / 0、PostgreSQL は 'true' / 'false'。 */
function boolValue(b: boolean, driver?: string): PastedValue {
  if (driver === "postgres") return { value: b ? "true" : "false", type: "text" };
  return { value: b ? "1" : "0", type: "number" };
}

function fromJsonValue(v: unknown, driver?: string): PastedValue {
  if (v === null || v === undefined) return { value: "", type: "null" };
  if (typeof v === "number") return { value: String(v), type: "number" };
  if (typeof v === "boolean") return boolValue(v, driver);
  if (typeof v === "string") return { value: v, type: "text" };
  return { value: JSON.stringify(v), type: "text" };
}

const MYSQL_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", b: "\b", Z: "\x1a" };

/**
 * カンマ区切りを分割する。`'…'` / `"…"` の中のカンマは区切りにせず、引用符の二重化は 1 個に戻す。
 * MySQL は引用の内側のバックスラッシュエスケープ (`\'` / `\\` / `\n` …) も解釈する。
 */
function splitCsv(text: string, driver?: string): { raw: string; quoted: boolean }[] {
  const out: { raw: string; quoted: boolean }[] = [];
  const backslash = driver === "mysql";
  let cur = "";
  let quoted = false;
  let quote: string | null = null;
  const push = () => {
    out.push({ raw: quoted ? cur : cur.trim(), quoted });
    cur = "";
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (backslash && ch === "\\" && i + 1 < text.length) {
        const nx = text[i + 1];
        // MySQL は \% と \_ をバックスラッシュ付きのまま残す (LIKE のエスケープ用)
        cur += nx === "%" || nx === "_" ? `\\${nx}` : (MYSQL_ESCAPES[nx] ?? nx);
        i++;
      } else if (ch === quote) {
        if (text[i + 1] === quote) {
          cur += quote;
          i++;
        } else {
          quote = null;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if ((ch === "'" || ch === '"') && cur.trim() === "") {
      quote = ch;
      quoted = true;
      cur = "";
      continue;
    }
    if (ch === ",") {
      push();
      continue;
    }
    // 引用符を閉じた後の空白などは無視する。
    if (quoted) continue;
    cur += ch;
  }
  push();
  return out;
}
