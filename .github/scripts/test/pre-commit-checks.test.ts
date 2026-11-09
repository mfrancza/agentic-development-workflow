import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = new URL("../../../", import.meta.url);
const helper = new URL("docker/scripts/lib/pre-commit-checks.sh", repoRoot).pathname;
const tempDirs: string[] = [];

interface RunOptions {
  /** Newline-separated list of files returned by `git diff --name-only`.
   *  Defaults to ".github/scripts/foo.ts" (touches .github/). */
  diffFiles?: string;
  /** Exit code for `npm ci`.  Defaults to 0 (success). */
  npmCiExit?: number;
  /** Number of output lines produced by each `npm run`/`npm test` invocation.
   *  Defaults to 5. */
  npmCheckLines?: number;
  /** Exit code for `npm run typecheck` (and `npm test`).  Defaults to 0. */
  npmCheckExit?: number;
  /** Exit code for `gh pr comment`.  Defaults to 0 (success). */
  ghCommentExit?: number;
  /** First argument to pre_commit_checks_run.  Defaults to "before-sha". */
  headBeforeSha?: string;
  /** Second argument to pre_commit_checks_run.  Defaults to "42". */
  prNumber?: string;
  /** Value returned by `git rev-parse HEAD`.  Defaults to "head-sha-abc". */
  headSha?: string;
}

function runChecks(options: RunOptions = {}) {
  const bin = mkdtempSync(join(tmpdir(), "pre-commit-checks-bin-"));
  tempDirs.push(bin);

  const workDir = mkdtempSync(join(tmpdir(), "pre-commit-checks-work-"));
  tempDirs.push(workDir);

  // Create the .github/scripts directory that the helper cd's into for npm.
  const scriptsDir = join(workDir, ".github", "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  // File where the mock gh writes the captured --body argument.
  const commentBodyFile = join(bin, "comment-body.txt");

  const diffFiles = options.diffFiles ?? ".github/scripts/foo.ts";
  const headSha = options.headSha ?? "head-sha-abc";
  const npmCiExit = options.npmCiExit ?? 0;
  const npmCheckLines = options.npmCheckLines ?? 5;
  const npmCheckExit = options.npmCheckExit ?? 0;
  const ghCommentExit = options.ghCommentExit ?? 0;

  // --- Mock git ---
  // Handles: diff --name-only <before>..HEAD  →  prints MOCK_DIFF_FILES
  //          rev-parse HEAD                   →  prints MOCK_HEAD_SHA
  writeFileSync(
    join(bin, "git"),
    `#!/bin/bash
case "$1" in
  diff)
    printf '%s' "\${MOCK_DIFF_FILES:-}"
    ;;
  rev-parse)
    printf '%s\\n' "\${MOCK_HEAD_SHA:-head-sha-abc}"
    ;;
  *)
    echo "unexpected git invocation: $*" >&2
    exit 1
    ;;
esac
`,
  );

  // --- Mock npm ---
  // Handles: ci          →  exits MOCK_NPM_CI_EXIT
  //          run <sub>   →  prints N lines then exits MOCK_NPM_CHECK_EXIT
  //          test        →  prints N lines then exits MOCK_NPM_CHECK_EXIT
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/bash
case "$1" in
  ci)
    exit "\${MOCK_NPM_CI_EXIT:-0}"
    ;;
  run|test)
    for i in $(seq 1 "\${MOCK_NPM_CHECK_LINES:-5}"); do
      printf 'output line %s\\n' "$i"
    done
    exit "\${MOCK_NPM_CHECK_EXIT:-0}"
    ;;
  *)
    echo "unexpected npm invocation: $*" >&2
    exit 1
    ;;
esac
`,
  );

  // --- Mock gh ---
  // Handles: pr comment ...  →  captures --body arg to MOCK_GH_COMMENT_BODY_FILE
  //                             (only when MOCK_GH_COMMENT_EXIT=0 so the body file
  //                             reflects whether the comment was actually "posted"),
  //                             then exits MOCK_GH_COMMENT_EXIT
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash
if [[ "$1" == "pr" && "$2" == "comment" ]]; then
  found_body=0
  for arg in "$@"; do
    if [[ $found_body -eq 1 ]]; then
      if [[ "\${MOCK_GH_COMMENT_EXIT:-0}" -eq 0 ]]; then
        printf '%s' "$arg" > "\${MOCK_GH_COMMENT_BODY_FILE:?}"
      fi
      found_body=0
      break
    fi
    if [[ "$arg" == "--body" ]]; then
      found_body=1
    fi
  done
  exit "\${MOCK_GH_COMMENT_EXIT:-0}"
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`,
  );

  for (const cmd of ["git", "npm", "gh"]) {
    chmodSync(join(bin, cmd), 0o755);
  }

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
log() { echo "[agent] $*"; }
source "$PRE_COMMIT_CHECKS"
pre_commit_checks_run "$HEAD_BEFORE_SHA" "$PR_NUMBER"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PRE_COMMIT_CHECKS: helper,
        WORK_DIR: workDir,
        GITHUB_REPO: "acme/widgets",
        GH_TOKEN: "fake-token",
        HEAD_BEFORE_SHA: options.headBeforeSha ?? "before-sha",
        PR_NUMBER: options.prNumber ?? "42",
        // Mock env vars consumed by the mock scripts
        MOCK_DIFF_FILES: diffFiles,
        MOCK_HEAD_SHA: headSha,
        MOCK_NPM_CI_EXIT: String(npmCiExit),
        MOCK_NPM_CHECK_LINES: String(npmCheckLines),
        MOCK_NPM_CHECK_EXIT: String(npmCheckExit),
        MOCK_GH_COMMENT_BODY_FILE: commentBodyFile,
        MOCK_GH_COMMENT_EXIT: String(ghCommentExit),
      },
    },
  );

  expect(result.status, result.stderr).toBe(0);

  let commentBody: string | null = null;
  try {
    commentBody = readFileSync(commentBodyFile, "utf8");
  } catch {
    // file not written — no comment was posted
  }

  return { output: result.stdout, commentBody };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pre-commit-checks backstop", () => {
  it("skips when diff does not touch .github/", () => {
    const { output, commentBody } = runChecks({
      diffFiles: "README.md\ndocs/design/foo.md",
    });
    expect(output).toContain("pre-commit-checks: diff does not touch .github/, skipping");
    expect(commentBody).toBeNull();
  });

  it("skips when diff is empty", () => {
    const { output, commentBody } = runChecks({
      diffFiles: "",
    });
    expect(output).toContain("pre-commit-checks: diff does not touch .github/, skipping");
    expect(commentBody).toBeNull();
  });

  it("runs checks and logs passed when checks succeed", () => {
    const { output, commentBody } = runChecks({
      npmCheckExit: 0,
    });
    expect(output).toContain(
      "pre-commit-checks: running npm ci && npm run typecheck && npm test in .github/scripts",
    );
    expect(output).toContain("pre-commit-checks: passed");
    expect(commentBody).toBeNull();
  });

  it("posts PR comment with expected header and output when checks fail", () => {
    const { output, commentBody } = runChecks({
      npmCheckExit: 1,
    });
    expect(output).toContain("pre-commit-checks: failed — posting PR comment to PR #42");
    expect(commentBody).not.toBeNull();
    expect(commentBody).toContain("### Developer agent pre-commit checks failed");
    // The head SHA should appear in the prose line
    expect(commentBody).toContain("head-sha-abc");
    // Output must be fenced
    expect(commentBody).toContain("```");
    // The check output itself should appear inside the fence
    expect(commentBody).toContain("output line 1");
    expect(commentBody).toContain("output line 5");
    // No truncation marker for a small output
    expect(commentBody).not.toContain("truncated");
  });

  it("posts PR comment noting the branch was pushed anyway", () => {
    const { commentBody } = runChecks({ npmCheckExit: 1 });
    expect(commentBody).toContain("The branch was pushed anyway");
  });

  it("logs warning and skips PR comment when npm ci fails (backstop error)", () => {
    const { output, commentBody } = runChecks({
      npmCiExit: 1,
    });
    expect(output).toContain(
      "pre-commit-checks: encountered error running checks (npm ci failed); skipping PR comment",
    );
    expect(commentBody).toBeNull();
  });

  it("logs warning and returns 0 when gh pr comment fails", () => {
    const { output, commentBody } = runChecks({
      npmCheckExit: 1,
      ghCommentExit: 1,
    });
    expect(output).toContain("pre-commit-checks: failed to post PR comment");
    expect(output).toContain("push proceeding");
    // No comment was successfully written
    expect(commentBody).toBeNull();
  });

  it("truncates output exceeding 200 lines and adds the truncation marker", () => {
    // 250 lines of output: npm run typecheck exits 1 after printing all 250 lines.
    // npm test never runs (&&-short-circuit). Total captured output = 250 lines.
    // tail -n 200 retains lines 51-250; lines 1-50 are dropped.
    const { commentBody } = runChecks({
      npmCheckLines: 250,
      npmCheckExit: 1,
    });
    expect(commentBody).not.toBeNull();
    expect(commentBody).toContain("(…truncated — full output in container logs…)");
    // Lines beyond the 200-line window must be absent
    expect(commentBody).not.toContain("output line 50\n");
    // Lines within the retained window must be present
    expect(commentBody).toContain("output line 51\n");
    expect(commentBody).toContain("output line 250");
  });

  it("does not add truncation marker when output is exactly 200 lines", () => {
    const { commentBody } = runChecks({
      npmCheckLines: 200,
      npmCheckExit: 1,
    });
    expect(commentBody).not.toBeNull();
    expect(commentBody).not.toContain("truncated");
    expect(commentBody).toContain("output line 1\n");
    expect(commentBody).toContain("output line 200");
  });

  it("matches on .github/ paths among a mixed diff", () => {
    // Some files touch .github/, others do not — checks must still run.
    const { output, commentBody } = runChecks({
      diffFiles: "README.md\n.github/workflows/ci.yml\ndocs/foo.md",
      npmCheckExit: 0,
    });
    expect(output).toContain("pre-commit-checks: passed");
    expect(commentBody).toBeNull();
  });

  it("includes the pr-number in the failed log line", () => {
    const { output } = runChecks({
      prNumber: "123",
      npmCheckExit: 1,
    });
    expect(output).toContain("posting PR comment to PR #123");
  });
});
