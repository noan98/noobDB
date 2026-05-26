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
 */
function maskLiterals(sql: string): string {
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
  if (
    body.endsWith("for update") ||
    body.endsWith("for share") ||
    body.endsWith("lock in share mode")
  ) {
    return false;
  }
  return true;
}
