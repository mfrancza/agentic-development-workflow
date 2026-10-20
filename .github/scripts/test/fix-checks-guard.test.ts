import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = new URL("../../../", import.meta.url);
const guard = new URL("docker/scripts/lib/fix-checks-guard.sh", repoRoot).pathname;
const tempDirs: string[] = [];

type Check = { name: string; status: string; conclusion: string | null };

function runGuard(options: {
  checks: Check[][];
  allow?: string;
  head?: string;
  trigger?: string;
  labels?: string[];
  waitSeconds?: string;
}) {
  const bin = mkdtempSync(join(tmpdir(), "fix-checks-guard-"));
  tempDirs.push(bin);
  const state = join(bin, "state");
  const sleeps = join(bin, "sleeps");
  writeFileSync(state, "0");

  const mockGh = `#!/bin/bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  ${(options.labels ?? []).map((label) => `printf '%s\\n' ${JSON.stringify(label)};`).join("\n  ")}
  exit 0
fi
if [[ "$1" == "api" ]]; then
  index=$(<"$MOCK_STATE")
  jq -c --argjson index "$index" '(.[$index] // .[-1])[]' <<< "$MOCK_CHECKS"
  printf '%s' $((index + 1)) > "$MOCK_STATE"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`;
  writeFileSync(join(bin, "gh"), mockGh);
  writeFileSync(join(bin, "git"), "#!/bin/bash\nprintf '%s\\n' \"${MOCK_HEAD}\"\n");
  writeFileSync(join(bin, "sleep"), "#!/bin/bash\nprintf 'sleep %s\\n' \"$1\" >> \"$MOCK_SLEEPS\"\n");
  for (const command of ["gh", "git", "sleep"]) chmodSync(join(bin, command), 0o755);

  const result = spawnSync("bash", ["-c", `
    set -euo pipefail
    log() { echo "[agent] $*"; }
    source "$FIX_CHECKS_GUARD"
    if fix_checks_should_run; then echo RESULT=run; else echo RESULT=skip; fi
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FIX_CHECKS_GUARD: guard,
      MOCK_STATE: state,
      MOCK_SLEEPS: sleeps,
      MOCK_CHECKS: JSON.stringify(options.checks),
      MOCK_HEAD: options.head ?? "head-now",
      GITHUB_REPO: "acme/widgets",
      GITHUB_PR_NUMBER: "42",
      FIX_CHECKS_ALLOW: options.allow ?? '["Lint"]',
      GITHUB_HEAD_SHA_AT_TRIGGER: options.trigger ?? "head-now",
      ...(options.waitSeconds === undefined ? {} : { FIX_CHECKS_WAIT_SECONDS: options.waitSeconds }),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return { output: result.stdout };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const failed: Check = { name: "Lint", status: "completed", conclusion: "failure" };
const succeeded: Check = { name: "Lint", status: "completed", conclusion: "success" };
const pending: Check = { name: "Lint", status: "in_progress", conclusion: null };

describe("fix-checks freshness guard", () => {
  it("skips when no allowed failure remains", () => {
    const { output } = runGuard({ checks: [[succeeded]] });
    expect(output).toContain("RESULT=skip");
  });

  it("runs only for allowed actionable failures", () => {
    expect(runGuard({ checks: [[failed]] }).output).toContain("RESULT=run");
    expect(runGuard({ checks: [[{ ...failed, name: "Other" }]] }).output).toContain("RESULT=skip");
  });

  it("fails closed for an empty policy", () => {
    const { output } = runGuard({ checks: [[failed]], allow: "[]" });
    expect(output).toContain("FIX_CHECKS_ALLOW is missing, malformed, or empty");
    expect(output).toContain("RESULT=skip");
  });

  it("does not wait for unrelated pending checks when HEAD is unchanged", () => {
    const { output } = runGuard({ checks: [[failed, pending]] });
    expect(output).toContain("RESULT=run");
    expect(output).toContain("allowed pending checks do not block");
  });

  it("waits for stale replacement checks and skips when they succeed", () => {
    const { output } = runGuard({
      checks: [[pending], [succeeded]],
      head: "new-head",
      trigger: "old-head",
    });
    expect(output).toContain("waiting up to 900s");
    expect(output).toContain("RESULT=skip");
  });

  it("stops waiting at the configured timeout", () => {
    const { output } = runGuard({
      checks: [[pending]],
      head: "new-head",
      trigger: "old-head",
      waitSeconds: "0",
    });
    expect(output).toContain("Timed out waiting");
    expect(output).toContain("RESULT=skip");
  });

  it("skips a stale HEAD with no allowed pending or failure", () => {
    const { output } = runGuard({
      checks: [[succeeded]],
      head: "new-head",
      trigger: "old-head",
    });
    expect(output).toContain("HEAD changed since trigger and no allowed checks remain");
    expect(output).toContain("RESULT=skip");
  });

  it("skips a PR escalated to human-required before reading checks", () => {
    const { output } = runGuard({ checks: [[failed]], labels: ["human-required"] });
    expect(output).toContain("human-required");
    expect(output).toContain("RESULT=skip");
  });

  it("detects human-required among multiple PR labels", () => {
    const { output } = runGuard({
      checks: [[failed]],
      labels: ["some-other-label", "human-required"],
    });
    expect(output).toContain("human-required");
    expect(output).toContain("RESULT=skip");
  });
});
