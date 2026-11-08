import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The three branch-writing reusable workflows that must all share the same
// concurrency group prefix so that only one write job runs per PR at a time.
const workflowsDir = new URL(
  "../../../.github/workflows/",
  import.meta.url,
);

const branchWritingReusables = [
  "agent-fix-checks-reusable.yml",
  "agent-respond-review-reusable.yml",
  "agent-resolve-conflicts-reusable.yml",
].map((f) => ({
  name: f,
  content: readFileSync(new URL(f, workflowsDir), "utf8"),
}));

// Retired prefixes — these must not appear anywhere in the three files.
const retiredPrefixes = [
  "agent-fix-checks-pr-",
  "agent-respond-review-pr-",
  "agent-resolve-conflicts-pr-",
];

describe("branch-writing reusables — shared concurrency group", () => {
  it("finds the expected three reusable files", () => {
    expect(branchWritingReusables.length).toBe(3);
  });

  for (const { name, content } of branchWritingReusables) {
    it(`${name}: contains exactly one line matching the shared group prefix`, () => {
      const matchingLines = content
        .split("\n")
        .filter((line) => /^\s*group:\s*agent-branch-pr-/.test(line));
      expect(
        matchingLines.length,
        `Expected exactly one 'group: agent-branch-pr-…' line in ${name}, ` +
          `found ${matchingLines.length}: ${JSON.stringify(matchingLines)}`,
      ).toBe(1);
    });

    for (const retired of retiredPrefixes) {
      it(`${name}: does not contain retired prefix '${retired}'`, () => {
        const retiredLines = content
          .split("\n")
          .filter((line) => line.includes(retired));
        expect(
          retiredLines.length,
          `Found retired concurrency group prefix '${retired}' in ${name}: ` +
            JSON.stringify(retiredLines),
        ).toBe(0);
      });
    }
  }
});
