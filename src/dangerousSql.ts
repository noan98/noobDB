/**
 * Lightweight, best-effort detection of destructive write statements so the UI
 * can ask for confirmation before running them. Mirrors the leading-keyword
 * philosophy of the backend `is_read_only_sql` gate (`src-tauri/src/db/mod.rs`):
 * this is a safety net, not a SQL parser. Pathological inputs (writable CTEs)
 * can still slip past — the goal is to catch the common foot-guns
 * (`DELETE`/`UPDATE` with no top-level `WHERE`, `DROP`, `TRUNCATE`), not to be
 * exhaustive. A `WHERE` that exists only inside a sub-select is not mistaken
 * for the statement's own guard (see `hasTopLevelWhere`).
 */

export type DangerKind =
  | "deleteNoWhere"
  | "updateNoWhere"
  | "drop"
  | "truncate";

export interface DangerFinding {
  kind: DangerKind;
  /** Best-effort target table/object name, or null when it couldn't be parsed. */
  target: string | null;
}

/**
 * Returns a same-length copy of `sql` with the contents of comments and quoted
 * literals replaced by spaces. Keyword and `WHERE` detection runs against this
 * so a string such as `'... where ...'` can't masquerade as a real clause.
 * Length is preserved so callers can slice the original at the same offsets.
 *
 * Exported so sibling analysers built on the same "mask first, then scan
 * keywords" approach can reuse the exact masking rules instead of duplicating
 * them (e.g. `components/preflight.ts`, which turns a write DML into a COUNT
 * probe — #737). The mask is dialect-agnostic: it blanks the contents of single
 * quotes, double quotes, backticks, dollar-quoted strings, line comments
 * (`--` / `#`) and block comments, so clause keywords (`WHERE`, `ORDER BY`, …)
 * survive while a `where` hiding inside a string or a quoted identifier named
 * `` `order` `` does not. One deliberate exception: a MySQL versioned comment
 * — opened with `/*!`, optionally followed by a version number, e.g.
 * `/*!50000` — is *not* blanked like an ordinary block comment, because
 * MySQL actually executes its body. See the `/*!` branch below.
 */
export function maskLiterals(sql: string, driver?: string): string {
  const backslashEscapes = driverBackslashEscapes(driver);
  const out = sql.split("");
  const n = sql.length;
  const blank = (start: number, end: number) => {
    for (let k = start; k < end && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "#") {
      let j = i + 1;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*" && sql[i + 2] === "!") {
      // MySQL "version comment" `/*! ... */` (optionally `/*!50000 ... */`):
      // despite the `/*` spelling this is not a comment on MySQL — its body
      // *executes* on servers new enough to satisfy the optional version
      // gate — so blanking the interior the way a normal `/* ... */` block
      // comment is blanked below would hide real, executable SQL from every
      // keyword scan built on this mask. Only the opening delimiter (`/*!`
      // plus any immediately-following digits) is blanked here; the body is
      // left for the main loop to keep scanning normally from here (so a
      // quote or nested comment inside it is still masked correctly), and
      // the closing `*/` — which nothing else in this loop specially
      // recognises — just passes through unchanged as two ordinary
      // characters (harmless: neither is a word character). Mirrors the
      // backend `mask_for_analysis_impl` (src-tauri/src/db/mod.rs).
      let j = i + 3;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "$" && (i === 0 || !isWordChar(sql[i - 1]))) {
      // PostgreSQL dollar-quoted string: $$…$$ / $tag$…$tag$. Only treated as
      // a string when the opening tag is valid (empty or identifier-like, not
      // starting with a digit — `$1` is a parameter placeholder) and a
      // matching closing tag exists; otherwise the `$` stays literal so any
      // keywords remain visible (fail-closed for the checks built on this
      // mask). A `$` straight after a word char is part of an identifier
      // (MySQL allows `$` in names), never an opening tag. Mirrors the
      // backend `mask_for_analysis` (src-tauri/src/db/mod.rs).
      const tag = matchDollarQuoteTag(sql, i);
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close !== -1) {
          blank(i + tag.length, close);
          i = close + tag.length;
          continue;
        }
      }
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          // Doubled quote is an escaped delimiter, not the end.
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        // Backslash escapes apply inside MySQL strings but not in `` `ident` ``
        // — and not at all on the other dialects (see `driverBackslashEscapes`).
        if (backslashEscapes && sql[j] === "\\" && quote !== "`") {
          j += 2;
          continue;
        }
        j++;
      }
      // Blank the contents but keep the delimiters so token boundaries survive.
      blank(i + 1, j - 1);
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Returns the opening dollar-quote tag (`$$` / `$tag$`) starting at `sql[i]`
 * (which must be `$`), or null when what follows is not a valid tag. Valid
 * tags are identifier-like and never start with a digit (`$1` is a Postgres
 * parameter placeholder, not a tag).
 */
function matchDollarQuoteTag(sql: string, i: number): string | null {
  let j = i + 1;
  if (/[0-9]/.test(sql[j] ?? "")) return null;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
  return sql[j] === "$" ? sql.slice(i, j + 1) : null;
}

/**
 * True when `driver` treats `\` inside a `'…'` / `"…"` string literal as an
 * escape character. Only MySQL/MariaDB does (with the default
 * `NO_BACKSLASH_ESCAPES` off); PostgreSQL (`standard_conforming_strings = on`),
 * SQLite, DuckDB and Microsoft SQL Server all read `\` as an ordinary
 * character. Mirrors the backend `driver_backslash_escapes`
 * (`src-tauri/src/db/mod.rs`, #852).
 *
 * Unlike the dialect helpers in `components/sqlDialect.ts`, an unknown or
 * omitted driver falls back to **false** (the stricter, non-MySQL reading)
 * rather than to MySQL: a string literal can then only close earlier than
 * MySQL would judge, never later, so keywords are revealed rather than hidden
 * and every check built on the mask errs toward "this is a write".
 *
 * Exported so `sqlScript.ts`'s statement splitter (`scanQuoted`) can share the
 * exact same rule — statement boundaries and the danger/read-only masks must
 * agree on where a `'...'` literal closes, or a hidden second statement can
 * slip past one check while the other still sees it (#1004).
 */
export function driverBackslashEscapes(driver?: string): boolean {
  return driver === "mysql";
}

function startsWithKeyword(body: string, keyword: string): boolean {
  return new RegExp(`^${keyword}\\b`).test(body);
}

function containsWord(body: string, keyword: string): boolean {
  return new RegExp(`\\b${keyword}\\b`).test(body);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Detects a `WHERE` clause that belongs to the statement itself — i.e. at
 * parenthesis depth 0 — rather than one buried in a sub-select. Without the
 * depth check, `UPDATE t SET c = (SELECT ... WHERE ...)` would look "guarded"
 * even though it rewrites every row. Mirrors the depth tracking used by the
 * backend's `top_level_select_list`. `maskedLower` must already have comments
 * and quoted literals masked so a `where` inside a string can't trip it.
 */
function hasTopLevelWhere(maskedLower: string): boolean {
  let depth = 0;
  const n = maskedLower.length;
  for (let i = 0; i < n; i++) {
    const c = maskedLower[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (depth > 0) depth--;
    } else if (depth === 0 && c === "w" && maskedLower.startsWith("where", i)) {
      const before = i === 0 ? "" : maskedLower[i - 1];
      const after = maskedLower[i + 5] ?? "";
      if (!isWordChar(before) && !isWordChar(after)) return true;
    }
  }
  return false;
}

/** Strips surrounding quoting (`` ` ``, `"`, `[]`) from a parsed identifier. */
function cleanIdentifier(token: string): string {
  if (
    (token.startsWith("`") && token.endsWith("`")) ||
    (token.startsWith('"') && token.endsWith('"'))
  ) {
    return token.slice(1, -1);
  }
  if (token.startsWith("[") && token.endsWith("]")) {
    return token.slice(1, -1);
  }
  return token;
}

/** Reads the first table-like identifier from `rest` (after the lead keyword). */
function readTargetIdentifier(rest: string): string | null {
  const m = /^\s*(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z0-9_$.]+)/.exec(rest);
  if (!m) return null;
  const cleaned = cleanIdentifier(m[1]);
  return cleaned.length > 0 ? cleaned : null;
}

function extractTarget(rawStatement: string, lead: RegExp): string | null {
  const m = lead.exec(rawStatement);
  if (!m) return null;
  return readTargetIdentifier(rawStatement.slice(m.index + m[0].length));
}

function classifyStatement(masked: string, raw: string): DangerFinding | null {
  const maskedLower = masked.toLowerCase();
  const body = maskedLower.replace(/^[\s(]+/, "");
  if (!body) return null;

  if (startsWithKeyword(body, "delete")) {
    if (hasTopLevelWhere(maskedLower)) return null;
    return { kind: "deleteNoWhere", target: extractTarget(raw, /delete\s+from\s+/i) };
  }
  if (startsWithKeyword(body, "update")) {
    if (hasTopLevelWhere(maskedLower)) return null;
    return { kind: "updateNoWhere", target: extractTarget(raw, /update\s+/i) };
  }
  if (startsWithKeyword(body, "truncate")) {
    return { kind: "truncate", target: extractTarget(raw, /truncate\s+(?:table\s+)?/i) };
  }
  if (startsWithKeyword(body, "drop")) {
    // Skip the object keyword (table/database/...) and an optional IF EXISTS.
    return { kind: "drop", target: extractTarget(raw, /drop\s+\w+\s+(?:if\s+exists\s+)?/i) };
  }
  return null;
}

/**
 * Scans `sql` (which may contain several `;`-separated statements) and returns
 * one finding per destructive statement detected. An empty array means nothing
 * dangerous was recognized.
 *
 * `driver` selects the string-escaping rules used while masking (#852, #1004).
 * Omit it only where the driver is genuinely unknown — see `isReadOnlySql`.
 */
export function analyzeDangerousSql(sql: string, driver?: string): DangerFinding[] {
  const masked = maskLiterals(sql, driver);
  const findings: DangerFinding[] = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || masked[i] === ";") {
      const finding = classifyStatement(masked.slice(start, i), sql.slice(start, i));
      if (finding) findings.push(finding);
      start = i + 1;
    }
  }
  return findings;
}

const READ_ONLY_PREFIXES = ["select", "show", "describe", "desc", "explain", "with"];

/**
 * `VALUES (1),(2)` (a bare row constructor) and `TABLE t`
 * (PostgreSQL/DuckDB/MySQL 8.0.19+ shorthand for `SELECT * FROM t`) can only
 * ever produce a result set — neither has a form that mutates data — so they
 * are allowed for every driver regardless of whether it actually supports the
 * statement (an unsupported driver just fails with a syntax error, not a
 * safety concern). Mirrors the backend `is_read_only_sql_masked`
 * (`src-tauri/src/db/mod.rs`, #1005).
 */
const READ_ONLY_PREFIXES_ALL_DRIVERS = ["values", "table"];

/**
 * DuckDB-only read-only prefixes (#1005): `FROM t` (FROM-first shorthand for
 * `SELECT * FROM t`) and `SUMMARIZE t` (read-only column statistics). Kept
 * separate from `READ_ONLY_PREFIXES_ALL_DRIVERS` because these two are only
 * meaningful DuckDB syntax — `PRAGMA` is handled separately below since it
 * additionally needs the setting-form exclusion (see `isReadOnlySql`).
 */
const READ_ONLY_PREFIXES_DUCKDB = ["from", "summarize"];

const WRITE_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "into",
  "create",
  "alter",
  "drop",
  "truncate",
  "call",
  "merge",
  "grant",
  "revoke",
  // 別エンジンへの書き込みパススルー関数群。文全体は `SELECT ...` のままなので
  // READ_ONLY_PREFIXES は通過するが、実際の書き込み SQL は引数の文字列リテラルの
  // 中に埋め込まれ maskLiterals で空白化されるため、通常のキーワード走査には
  // 引っかからない (`SELECT * FROM OPENROWSET('SQLNCLI','Server=x;','UPDATE ...')`、
  // `SELECT dblink_exec('dbname=other','DELETE FROM accounts')`)。
  // `openrowset`/`openquery`/`opendatasource` は MSSQL のリンクサーバ経由
  // パススルー、`dblink`/`dblink_exec` は PostgreSQL の他 DB へのクエリ実行、
  // `load_extension` は SQLite のネイティブ拡張ロード (任意コード実行)。バックの
  // `is_read_only_sql_masked` (src-tauri/src/db/mod.rs) と同じく全ドライバ共通で
  // 拒否する (fail-closed。正当な識別子としてこれらの名前が現れる可能性は極めて
  // 低い)。
  "openrowset",
  "openquery",
  "opendatasource",
  "dblink",
  "dblink_exec",
  "load_extension",
];

/**
 * Row-locking clause phrases recognised by `hasLockingClause`: `SELECT ...
 * FOR UPDATE` / `FOR SHARE` (standard SQL / MySQL / PostgreSQL), the
 * PostgreSQL-only `FOR NO KEY UPDATE` / `FOR KEY SHARE`, and the MySQL-only
 * `LOCK IN SHARE MODE`. Mirrors the backend `LOCKING_CLAUSES`
 * (`src-tauri/src/db/mod.rs`).
 */
const LOCKING_CLAUSES = [
  "for no key update",
  "for key share",
  "for update",
  "for share",
  "lock in share mode",
];

/**
 * True when masked/lowercased `body` contains a row-locking clause anywhere —
 * any of `LOCKING_CLAUSES` — including the PostgreSQL suffixed forms that may
 * follow the base phrase: `NOWAIT` (`FOR UPDATE NOWAIT`), `SKIP LOCKED`
 * (`FOR UPDATE SKIP LOCKED`), and `OF <table>[, ...]` (`FOR UPDATE OF t`, also
 * valid on `FOR SHARE` / `FOR NO KEY UPDATE` / `FOR KEY SHARE`). Rather than
 * parsing those suffixes explicitly, this matches the base phrase anywhere in
 * the body — safe because `body` has already had comments and string/quoted
 * identifier literals masked to spaces, so any surviving occurrence of e.g.
 * `for update` is real SQL syntax, not a coincidental column value, and any
 * write keyword trailing a locking clause (which would make the suffix
 * invalid SQL) is independently caught by `WRITE_KEYWORDS`. Matching is
 * word-bounded on the whole phrase, so a column named `for_updated_at` /
 * `updated_at` is never mistaken for the clause. Mirrors the backend
 * `has_locking_clause` (`src-tauri/src/db/mod.rs`).
 */
function hasLockingClause(body: string): boolean {
  return LOCKING_CLAUSES.some((phrase) => containsWord(body, phrase));
}

/**
 * Microsoft SQL Server table hints that make a `SELECT` acquire locks a plain
 * read would not (#906): a stronger lock mode than a shared read (`UPDLOCK` /
 * `XLOCK` / `TABLOCKX`) or a longer lock duration than the statement
 * (`HOLDLOCK` and its synonym `SERIALIZABLE`, `REPEATABLEREAD`,
 * `READCOMMITTEDLOCK`). `NOLOCK` / `READUNCOMMITTED` / `READPAST` (fewer
 * locks) and the granularity-only `ROWLOCK` / `PAGLOCK` / `TABLOCK` are
 * deliberately absent. Mirrors the backend `LOCKING_TABLE_HINTS`
 * (`src-tauri/src/db/mod.rs`).
 */
const LOCKING_TABLE_HINTS = new Set([
  "updlock",
  "xlock",
  "tablockx",
  "holdlock",
  "serializable",
  "repeatableread",
  "readcommittedlock",
]);

/**
 * True when masked/lowercased `body` carries a `LOCKING_TABLE_HINTS` hint
 * inside a T-SQL `WITH (...)` hint group — e.g.
 * `SELECT * FROM t WITH (UPDLOCK, HOLDLOCK)` (#906).
 *
 * Scoped to the interior of a `WITH (…)` group rather than scanning for the
 * bare words, so a column named `updlock` (or a
 * `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`) is never mistaken for a
 * hint. Parenthesis depth is tracked because hints may be parameterised
 * (`INDEX(0)`), and every group is inspected so a hint on the second table of
 * a join is not missed. Applied on every driver, not just MSSQL: `WITH (…)`
 * straight after a table reference is not valid read-only syntax elsewhere (a
 * CTE is `WITH <name> AS (…)`), so there is nothing to false-positive on.
 * Mirrors the backend `has_locking_table_hint`.
 */
function hasLockingTableHint(body: string): boolean {
  const re = /\bwith\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the `(`
    let group = "";
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === "(") {
        depth++;
        if (depth > 1) group += " ";
      } else if (c === ")") {
        depth--;
        if (depth === 0) break;
        group += " ";
      } else {
        group += c;
      }
    }
    if (group.split(/[^A-Za-z0-9_]+/).some((w) => LOCKING_TABLE_HINTS.has(w))) {
      return true;
    }
    re.lastIndex = Math.max(i, m.index + 1);
  }
  return false;
}

/**
 * Best-effort mirror of the backend `is_read_only_sql` gate
 * (`src-tauri/src/db/mod.rs`): true only when `sql` is a single statement that
 * begins with an allowed read-only keyword and carries no write/DDL keyword,
 * hidden second statement, or row-locking clause. Comments and quoted literals
 * are masked first. Used to decide whether a production connection that opts
 * into write approval needs to confirm before running a statement; keeping the
 * logic aligned with the backend means the approval prompt fires for exactly
 * the statements a read-only session would reject. When in doubt it returns
 * false (treats the statement as a write), erring toward asking.
 *
 * `driver` selects the string-escaping rules used while masking (#852), and
 * also gates the DuckDB-only allow-list extensions (#1005): `FROM` (FROM-first
 * shorthand) / `SUMMARIZE` / query-shaped `PRAGMA` are only recognized when
 * `driver === "duckdb"`, since they're only safe (or only meaningful) syntax
 * on that dialect. `VALUES` / `TABLE` are recognized for every driver
 * (including when `driver` is omitted) because neither has a form that
 * mutates data. Omit `driver` only where it is genuinely unknown: the
 * fallback is the stricter non-MySQL string-escaping reading, which can
 * classify a legitimate MySQL statement using `\'` inside a literal as a
 * write (an extra confirmation prompt, never a missed one). See
 * `driverBackslashEscapes`.
 */
export function isReadOnlySql(sql: string, driver?: string): boolean {
  const masked = maskLiterals(sql, driver);
  const body = masked
    .toLowerCase()
    .replace(/[;\s]+$/, "")
    .replace(/^\s+/, "");
  if (!body) return false;
  let allowedPrefix =
    READ_ONLY_PREFIXES.some((kw) => startsWithKeyword(body, kw)) ||
    READ_ONLY_PREFIXES_ALL_DRIVERS.some((kw) => startsWithKeyword(body, kw));
  if (!allowedPrefix && driver === "duckdb") {
    allowedPrefix = READ_ONLY_PREFIXES_DUCKDB.some((kw) => startsWithKeyword(body, kw));
    if (!allowedPrefix && startsWithKeyword(body, "pragma")) {
      // PRAGMA には照会形 (`PRAGMA database_list`) と設定形
      // (`PRAGMA memory_limit='1GB'`) があり、後者だけ構文上必ず `=` を含む。
      // バックの is_read_only_sql_masked (#1005) と同じ近似を使う。
      allowedPrefix = !body.includes("=");
    }
  }
  if (!allowedPrefix) return false;
  // Trailing separators were stripped, so a remaining `;` hides a 2nd statement.
  if (body.includes(";")) return false;
  if (WRITE_KEYWORDS.some((kw) => containsWord(body, kw))) return false;
  if (hasLockingClause(body)) return false;
  if (hasLockingTableHint(body)) return false;
  return true;
}

const SCHEMA_MUTATING_PREFIXES = [
  "create",
  "alter",
  "drop",
  "rename",
  "truncate",
];

/**
 * Best-effort detection of DDL that can add/rename/remove tables, columns, or
 * indexes, so the editor's autocomplete schema cache can be refreshed
 * afterwards. Comments and quoted literals are masked first, then EVERY
 * `;`-separated statement's leading keyword is checked — so a schema change
 * hidden behind a leading comment (`-- note\nDROP TABLE t`) or after an earlier
 * statement (`SELECT 1; DROP TABLE t`) is still caught, not just a DDL verb at
 * the very start. Leans toward over-detection: a false positive only triggers a
 * cheap re-fetch, so when in doubt we report `true`.
 *
 * `create` / `alter` / `drop` already cover the compound DDL forms the verb
 * leads — `CREATE INDEX`, `DROP INDEX`, `ALTER TABLE ... RENAME COLUMN`,
 * `ALTER TABLE ... RENAME TO` — because only the leading keyword is matched.
 *
 * `driver` selects the string-escaping rules used while masking (#852, #1004).
 * Omit it only where the driver is genuinely unknown — see `isReadOnlySql`.
 */
export function isSchemaMutatingSql(sql: string, driver?: string): boolean {
  const masked = maskLiterals(sql, driver);
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || masked[i] === ";") {
      const body = masked.slice(start, i).toLowerCase().replace(/^[\s(]+/, "");
      if (
        body &&
        SCHEMA_MUTATING_PREFIXES.some((kw) => startsWithKeyword(body, kw))
      ) {
        return true;
      }
      start = i + 1;
    }
  }
  return false;
}
