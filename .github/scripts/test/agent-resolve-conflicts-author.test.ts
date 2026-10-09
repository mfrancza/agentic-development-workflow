/**
 * Static contract test for the developer-author input added to
 * agent-resolve-conflicts-reusable.yml (issue #605).
 *
 * This test does not execute any workflow YAML — it reads the file as text
 * and asserts structural invariants so that a future edit cannot silently
 * drop the input, its default, or the pass-through to find-conflicted-prs.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reusablePath = new URL(
  "../../../.github/workflows/agent-resolve-conflicts-reusable.yml",
  import.meta.url,
);
const reusable = readFileSync(reusablePath, "utf8");

describe(
  "agent-resolve-conflicts-reusable.yml — developer-author input contract",
  () => {
    it("declares the developer-author input so external callers can configure the author filter", () => {
      // The input must be present in the workflow_call inputs block so that
      // external adopters can override which bot identity is enumerated.
      expect(reusable).toContain("developer-author:");
    });

    it("defaults developer-author to app/mfrancza-developer-agent for backward compatibility", () => {
      // The default must match the TypeScript finder's built-in default
      // (find-conflicted-prs.ts line: core.getInput("author") || "app/mfrancza-developer-agent")
      // so callers that omit the input continue to enumerate developer-agent PRs
      // without any behavioral change.
      expect(reusable).toContain(
        "default: 'app/mfrancza-developer-agent'",
      );
    });

    it("passes developer-author to the find-conflicted-prs action as the author input", () => {
      // The value supplied (or defaulted) by the caller must reach the action
      // so that it actually controls which PRs are enumerated.
      expect(reusable).toContain(
        "author: ${{ inputs.developer-author }}",
      );
    });
  },
);
