/**
 * Parses the caller-configured check-name allowlist. The boundary is
 * deliberately fail-closed: only a non-empty JSON array containing strings
 * can authorise a fix-checks run.
 */
export function parseAllowedChecks(input: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(input);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((name) => typeof name === "string")
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}
