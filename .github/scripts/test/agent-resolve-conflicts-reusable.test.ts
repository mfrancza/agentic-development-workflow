import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * Workflow-wiring regression tests for agent-resolve-conflicts-reusable.yml.
 *
 * These assertions lock in Decisions 1–6 from
 * docs/design/resolve-conflicts-external-author.md:
 *
 *  1. The reusable declares `developer-login` as a required input with no
 *     default, so external callers must supply the bot login explicitly.
 *  2. The `find-conflicted-prs` job contains a shell step that strips the
 *     `[bot]` suffix and writes `author=app/<slug>` to GITHUB_OUTPUT.
 *  3. The `Find conflicted agent-authored PRs` step wires that output to its
 *     `with.author` input, keyed via the step id used in the strip step.
 *  4. The upstream caller stub `agent-resolve-conflicts.yml` passes
 *     `developer-login` as a non-empty string literal (not an expression).
 */

const workflowsDir = new URL(
  "../../../.github/workflows/",
  import.meta.url,
);

// Load and parse the two workflow files under test.
const reusableContent = readFileSync(
  new URL("agent-resolve-conflicts-reusable.yml", workflowsDir),
  "utf8",
);
const callerContent = readFileSync(
  new URL("agent-resolve-conflicts.yml", workflowsDir),
  "utf8",
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reusable = load(reusableContent) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const caller = load(callerContent) as any;

describe("agent-resolve-conflicts-reusable.yml — developer-login input", () => {
  it("declares developer-login as a required input with no default", () => {
    const inputs = reusable?.on?.workflow_call?.inputs ?? {};
    const devLogin = inputs["developer-login"];

    expect(
      devLogin,
      "on.workflow_call.inputs.developer-login must exist",
    ).toBeDefined();

    expect(
      devLogin.required,
      "developer-login must have required: true",
    ).toBe(true);

    expect(
      "default" in devLogin,
      "developer-login must not have a default value — callers must supply it explicitly",
    ).toBe(false);
  });
});

describe("agent-resolve-conflicts-reusable.yml — find-conflicted-prs job wiring", () => {
  const steps: Array<{ name?: string; id?: string; run?: string; with?: Record<string, string> }> =
    reusable?.jobs?.["find-conflicted-prs"]?.steps ?? [];

  it("contains a step that strips [bot] suffix and writes author=app/<slug> to GITHUB_OUTPUT", () => {
    // js-yaml parses YAML block scalars verbatim, so `\n` in the YAML
    // source becomes the two-character sequence `\` + `n` in the JS string.
    // We search for `printf 'author=app/%s` (without the closing quote and
    // the literal \n) so the assertion holds regardless of the trailing
    // newline escape format.
    const stripStep = steps.find(
      (s) =>
        typeof s.run === "string" &&
        s.run.includes("${DEVELOPER_LOGIN%\\[bot\\]}") &&
        s.run.includes("printf 'author=app/%s") &&
        s.run.includes("$GITHUB_OUTPUT"),
    );

    expect(
      stripStep,
      "find-conflicted-prs job must have a step with the [bot] suffix-strip " +
        "pattern (${DEVELOPER_LOGIN%\\[bot\\]}) and a printf 'author=app/%s' write to $GITHUB_OUTPUT",
    ).toBeDefined();
  });

  it("the strip step has an id and the Find conflicted agent-authored PRs step wires that id via steps.<id>.outputs.author", () => {
    // Find the strip step (same predicate as above) and extract its id.
    const stripStep = steps.find(
      (s) =>
        typeof s.run === "string" &&
        s.run.includes("${DEVELOPER_LOGIN%\\[bot\\]}") &&
        s.run.includes("printf 'author=app/%s") &&
        s.run.includes("$GITHUB_OUTPUT"),
    );

    expect(stripStep?.id, "the [bot]-strip step must declare an id").toBeTruthy();

    const stripStepId = stripStep!.id!;

    // Find the finder step.
    const finderStep = steps.find(
      (s) => s.name === "Find conflicted agent-authored PRs",
    );

    expect(
      finderStep,
      "find-conflicted-prs job must contain a step named 'Find conflicted agent-authored PRs'",
    ).toBeDefined();

    const authorInput = finderStep?.with?.author;
    const expectedAuthorExpression = `\${{ steps.${stripStepId}.outputs.author }}`;

    expect(
      authorInput,
      `Find conflicted agent-authored PRs step must pass author: ${expectedAuthorExpression}`,
    ).toBe(expectedAuthorExpression);
  });
});

describe("agent-resolve-conflicts.yml — caller stub wires developer-login", () => {
  it("passes developer-login as a non-empty string literal (not an expression)", () => {
    // Locate the job that calls the reusable and inspect its with block.
    const jobs = caller?.jobs ?? {};
    const reusableJob = Object.values(jobs).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (j: any) =>
        typeof j.uses === "string" &&
        j.uses.includes("agent-resolve-conflicts-reusable.yml"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any | undefined;

    expect(
      reusableJob,
      "agent-resolve-conflicts.yml must contain a job that uses agent-resolve-conflicts-reusable.yml",
    ).toBeDefined();

    const developerLogin = reusableJob?.with?.["developer-login"];

    expect(
      developerLogin,
      "agent-resolve-conflicts.yml must pass developer-login in the with: block",
    ).toBeTruthy();

    // Must be a plain string, not a GitHub Actions expression (${{ ... }}).
    expect(
      typeof developerLogin,
      "developer-login must be a string value, not an expression object",
    ).toBe("string");

    expect(
      developerLogin.trim().startsWith("${{"),
      "developer-login must be a literal string value, not a workflow expression (${{ ... }})",
    ).toBe(false);
  });
});
