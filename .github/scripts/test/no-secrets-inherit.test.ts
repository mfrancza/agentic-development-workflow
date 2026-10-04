import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static regression test: no caller stub uses `secrets: inherit` when calling
 * a reusable workflow.
 *
 * `secrets: inherit` only propagates secrets within the same GitHub
 * organization.  An external adopter calling
 * `mfrancza/agentic-development-workflow/.github/workflows/*-reusable.yml@v0`
 * from a different organization receives no secrets at all, causing the
 * reusable to fail at startup with "Secret X is required, but not provided
 * while calling".
 *
 * Decision 1 of docs/design/cross-org-secrets-explicit-passthrough.md:
 * every caller stub (in-repo and cross-repo) must replace `secrets: inherit`
 * with an explicit `secrets:` block naming every secret declared by the
 * reusable.  See that document for the audit table of required/optional
 * secrets per reusable.
 */

// Follows the same file-reading idiom as workflow-concurrency.test.ts.
const workflowsDir = new URL(
  "../../../.github/workflows/",
  import.meta.url,
);

/**
 * Matches a YAML `uses:` key (indented, so not a comment) that targets a
 * `*-reusable.yml` file — either:
 *   in-repo:    uses: ./.github/workflows/<name>-reusable.yml
 *   cross-repo: uses: mfrancza/agentic-development-workflow/.github/workflows/<name>-reusable.yml@<ref>
 *
 * No exceptions: Decision 1 applies to every caller, regardless of whether
 * it is the repo's own stub or an external adopter's copy.
 */
const REUSABLE_USES_RE = /^\s+uses:\s+\S.*-reusable\.yml/;

/**
 * Matches any YAML `uses:` key (indented, so not a comment or shell
 * script).  Used as the window-end sentinel: when scanning the lines after a
 * reusable `uses:`, we stop at the next `uses:` line (the start of the next
 * job or step block).
 */
const ANY_USES_RE = /^\s+uses:\s+\S/;

// A "caller stub" is any .yml file that references at least one *-reusable.yml.
// *-reusable.yml files themselves do not call other reusables, so this filter
// naturally excludes them — no explicit exclusion needed.
const callerFiles = readdirSync(workflowsDir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({
    name: f,
    content: readFileSync(new URL(f, workflowsDir), "utf8"),
  }))
  .filter(({ content }) =>
    content.split("\n").some((line) => REUSABLE_USES_RE.test(line)),
  );

/**
 * For a given workflow file content, find every reusable `uses:` call site
 * that is followed by `secrets: inherit` before the next `uses:` line (or EOF).
 *
 * Algorithm: scan lines sequentially.  When a line matching REUSABLE_USES_RE
 * is found, collect subsequent lines into a "window" until the next line that
 * matches ANY_USES_RE or EOF is reached.  If the window contains
 * `secrets: inherit` (as a YAML key — matched with the multiline `^` anchor
 * so comment lines are excluded), record a violation.
 *
 * Returns one entry per violating call site (a file can have several, e.g.
 * agent-auto-trigger.yml calls the same reusable six times).
 */
function findSecretsInheritViolations(
  fileName: string,
  content: string,
): string[] {
  const violations: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!REUSABLE_USES_RE.test(lines[i])) continue;

    // Open a window from this line to (but not including) the next YAML
    // `uses:` key, or to EOF when no further `uses:` line exists.
    const windowLines: string[] = [lines[i]];
    let j = i + 1;
    while (j < lines.length && !ANY_USES_RE.test(lines[j])) {
      windowLines.push(lines[j]);
      j++;
    }

    const window = windowLines.join("\n");

    // Check for `secrets: inherit` as a YAML key.  The /m flag makes `^`
    // match at the start of each line so comment lines (which start with `#`
    // after optional whitespace) are not caught.
    if (/^\s*secrets:\s+inherit/m.test(window)) {
      violations.push(
        `${fileName}: call to "${lines[i].trim()}" uses \`secrets: inherit\``,
      );
    }
  }

  return violations;
}

describe(
  "caller stubs — no secrets: inherit when calling a *-reusable.yml",
  () => {
    it("finds at least one caller stub to test", () => {
      // Sanity guard: the test must not silently pass on an empty match set.
      expect(callerFiles.length).toBeGreaterThan(0);
    });

    it("no caller stub uses secrets: inherit when calling a reusable workflow", () => {
      const violations = callerFiles.flatMap(({ name, content }) =>
        findSecretsInheritViolations(name, content),
      );

      expect(
        violations,
        "One or more caller stubs pass secrets via `secrets: inherit` when " +
          "calling a `*-reusable.yml` target.  `secrets: inherit` only " +
          "propagates secrets within the same GitHub organization; external " +
          "adopters in a different org receive no secrets and their workflows " +
          "fail at startup.\n" +
          "Fix: replace `secrets: inherit` with an explicit `secrets:` block " +
          "naming every secret declared by the reusable (required and optional).\n" +
          "Reference: docs/design/cross-org-secrets-explicit-passthrough.md\n\n" +
          `Offending call sites (${violations.length}):\n` +
          violations.map((v) => `  - ${v}`).join("\n"),
      ).toEqual([]);
    });
  },
);
