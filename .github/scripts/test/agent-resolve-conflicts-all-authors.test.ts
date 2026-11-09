/**
 * Static contract test for the all-authors input added to
 * agent-resolve-conflicts-reusable.yml and agent-resolve-conflicts.yml
 * (issue #804).
 *
 * This test does not execute any workflow YAML — it reads the files as text
 * and asserts structural invariants so that a future edit cannot silently
 * drop the input, its default, or the pass-through chain from the caller
 * stub through the reusable workflow to the find-conflicted-prs action.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reusablePath = new URL(
  "../../../.github/workflows/agent-resolve-conflicts-reusable.yml",
  import.meta.url,
);
const reusable = readFileSync(reusablePath, "utf8");

const callerPath = new URL(
  "../../../.github/workflows/agent-resolve-conflicts.yml",
  import.meta.url,
);
const caller = readFileSync(callerPath, "utf8");

describe(
  "agent-resolve-conflicts-reusable.yml — all-authors input contract",
  () => {
    it("declares the all-authors input so external callers can opt into the all-authors sweep", () => {
      // The input must be present in the workflow_call inputs block so that
      // callers can pass through the RESOLVE_CONFLICTS_ALL_AUTHORS variable.
      expect(reusable).toContain("all-authors:");
    });

    it("defaults all-authors to 'false' for backward compatibility", () => {
      // The default must be 'false' so that callers that omit the input
      // continue to enumerate only developer-agent PRs without any behavioral
      // change. The single-quoted form matches YAML scalar conventions in this
      // repo's workflow files.
      expect(reusable).toContain("default: 'false'");
    });

    it("declares all-authors exactly once (a duplicate YAML key makes GitHub reject the workflow)", () => {
      // Two PRs adding the same input in different positions can merge without
      // a textual conflict but produce a duplicate mapping key. GitHub then
      // refuses to load the workflow (zero-job failure on every push).
      const declarations = reusable.match(/^ {6}all-authors:\s*$/gm) ?? [];
      expect(declarations).toHaveLength(1);
    });

    it("passes all-authors to the find-conflicted-prs action as the all-authors input", () => {
      // The value supplied (or defaulted) by the caller must reach the action
      // so that it actually controls which PRs are enumerated.
      expect(reusable).toContain(
        "all-authors: ${{ inputs.all-authors }}",
      );
    });
  },
);

describe(
  "agent-resolve-conflicts.yml — all-authors pass-through contract",
  () => {
    it("passes all-authors to the reusable workflow from RESOLVE_CONFLICTS_ALL_AUTHORS", () => {
      // The caller stub must wire vars.RESOLVE_CONFLICTS_ALL_AUTHORS through
      // to the reusable workflow's all-authors input so that the Terraform
      // variable controls the runtime behavior.
      expect(caller).toContain(
        "all-authors: ${{ vars.RESOLVE_CONFLICTS_ALL_AUTHORS }}",
      );
    });
  },
);
