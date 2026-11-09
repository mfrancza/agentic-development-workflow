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
  /** Path to a file whose contents the mock git prints for `diff --name-only`.
   *  Takes precedence over diffFiles when set.  Use this for large diffs that
   *  would exceed the ARG_MAX / E2BIG limit for environment variables. */
  diffFilePath?: string;
  /** Exit code for `git diff --name-only`.  Defaults to 0 (success). */
  gitDiffExit?: number;
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
  /** Value of GITHUB_RUN_ID injected into the environment.
   *  Omit to leave GITHUB_RUN_ID unset (simulates a local run). */
  githubRunId?: string;
  /** Value of PRE_COMMIT_SCRIPTS_DIR injected into the environment.
   *  Omit to leave unset (helper defaults to ".github/scripts").
   *  Set to empty string "" to disable npm checks. */
  preCommitScriptsDir?: string;
  /** Value of PRE_COMMIT_CHECK_CMD injected into the environment.
   *  Omit to use the test-helper default ("npm run typecheck && npm test").
   *  Pass `undefined` explicitly (i.e. include the key) to leave the variable
   *  unset in the child env, which triggers the helper's skip-if-no-command
   *  behaviour. */
  preCommitCheckCmd?: string;
  /** Exit code for `mktemp`. Defaults to 0 (success).  Set to non-zero to
   *  simulate a full or unavailable temp filesystem. */
  mktempExit?: number;
}

function runChecks(options: RunOptions = {}) {
  const bin = mkdtempSync(join(tmpdir(), "pre-commit-checks-bin-"));
  tempDirs.push(bin);

  const workDir = mkdtempSync(join(tmpdir(), "pre-commit-checks-work-"));
  tempDirs.push(workDir);

  // Create the scripts directory that the helper cd's into for npm.
  // When PRE_COMMIT_SCRIPTS_DIR is explicitly empty, no directory is created
  // (npm checks are disabled in that case).
  const scriptsRelDir =
    options.preCommitScriptsDir !== undefined
      ? options.preCommitScriptsDir
      : ".github/scripts";
  if (scriptsRelDir) {
    mkdirSync(join(workDir, scriptsRelDir), { recursive: true });
  }

  // File where the mock gh writes the captured --body argument.
  const commentBodyFile = join(bin, "comment-body.txt");

  const diffFiles = options.diffFiles ?? ".github/scripts/foo.ts";
  const gitDiffExit = options.gitDiffExit ?? 0;
  const headSha = options.headSha ?? "head-sha-abc";
  const npmCiExit = options.npmCiExit ?? 0;
  const npmCheckLines = options.npmCheckLines ?? 5;
  const npmCheckExit = options.npmCheckExit ?? 0;
  const ghCommentExit = options.ghCommentExit ?? 0;

  // --- Mock git ---
  // Handles: diff --name-only <before>..HEAD  →  prints MOCK_DIFF_FILE (if
  //                                              set) or MOCK_DIFF_FILES, or
  //                                              exits MOCK_GIT_DIFF_EXIT when
  //                                              non-zero
  //          rev-parse HEAD                   →  prints MOCK_HEAD_SHA
  writeFileSync(
    join(bin, "git"),
    `#!/bin/bash
case "$1" in
  diff)
    if [[ "\${MOCK_GIT_DIFF_EXIT:-0}" -ne 0 ]]; then
      echo "fatal: bad object: not-a-sha" >&2
      exit "\${MOCK_GIT_DIFF_EXIT}"
    fi
    if [[ -n "\${MOCK_DIFF_FILE:-}" ]]; then
      cat "\${MOCK_DIFF_FILE}"
    else
      printf '%s' "\${MOCK_DIFF_FILES:-}"
    fi
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

  // --- Mock mktemp ---
  // Fails with MOCK_MKTEMP_EXIT when non-zero (simulating a full/unavailable
  // temp filesystem); otherwise delegates to the real binary so the helper
  // can create its capture file normally.
  writeFileSync(
    join(bin, "mktemp"),
    `#!/bin/bash
if [[ "\${MOCK_MKTEMP_EXIT:-0}" -ne 0 ]]; then
    echo "mktemp: failed to create temp file: No space left on device" >&2
    exit "\${MOCK_MKTEMP_EXIT}"
fi
exec /usr/bin/mktemp "$@"
`,
  );

  for (const cmd of ["git", "npm", "gh", "mktemp"]) {
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
        MOCK_DIFF_FILE: options.diffFilePath ?? "",
        MOCK_GIT_DIFF_EXIT: String(gitDiffExit),
        MOCK_HEAD_SHA: headSha,
        MOCK_NPM_CI_EXIT: String(npmCiExit),
        MOCK_NPM_CHECK_LINES: String(npmCheckLines),
        MOCK_NPM_CHECK_EXIT: String(npmCheckExit),
        MOCK_GH_COMMENT_BODY_FILE: commentBodyFile,
        MOCK_GH_COMMENT_EXIT: String(ghCommentExit),
        MOCK_MKTEMP_EXIT: String(options.mktempExit ?? 0),
        // GITHUB_RUN_ID: set to the provided value, or explicitly undefined
        // (which Node strips from the child env) so the variable is absent
        // even when the outer CI environment has it set.
        GITHUB_RUN_ID: options.githubRunId,
        // PRE_COMMIT_SCRIPTS_DIR: undefined strips the variable so the helper
        // uses its built-in default (".github/scripts"); "" disables checks.
        PRE_COMMIT_SCRIPTS_DIR: options.preCommitScriptsDir,
        // PRE_COMMIT_CHECK_CMD: the helper has NO built-in default — an unset
        // variable causes it to skip npm checks.  When the caller does not
        // include "preCommitCheckCmd" in the options object at all, supply the
        // repo-conventional command so that tests which exercise npm behaviour
        // continue to work without each test having to specify it explicitly.
        // Pass `preCommitCheckCmd: undefined` (key present, value undefined)
        // to explicitly leave the variable out of the child env and test the
        // skip-if-no-command path.
        PRE_COMMIT_CHECK_CMD:
          "preCommitCheckCmd" in options
            ? options.preCommitCheckCmd
            : "npm run typecheck && npm test",
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
    // Default check command and scripts dir appear in the log line
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

  it("logs warning and returns 0 when git diff fails (backstop fail-open)", () => {
    // A malformed or unavailable head-before SHA causes git diff to exit
    // non-zero.  The backstop must catch this, log a warning, and return 0
    // so the caller's push is not aborted (runChecks asserts status === 0).
    const { output, commentBody } = runChecks({
      gitDiffExit: 128,
    });
    expect(output).toContain("pre-commit-checks: git diff failed");
    expect(output).toContain("skipping checks (fail-open)");
    // No comment should be posted when the diff itself could not be computed.
    expect(commentBody).toBeNull();
  });

  it("includes GITHUB_RUN_ID in failure comment when available", () => {
    const { commentBody } = runChecks({
      npmCheckExit: 1,
      githubRunId: "9876543210",
    });
    expect(commentBody).not.toBeNull();
    // Run ID must appear so the comment can be correlated to the agent run
    // (Decision 7: "references the container run via GITHUB_RUN_ID-style
    // identifier if available").
    expect(commentBody).toContain("9876543210");
    expect(commentBody).toContain("Agent run:");
  });

  it("omits Agent run line when GITHUB_RUN_ID is not set", () => {
    // When running outside GitHub Actions (or when the env var is absent),
    // the comment must still be valid but must not contain a stale/empty ID.
    const { commentBody } = runChecks({
      npmCheckExit: 1,
      // githubRunId intentionally omitted
    });
    expect(commentBody).not.toBeNull();
    expect(commentBody).not.toContain("Agent run:");
  });

  it("emits full output to container logs when output is truncated", () => {
    // 250 lines of output: only the last 200 go into the PR comment, but
    // ALL 250 must appear in the container log (stdout) so the truncation
    // marker's promise ("full output in container logs") is true.
    const { output, commentBody } = runChecks({
      npmCheckLines: 250,
      npmCheckExit: 1,
    });
    // PR comment is still capped at 200 lines
    expect(commentBody).not.toBeNull();
    expect(commentBody).toContain("(…truncated — full output in container logs…)");
    expect(commentBody).not.toContain("output line 50\n");
    // But the full 250-line output must be present in the container log
    expect(output).toContain("output line 1\n");
    expect(output).toContain("output line 50\n");
    expect(output).toContain("output line 250");
  });

  it("skips npm checks when PRE_COMMIT_SCRIPTS_DIR is explicitly empty", () => {
    // An operator can disable npm checks for a repo that uses a different
    // check mechanism by setting PRE_COMMIT_SCRIPTS_DIR to "".
    const { output, commentBody } = runChecks({
      preCommitScriptsDir: "",
      diffFiles: ".github/foo.ts",
    });
    expect(output).toContain(
      "pre-commit-checks: PRE_COMMIT_SCRIPTS_DIR is empty; skipping npm checks",
    );
    expect(commentBody).toBeNull();
  });

  it("skips npm checks when PRE_COMMIT_CHECK_CMD is not set", () => {
    // The helper has no built-in default for PRE_COMMIT_CHECK_CMD so that
    // repo-specific commands are not baked into the Docker image.  When the
    // variable is absent the checks must be silently skipped.
    const { output, commentBody } = runChecks({
      // Pass the key with value undefined so "preCommitCheckCmd" in options
      // is true — the test-helper then leaves PRE_COMMIT_CHECK_CMD out of
      // the child env, simulating a deployment that has not set the variable.
      preCommitCheckCmd: undefined,
      diffFiles: ".github/foo.ts",
    });
    expect(output).toContain(
      "pre-commit-checks: PRE_COMMIT_CHECK_CMD is not set; skipping npm checks",
    );
    expect(commentBody).toBeNull();
  });

  it("runs checks in a custom scripts directory", () => {
    // PRE_COMMIT_SCRIPTS_DIR can point at a repo-specific package location.
    const { output, commentBody } = runChecks({
      preCommitScriptsDir: "tools/scripts",
      npmCheckExit: 0,
    });
    expect(output).toContain("in tools/scripts");
    expect(output).toContain("pre-commit-checks: passed");
    expect(commentBody).toBeNull();
  });

  it("uses a custom check command and includes it in the log and PR comment", () => {
    // PRE_COMMIT_CHECK_CMD allows repos to substitute their own test runner.
    const { output, commentBody } = runChecks({
      preCommitCheckCmd: "npm run lint",
      npmCheckExit: 1,
    });
    // Log line must reference the custom command
    expect(output).toContain("npm run lint");
    // PR comment must surface the custom command so the developer knows what failed
    expect(commentBody).not.toBeNull();
    expect(commentBody).toContain("npm run lint");
  });

  it("logs warning and returns 0 when mktemp fails (backstop fail-open)", () => {
    // A full or unavailable temp filesystem causes mktemp to exit non-zero.
    // The backstop must catch this, log a warning, and return 0 so that the
    // caller's git push is not aborted (runChecks asserts status === 0).
    const { output, commentBody } = runChecks({
      mktempExit: 1,
    });
    expect(output).toContain("pre-commit-checks: mktemp failed");
    expect(output).toContain("skipping checks (fail-open)");
    // No comment should be posted when the temp file could not be created.
    expect(commentBody).toBeNull();
  });

  it("matches .github/ path when diff list exceeds the pipe buffer size", () => {
    // Regression for SIGPIPE: if `printf ... | grep -q` were used, grep exits
    // as soon as it finds the first match and closes its stdin; for a large
    // enough path list printf receives SIGPIPE (exit 141).  With `pipefail`
    // the pipeline exits 141, and `if ! [141]` is true, causing the checks to
    // be incorrectly skipped.  Using a here-string (<<<) avoids the pipeline
    // entirely.
    //
    // We write the diff to a file (via diffFilePath) rather than passing it
    // through MOCK_DIFF_FILES, because the ~84 KiB env-var value exceeds the
    // kernel's ARG_MAX for child processes (spawnSync returns E2BIG).
    // .github/scripts/foo.ts appears first so grep exits immediately on the
    // match; with the old pipe, printf would then receive SIGPIPE as it tried
    // to flush the remaining ~84 KiB.
    const extraPaths = Array.from({ length: 5000 }, (_, i) => `src/file-${i}.ts`).join("\n");
    const diffContent = `.github/scripts/foo.ts\n${extraPaths}`;
    const largeDiffDir = mkdtempSync(join(tmpdir(), "pre-commit-checks-large-diff-"));
    tempDirs.push(largeDiffDir);
    const diffFilePath = join(largeDiffDir, "diff.txt");
    writeFileSync(diffFilePath, diffContent);

    const { output, commentBody } = runChecks({
      diffFilePath,
      npmCheckExit: 0,
    });
    // Checks must have run (not skipped) even though the path list is huge.
    expect(output).toContain("pre-commit-checks: passed");
    expect(commentBody).toBeNull();
  });
});
