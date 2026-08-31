/**
 * Parses a "Closes #N" reference from a PR body.
 *
 * Matches the first occurrence of `closes #N` (case-insensitive) where N is
 * one or more digits.  Only the canonical `Closes #N` form is supported;
 * `Fixes`, `Resolves`, and cross-repo references (owner/repo#N) are
 * intentionally excluded to match the existing behaviour in
 * `resolve-deployment.ts`.
 *
 * @param body  The pull-request body text, or null when the body is absent.
 * @returns     The referenced issue number, or undefined if no match is found.
 */
export function parseClosesRef(body: string | null): number | undefined {
  if (body === null) return undefined;
  const match = body.match(/closes\s+#(\d+)/i);
  if (!match) return undefined;
  return parseInt(match[1], 10);
}
