/**
 * Pure logic for the "type the target name to confirm" gate placed in front
 * of irreversible operations on production (`is_production`) connections —
 * DROP / TRUNCATE (from the dangerous-query dialog and the connection tree's
 * table actions) and applying a schema/data sync plan that contains a
 * destructive statement (`SchemaCompareView`). #675.
 *
 * Modeled on the GitHub repository-deletion pattern: the confirm action stays
 * disabled until the typed text exactly matches an expected string, so a
 * single misplaced click (or stray Enter) can no longer trigger the
 * operation. Like `confirm_writes` and the `is_production` connect warning
 * (see CLAUDE.md), this is a UI safety net only — the backend does not
 * require or check this text, and calling the IPC directly bypasses it.
 * Non-production connections are unaffected and keep the existing one-click
 * confirmation.
 */

/**
 * Fixed phrase to require when no single, unambiguous target name can be
 * resolved — e.g. a multi-statement script drops/truncates several
 * differently-named tables, or the safety net couldn't parse a name at all.
 * Kept ASCII/uppercase so it's easy to type regardless of the active locale
 * or IME.
 */
export const TYPE_TO_CONFIRM_FALLBACK = "CONFIRM";

/**
 * Picks what the user must type before an irreversible production operation
 * proceeds, given the candidate target names extracted from one or more
 * destructive statements (e.g. the `target` of each `drop`/`truncate`
 * `DangerFinding` in a script).
 *
 * - Exactly one distinct, non-empty name across all candidates -> that name.
 * - Zero, or more than one distinct name (ambiguous target, or the name
 *   couldn't be parsed) -> `TYPE_TO_CONFIRM_FALLBACK`, so the gate always has
 *   something concrete to ask for instead of silently skipping itself.
 */
export function resolveTypedConfirmTarget(
  names: ReadonlyArray<string | null | undefined>,
): string {
  const distinct = new Set(
    names.map((n) => n?.trim()).filter((n): n is string => !!n && n.length > 0),
  );
  return distinct.size === 1 ? [...distinct][0] : TYPE_TO_CONFIRM_FALLBACK;
}

/**
 * True when `input` exactly matches `expected` once each is trimmed of
 * surrounding whitespace. Case-sensitive and otherwise exact — mirroring
 * GitHub's type-to-confirm inputs — so a near-miss does not silently pass.
 */
export function typedConfirmMatches(input: string, expected: string): boolean {
  const wanted = expected.trim();
  return wanted.length > 0 && input.trim() === wanted;
}
