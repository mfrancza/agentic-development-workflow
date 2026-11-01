/**
 * anchor-completeness.test.ts
 *
 * Ensures that every self-referencing reusable-workflow pin of the form
 *   uses: mfrancza/agentic-development-workflow/.github/workflows/<file>@<ref>
 * in the repository's workflow files is immediately preceded (with only blank
 * lines permitted between) by a matching anchor comment:
 *   # release-self-pin: <file>
 *
 * This guards the invariant that the release rewrite activity
 * (`.github/actions/rewrite-self-ref-pins`) will find and update every such
 * pin.  A new self-pin added without an anchor fails here on PR before merge,
 * so the rewriter can rely on the anchor being present (Decision 2 in
 * docs/design/release-self-pin-worker.md).
 *
 * See also: .github/scripts/test/pinned-worker-contracts.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PINNED_SELF_REF_RE } from "../src/lib/self-ref-pins.js";

const workflowsDir = new URL("../../../.github/workflows/", import.meta.url);

function allWorkflowFiles(): string[] {
  return readdirSync(fileURLToPath(workflowsDir))
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

function readWorkflow(name: string): string {
  return readFileSync(new URL(name, workflowsDir), "utf8");
}

/** Matches a `# release-self-pin: <worker>` anchor; captures the worker filename. */
const ANCHOR_RE = /^\s*#\s+release-self-pin:\s+(\S+)/;

describe("release-self-pin anchor completeness", () => {
  it(
    "every self-referencing uses: pin has a matching # release-self-pin: <worker> anchor " +
      "on the preceding non-blank line",
    () => {
      const violations: string[] = [];

      for (const file of allWorkflowFiles()) {
        const content = readWorkflow(file);
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          // Skip comment lines — the self-ref pattern can appear in prose comments
          // (e.g. a documentation example) and must not be treated as a live pin.
          if (/^\s*#/.test(lines[i])) continue;

          const m = lines[i].match(PINNED_SELF_REF_RE);
          if (!m) continue;

          const workerFile = m[1];

          // Walk backward from the uses: line, skipping blank (whitespace-only)
          // lines, to find what should be the anchor.
          let anchorIdx = i - 1;
          while (anchorIdx >= 0 && lines[anchorIdx].trim() === "") {
            anchorIdx--;
          }

          const anchorMatch =
            anchorIdx >= 0 ? ANCHOR_RE.exec(lines[anchorIdx]) : null;
          const hasMatchingAnchor =
            anchorMatch !== null && anchorMatch[1] === workerFile;

          if (!hasMatchingAnchor) {
            violations.push(
              `${file}:${i + 1}: self-referencing pin for "${workerFile}" is ` +
                `missing a "# release-self-pin: ${workerFile}" anchor on the ` +
                `preceding non-blank line. ` +
                `Add the anchor so the release rewrite activity can find and ` +
                `update this pin (see docs/design/release-self-pin-worker.md Decision 2).`,
            );
          }
        }
      }

      expect(
        violations,
        "Every self-referencing uses: pin must have a " +
          '"# release-self-pin: <worker>" anchor on the preceding non-blank line ' +
          "(blank lines between anchor and pin are allowed).\n\n" +
          "To fix: add the anchor comment immediately above the uses: line.\n\n" +
          violations.map((v) => `  - ${v}`).join("\n"),
      ).toEqual([]);
    },
  );
});
