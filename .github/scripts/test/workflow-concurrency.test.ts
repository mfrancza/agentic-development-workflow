import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Caller stubs live in .github/workflows/ and are named agent-*.yml.
// Reusable counterparts end in -reusable.yml and are excluded — they are not
// the files adopters copy, and they may declare concurrency inside the jobs
// that the reusable exposes without the label/sender gating concern.
const workflowsDir = new URL(
  "../../../.github/workflows/",
  import.meta.url,
);
const callerFiles = readdirSync(workflowsDir)
  .filter(
    (f) =>
      f.startsWith("agent-") &&
      f.endsWith(".yml") &&
      !f.endsWith("-reusable.yml"),
  )
  .map((f) => ({
    name: f,
    content: readFileSync(new URL(f, workflowsDir), "utf8"),
  }));

/**
 * Returns true when the workflow declares `concurrency:` at the top level
 * (i.e. before the `jobs:` key, at column 0).  A job-level `concurrency:`
 * is indented and therefore not matched by this check.
 */
function hasWorkflowLevelConcurrency(content: string): boolean {
  for (const line of content.split("\n")) {
    if (/^jobs:/.test(line)) break;
    if (/^concurrency:/.test(line)) return true;
  }
  return false;
}

/**
 * Returns true when the workflow contains a label-name or sender-login gate
 * — the patterns that make a queued run vulnerable to displacement by any
 * other label event on the same issue or PR.
 */
function hasLabelOrSenderGate(content: string): boolean {
  return (
    content.includes("github.event.label.name") ||
    content.includes("github.event.sender.login")
  );
}

describe("agent-*.yml caller stubs — concurrency placement", () => {
  it("finds at least one caller stub to test", () => {
    expect(callerFiles.length).toBeGreaterThan(0);
  });

  it("no caller stub with a label/sender gate declares workflow-level concurrency", () => {
    // When concurrency is declared at the workflow level, GitHub assigns the
    // run to its concurrency group *before* any job-level `if:` is evaluated.
    // With cancel-in-progress: false a queued (not yet started) run is still
    // displaced by a newer run in the same group — the new run then skips
    // because its label does not match the gate.  The fix is to place
    // `concurrency:` inside the gated job (below its `if:`), matching the
    // pattern already used in agent-design.yml.
    const violations = callerFiles.filter(
      ({ content }) =>
        hasWorkflowLevelConcurrency(content) && hasLabelOrSenderGate(content),
    );
    expect(
      violations.map((v) => v.name),
      "These caller stubs declare concurrency at the workflow level but also " +
        "carry a label/sender gate on a job. Move the concurrency block inside " +
        "the gated job (below its `if:`) so a competing label event cannot " +
        "displace a queued agent run. See agent-design.yml for the correct shape.",
    ).toEqual([]);
  });
});
