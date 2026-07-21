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
 * `` `order` `` does not.
 */
export function maskLiterals(sql: string): string {
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
        // Backslash escapes apply inside MySQL strings but not in `` `ident` ``.
        if (sql[j] === "\\" && quote !== "`") {
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
 */
export function analyzeDangerousSql(sql: string): DangerFinding[] {
  const masked = maskLiterals(sql);
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
 * Best-effort mirror of the backend `is_read_only_sql` gate
 * (`src-tauri/src/db/mod.rs`): true only when `sql` is a single statement that
 * begins with an allowed read-only keyword and carries no write/DDL keyword,
 * hidden second statement, or row-locking clause. Comments and quoted literals
 * are masked first. Used to decide whether a production connection that opts
 * into write approval needs to confirm before running a statement; keeping the
 * logic aligned with the backend means the approval prompt fires for exactly
 * the statements a read-only session would reject. When in doubt it returns
 * false (treats the statement as a write), erring toward asking.
 */
export function isReadOnlySql(sql: string): boolean {
  const masked = maskLiterals(sql);
  const body = masked
    .toLowerCase()
    .replace(/[;\s]+$/, "")
    .replace(/^\s+/, "");
  if (!body) return false;
  if (!READ_ONLY_PREFIXES.some((kw) => startsWithKeyword(body, kw))) return false;
  // Trailing separators were stripped, so a remaining `;` hides a 2nd statement.
  if (body.includes(";")) return false;
  if (WRITE_KEYWORDS.some((kw) => containsWord(body, kw))) return false;
  if (hasLockingClause(body)) return false;
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
 */
export function isSchemaMutatingSql(sql: string): boolean {
  const masked = maskLiterals(sql);
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
