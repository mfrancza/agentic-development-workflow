import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../", import.meta.url);
const helperPath = new URL("docker/scripts/expand_team_refs.sh", repoRoot).pathname;
const entrypoint = readFileSync(
  new URL("docker/scripts/entrypoint.sh", repoRoot),
  "utf8",
);
const caller = readFileSync(
  new URL(".github/workflows/agent-groom.yml", repoRoot),
  "utf8",
);
const reusable = readFileSync(
  new URL(".github/workflows/agent-groom-reusable.yml", repoRoot),
  "utf8",
);
const runAgent = readFileSync(
  new URL(".github/actions/run-agent/action.yml", repoRoot),
  "utf8",
);

function runExpansion(adminAssignees: string, resolverToken = "resolver-token") {
  const dir = mkdtempSync(join(tmpdir(), "expand-team-refs-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/bin/bash\necho "gh $*" >&2\nprintf '%s\\n' Member1 ALICE member2\n`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", ["-c", `
    set -euo pipefail
    log() { echo "$*" >&2; }
    source "$1"
    expand_admin_assignees
    printf '%s' "$ADMIN_ASSIGNEES"
  `, "--", helperPath], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_REPO: "test-org/test-repo",
      ADMIN_ASSIGNEES: adminAssignees,
      ALLOWLIST_RESOLVER_TOKEN: resolverToken,
    },
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

describe("groom ADMIN_ASSIGNEES team expansion", () => {
  it("expands same-org teams without GITHUB_REPOSITORY_OWNER and de-duplicates case-insensitively", () => {
    const result = runExpansion('["alice","test-org/test-team"]');

    expect(result.stdout).toBe('["alice","Member1","member2"]');
    expect(result.stderr).toContain("gh api orgs/test-org/teams/test-team/members");
    expect(result.stderr).not.toContain("GITHUB_REPOSITORY_OWNER");
  });

  it("warns and skips cross-org teams without calling gh", () => {
    const result = runExpansion('["alice","other-org/some-team"]');

    expect(result.stdout).toBe('["alice"]');
    expect(result.stderr).toContain("cross-org team reference 'other-org/some-team' rejected: supported org is 'test-org', got 'other-org'");
    expect(result.stderr).not.toContain("gh api");
  });

  it("warns and skips team references when the resolver credential is unavailable", () => {
    const result = runExpansion('["bob","test-org/test-team"]', "");

    expect(result.stdout).toBe('["bob"]');
    expect(result.stderr).toContain("resolver credential unavailable — skipping team entry 'test-org/test-team'");
    expect(result.stderr).not.toContain("gh api");
  });
});

describe("groom resolver token forwarding contract", () => {
  it("carries the resolver App credential across all four boundaries", () => {
    expect(caller).toContain("ALLOWLIST_RESOLVER_APP_ID: ${{ secrets.ALLOWLIST_RESOLVER_APP_ID }}");
    expect(caller).toContain("ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: ${{ secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY }}");
    expect(reusable).toContain("ALLOWLIST_RESOLVER_APP_ID: { required: false }");
    expect(reusable).toContain("ALLOWLIST_RESOLVER_APP_PRIVATE_KEY: { required: false }");
    expect(reusable).toContain("id: assignee-resolver");
    expect(reusable).toContain("if: steps.detect-team-refs.outputs.assignees_needs_resolver == 'true'");
    expect(reusable).toContain("continue-on-error: true");
    expect(reusable).toContain("ALLOWLIST_RESOLVER_TOKEN: ${{ steps.assignee-resolver.outputs.token }}");
    expect(runAgent).toContain('[[ -n "${ALLOWLIST_RESOLVER_TOKEN:-}" ]] && _opt_env+=(-e ALLOWLIST_RESOLVER_TOKEN)');
    expect(entrypoint).toContain("expand_admin_assignees");
  });

  it("redacts the resolver token from harvested container logs", () => {
    const functionMatch = entrypoint.match(/_log_capture_exit\(\) \{[\s\S]*?\n\}\n# Save the exit code/);
    expect(functionMatch).not.toBeNull();
    const logPath = "/home/agent/logs/resolver-redaction-vitest.log";
    mkdirSync("/home/agent/logs", { recursive: true });
    writeFileSync(logPath, "token=resolver[secret]/value\n");
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      log() { :; }
      eval "$LOG_CAPTURE_FUNCTION"
      exec 3>&2
      _log_capture_exit
    `], {
      env: {
        ...process.env,
        ALLOWLIST_RESOLVER_TOKEN: "resolver[secret]/value",
        LOG_CAPTURE_FUNCTION: functionMatch![0].replace("\n# Save the exit code", ""),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(logPath, "utf8")).toContain("***REDACTED-ALLOWLIST_RESOLVER_TOKEN***");
    rmSync(logPath, { force: true });
  });
});
