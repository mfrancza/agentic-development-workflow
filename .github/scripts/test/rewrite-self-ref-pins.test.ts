import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock calls are hoisted before imports, so mocks are in place when the
// module under test is loaded (including the module-level run() invocation).
vi.mock("@actions/core", () => ({
  getInput: vi.fn().mockReturnValue(""),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
}));

import * as core from "@actions/core";
import { rewriteFileContent, run } from "../src/rewrite-self-ref-pins.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────
//
// All fixtures use the real owner/repo path so the PINNED_SELF_REF_RE regex
// matches exactly as it does against live workflow files.

/** A live uses: line with a self-referencing pin at v0.3.0. */
const SELF_REF_LINE =
  "    uses: mfrancza/agentic-development-workflow/.github/workflows/agent-review-worker-reusable.yml@v0.3.0";

/** A second self-referencing pin (different worker file) also at v0.3.0. */
const SELF_REF_LINE_2 =
  "    uses: mfrancza/agentic-development-workflow/.github/workflows/other-worker-reusable.yml@v0.3.0";

/**
 * A comment line that contains the self-ref pattern as prose.
 * This mirrors the kind of comment that appears above the live uses: line in
 * agent-review-reusable.yml (e.g. on line 139 of the file), where the worker
 * filename and version are mentioned inline as documentation.
 */
const COMMENT_WITH_SELF_REF_PATTERN =
  "    # uses: mfrancza/agentic-development-workflow/.github/workflows/agent-review-worker-reusable.yml@v0.3.0";

/** An unrelated uses: line (third-party action, not a self-ref). */
const UNRELATED_USES_LINE =
  "      uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0";

// ─── rewriteFileContent — pure-function tests ──────────────────────────────

describe("rewriteFileContent", () => {
  it("rewrites a single self-referencing pin (single-match file)", () => {
    const content = `${SELF_REF_LINE}\n`;
    const result = rewriteFileContent(content, "v1.0.0");
    expect(result).not.toBeNull();
    expect(result).toContain("@v1.0.0");
    expect(result).not.toContain("@v0.3.0");
    // Leading indentation must be preserved.
    expect(result!.split("\n")[0]).toMatch(/^\s{4}uses:/);
  });

  it("rewrites every self-referencing pin when multiple are present (multi-match file)", () => {
    const content = `${SELF_REF_LINE}\n${SELF_REF_LINE_2}\n`;
    const result = rewriteFileContent(content, "v1.0.0");
    expect(result).not.toBeNull();
    expect(
      result!.split("\n").filter((l) => l.includes("@v0.3.0")),
    ).toHaveLength(0);
    expect(
      result!.split("\n").filter((l) => l.includes("@v1.0.0")),
    ).toHaveLength(2);
  });

  it("returns null for a file with no self-referencing pins (no-match file)", () => {
    const content = [
      "on:",
      "  push:",
      "",
      "jobs:",
      "  build:",
      "    steps:",
      `      - ${UNRELATED_USES_LINE}`,
      "",
    ].join("\n");
    expect(rewriteFileContent(content, "v1.0.0")).toBeNull();
  });

  it("does not rewrite a self-ref pattern that appears inside a # comment line", () => {
    // COMMENT_WITH_SELF_REF_PATTERN mirrors the kind of comment present in
    // agent-review-reusable.yml where the worker filename and version are
    // mentioned as documentation. It must never be rewritten.
    const content = `${COMMENT_WITH_SELF_REF_PATTERN}\n${SELF_REF_LINE}\n`;
    const result = rewriteFileContent(content, "v1.0.0");
    expect(result).not.toBeNull();
    // Comment line must be exactly unchanged.
    expect(result!.split("\n")[0]).toBe(COMMENT_WITH_SELF_REF_PATTERN);
    // The live uses: line below the comment must be rewritten.
    expect(result!.split("\n")[1]).toContain("@v1.0.0");
    expect(result!.split("\n")[1]).not.toContain("@v0.3.0");
  });

  it("does not rewrite unrelated uses: lines such as actions/checkout@…", () => {
    const content = `${UNRELATED_USES_LINE}\n`;
    expect(rewriteFileContent(content, "v1.0.0")).toBeNull();
  });

  it("returns null when the pin already matches the target version (no-op)", () => {
    const alreadyAtTarget = SELF_REF_LINE.replace("@v0.3.0", "@v1.0.0");
    const content = `${alreadyAtTarget}\n`;
    expect(rewriteFileContent(content, "v1.0.0")).toBeNull();
  });

  it("returns null only for the already-matched pins and rewrites the others in a mixed file", () => {
    // One pin already at target, one still at old ref.
    const alreadyAtTarget = SELF_REF_LINE.replace("@v0.3.0", "@v1.0.0");
    const content = `${alreadyAtTarget}\n${SELF_REF_LINE_2}\n`;
    const result = rewriteFileContent(content, "v1.0.0");
    expect(result).not.toBeNull();
    // Already-at-target pin must be unchanged.
    expect(result!.split("\n")[0]).toBe(alreadyAtTarget);
    // Stale pin must be updated.
    expect(result!.split("\n")[1]).toContain("@v1.0.0");
    expect(result!.split("\n")[1]).not.toContain("@v0.3.0");
  });
});

// ─── run() — directory-level integration tests ─────────────────────────────

describe("run() — directory processing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rewrite-self-ref-pins-test-"));
    vi.clearAllMocks();
    // Default: return "" for all inputs so the module-level run() call
    // (triggered on import) fails fast on the version-validation check
    // and is caught by the mocked setFailed — no filesystem access occurs.
    vi.mocked(core.getInput).mockReturnValue("");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockInputs(inputs: Record<string, string>): void {
    vi.mocked(core.getInput).mockImplementation(
      (name: string) => inputs[name] ?? "",
    );
  }

  it(
    "processes a mix of self-reference files and non-matching files in the same directory, " +
      "rewriting only the self-reference files and reporting the correct count",
    async () => {
      const selfRefContent = `jobs:\n  call:\n${SELF_REF_LINE}\n`;
      const noMatchContent = `on: push\njobs:\n  build:\n    steps:\n${UNRELATED_USES_LINE}\n`;

      writeFileSync(join(tmpDir, "workflow-with-pin.yml"), selfRefContent);
      writeFileSync(join(tmpDir, "workflow-no-pin.yml"), noMatchContent);

      mockInputs({ workflows_dir: tmpDir, target_version: "v1.0.0" });
      await run();

      expect(core.setOutput).toHaveBeenCalledWith("changed", "true");
      expect(core.setOutput).toHaveBeenCalledWith("files-changed", "1");

      // Self-ref file must be rewritten.
      const updatedContent = readFileSync(
        join(tmpDir, "workflow-with-pin.yml"),
        "utf8",
      );
      expect(updatedContent).toContain("@v1.0.0");
      expect(updatedContent).not.toContain("@v0.3.0");

      // Non-matching file must be untouched.
      const unchangedContent = readFileSync(
        join(tmpDir, "workflow-no-pin.yml"),
        "utf8",
      );
      expect(unchangedContent).toBe(noMatchContent);
    },
  );

  it("reports changed=false and files-changed=0 when no files contain self-referencing pins", async () => {
    writeFileSync(join(tmpDir, "workflow.yml"), `on: push\n`);

    mockInputs({ workflows_dir: tmpDir, target_version: "v1.0.0" });
    await run();

    expect(core.setOutput).toHaveBeenCalledWith("changed", "false");
    expect(core.setOutput).toHaveBeenCalledWith("files-changed", "0");
  });

  it("reports changed=false when every self-referencing pin already matches the target version", async () => {
    const alreadyAtTarget = `jobs:\n  call:\n${SELF_REF_LINE.replace("@v0.3.0", "@v1.0.0")}\n`;
    writeFileSync(join(tmpDir, "workflow.yml"), alreadyAtTarget);

    mockInputs({ workflows_dir: tmpDir, target_version: "v1.0.0" });
    await run();

    expect(core.setOutput).toHaveBeenCalledWith("changed", "false");
    expect(core.setOutput).toHaveBeenCalledWith("files-changed", "0");

    // File must not have been written (content remains identical).
    expect(readFileSync(join(tmpDir, "workflow.yml"), "utf8")).toBe(
      alreadyAtTarget,
    );
  });

  it("throws when target-version does not match the required vX.Y.Z pattern", async () => {
    mockInputs({ workflows_dir: tmpDir, target_version: "1.0.0" });
    await expect(run()).rejects.toThrow(/\^v\\d\+/);
  });

  it("processes both .yml and .yaml files and skips other extensions", async () => {
    const selfRefYml = `jobs:\n  call:\n${SELF_REF_LINE}\n`;
    const selfRefYaml = `jobs:\n  call:\n${SELF_REF_LINE_2}\n`;
    const notAWorkflow = `not: a workflow\n`;

    writeFileSync(join(tmpDir, "a.yml"), selfRefYml);
    writeFileSync(join(tmpDir, "b.yaml"), selfRefYaml);
    writeFileSync(join(tmpDir, "README.md"), notAWorkflow);

    mockInputs({ workflows_dir: tmpDir, target_version: "v2.0.0" });
    await run();

    expect(core.setOutput).toHaveBeenCalledWith("changed", "true");
    expect(core.setOutput).toHaveBeenCalledWith("files-changed", "2");

    expect(readFileSync(join(tmpDir, "a.yml"), "utf8")).toContain("@v2.0.0");
    expect(readFileSync(join(tmpDir, "b.yaml"), "utf8")).toContain("@v2.0.0");
    // Non-workflow file must be untouched.
    expect(readFileSync(join(tmpDir, "README.md"), "utf8")).toBe(notAWorkflow);
  });
});
