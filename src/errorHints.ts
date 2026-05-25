import type { I18nKey } from "./i18n";

// Maps a raw database error string to a beginner-friendly hint key, or null
// when nothing matches. Patterns cover the wording used by MySQL, PostgreSQL
// and SQLite (all three drivers this app can connect to). The first matching
// pattern wins, so more specific checks must come before broader ones.
const PATTERNS: { test: RegExp; key: I18nKey }[] = [
  { test: /sql syntax|syntax error/i, key: "errorHintSyntax" },
  {
    test: /unknown column|no such column|column .* does(?:n't| not) exist/i,
    key: "errorHintUnknownColumn",
  },
  {
    test: /unknown database|database .* does(?:n't| not) exist/i,
    key: "errorHintUnknownDatabase",
  },
  {
    test: /table .* does(?:n't| not) exist|no such table|relation .* does not exist/i,
    key: "errorHintTableNotExist",
  },
  { test: /foreign key constraint/i, key: "errorHintForeignKey" },
  { test: /duplicate entry|duplicate key|unique constraint/i, key: "errorHintDuplicate" },
  {
    test: /access denied|authentication failed|password authentication failed/i,
    key: "errorHintAccessDenied",
  },
  // Connection dropped mid-session (server closed an idle connection, socket
  // broke, network/VPN drop). Must precede the generic "can't connect" pattern
  // so a lost connection gets the reconnect-oriented hint, not the "check host"
  // one. Covers MySQL ("gone away" / "lost connection" / "broken pipe"),
  // PostgreSQL ("terminating connection" / "server closed the connection") and
  // sqlx's transport wording ("error communicating with database").
  {
    test: /server has gone away|lost connection|broken pipe|connection was killed|server closed the connection|terminating connection|error communicating with database/i,
    key: "errorHintConnectionLost",
  },
  {
    test: /connection refused|(?:can't|cannot|couldn't|could not) connect|connection reset|connection timed out/i,
    key: "errorHintConnection",
  },
];

export function matchErrorHint(raw: string): I18nKey | null {
  for (const { test, key } of PATTERNS) {
    if (test.test(raw)) return key;
  }
  return null;
}
