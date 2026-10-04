import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Caller stubs live in .github/workflows/ and are any .yml files that are NOT
// *-reusable.yml counterparts.  Unlike the concurrency test, this check is not
// restricted to the agent-* prefix: terraform-ci.yml is explicitly in scope
// (named in the parent issue #581), and future reusable-callers may ship under
// other prefixes.  Every non-reusable workflow file is therefore included so
// that a future edit cannot slip `secrets: inherit` in under an unchecked name.
const workflowsDir = new URL(
  "../../../.github/workflows/",
  import.meta.url,
);
const callerFiles = readdirSync(workflowsDir)
  .filter((f) => f.endsWith(".yml") && !f.endsWith("-reusable.yml"))
  .map((f) => ({
    name: f,
    content: readFileSync(new URL(f, workflowsDir), "utf8"),
  }));

/**
 * Returns true if the file content contains at least one `uses:` line targeting
 * a `*-reusable.yml` workflow where the surrounding job block also declares
 * `secrets: inherit`.
 *
 * "Surrounding job block" is determined by indentation: starting from the
 * `uses:` line, we scan forward until we encounter a non-empty, non-comment
 * line whose indentation is strictly less than the `uses:` line's indentation
 * (which signals the start of a sibling job or a parent key — i.e. we have
 * left the job block).  Any `secrets: inherit` found between the `uses:` line
 * and that boundary is a violation.
 *
 * Both local references (./.github/workflows/foo-reusable.yml) and remote
 * references (owner/repo/.github/workflows/foo-reusable.yml@ref) are matched
 * by the regex, because `-reusable.yml` appears in the non-whitespace token
 * regardless of the path prefix or trailing `@ref`.
 */
function hasSecretsInheritOnReusableCall(content: string): boolean {
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match a `uses:` line that references a *-reusable.yml (local or remote).
    if (!/uses:\s+\S+-reusable\.yml/.test(line)) continue;

    // Determine the indentation depth of this `uses:` line.
    const usesIndent = (line.match(/^(\s*)/) ?? ["", ""])[1].length;

    // Scan forward within the same job block.
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];

      // Blank lines and comment-only lines are not job-block boundaries.
      if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) continue;

      const nextIndent = (nextLine.match(/^(\s*)/) ?? ["", ""])[1].length;

      // A non-empty line with less indentation than the `uses:` line marks the
      // end of the current job block (e.g. the next sibling job key at indent 2
      // when `uses:` was at indent 4).
      if (nextIndent < usesIndent) break;

      // `secrets: inherit` at any indentation within the job block is a violation.
      if (/^\s+secrets:\s+inherit\s*$/.test(nextLine)) return true;
    }
  }

  return false;
}

describe("caller stubs — no secrets: inherit on *-reusable.yml calls", () => {
  it("finds at least one caller stub to test", () => {
    expect(callerFiles.length).toBeGreaterThan(0);
  });

  it("no caller stub uses secrets: inherit when calling a *-reusable.yml", () => {
    // `secrets: inherit` only propagates secrets to a called reusable workflow
    // when the caller and the reusable live in the **same GitHub organization**.
    // External adopters calling
    //   mfrancza/agentic-development-workflow/.github/workflows/*-reusable.yml@ref
    // from a different org receive **no** secrets — the workflow fails
    // immediately at startup with "Secret X is required, but not provided".
    //
    // The fix is an explicit `secrets:` block that names every secret the
    // reusable declares (both required and optional), using
    // `${{ secrets.FOO }}` expressions that evaluate to empty strings for
    // secrets the caller has not set — which the reusables (with
    // `required: false` for optional keys) already accept.
    //
    // See docs/design/cross-org-secrets-explicit-passthrough.md (Decision 3)
    // for the full rationale and the required explicit-secrets shape.
    const violations = callerFiles.filter(({ content }) =>
      hasSecretsInheritOnReusableCall(content),
    );
    expect(
      violations.map((v) => v.name),
      "These caller stubs use 'secrets: inherit' when calling a *-reusable.yml. " +
        "Replace 'secrets: inherit' with an explicit 'secrets:' block that names " +
        "every secret the reusable declares (both required and optional). " +
        "'secrets: inherit' is a no-op across org boundaries: external adopters " +
        "calling this repo's reusable workflows from a different GitHub organization " +
        "receive no secrets and the workflow fails at startup. " +
        "See docs/design/cross-org-secrets-explicit-passthrough.md (Decision 3) " +
        "for the rationale and the required explicit-secrets shape.",
    ).toEqual([]);
  });
});
