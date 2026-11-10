import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const entrypoint = readFileSync(new URL("../../../docker/scripts/entrypoint.sh", import.meta.url), "utf8");
const action = entrypoint.match(/^action_fix_checks\(\) \{\n[\s\S]*?^\}/m)?.[0];
const guard = new URL("../../../docker/scripts/lib/model-push-guard.sh", import.meta.url).pathname;
const checks = new URL("../../../docker/scripts/lib/pre-commit-checks.sh", import.meta.url).pathname;
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
let root: string, remote: string, agent: string, writer: string, baseline: string;
let env: NodeJS.ProcessEnv;
const ref = "refs/heads/feature";

function git(dir: string, ...args: string[]) {
  return execFileSync(realGit, ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(dir: string, name: string) {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github", name), name);
  git(dir, "add", ".github");
  git(dir, "commit", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}
function run(model: string, options: { check?: string; setupFailure?: boolean; restoreFailure?: boolean } = {}) {
  const events = join(root, "events");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
    log() { printf '%s\n' "$*"; }
    source "$GUARD"
    source "$CHECKS"
    setup_repo() { cd "$WORK_DIR"; }
    fix_checks_should_run() { return 0; }
    gh() { printf 'gh %s\n' "$*" >> "$EVENTS"; }
    run_agent() { printf 'model\n' >> "$EVENTS"; printf '%s\n' "$*" > "$PROMPT"; eval "$MODEL"; }
    inject_authored_by_marker() { printf 'marker\n' >> "$EVENTS"; }
    eval "$ACTION"
    action_fix_checks
  `], { cwd: agent, encoding: "utf8", env: {
    ...env, ACTION: action, GUARD: guard, CHECKS: checks, WORK_DIR: agent, WRITER: writer,
    REMOTE: remote, BASELINE: baseline, EVENTS: events, PROMPT: join(root, "prompt"), MODEL: model,
    GITHUB_PR_NUMBER: "123", GITHUB_REPO: "example/repo", GH_TOKEN: "test",
    PRE_COMMIT_SCRIPTS_DIR: ".", PRE_COMMIT_CHECK_CMD: options.check ?? 'printf "check\\n" >> "$EVENTS"; test "$(git --git-dir="$REMOTE" rev-parse refs/heads/feature)" = "$BASELINE"',
    PATH: `${join(root, "bin")}:${env.PATH}`, REAL_GIT: realGit, PUSH_CALLS: join(root, "push-calls"),
    FAIL_RESTORE: options.restoreFailure ? "1" : "0",
    ...(options.setupFailure ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: join(root, "override") } : {}),
  } });
  return { ...result, events: existsSync(events) ? readFileSync(events, "utf8") : "" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fix-checks-push-"));
  remote = join(root, "remote.git"); agent = join(root, "agent"); writer = join(root, "writer");
  env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "git"), `#!/bin/bash
if [[ "$1" == push ]]; then printf '%s\n' "$*" >> "$PUSH_CALLS"; fi
if [[ "$1" == -C && "$2" == "$WORK_DIR" && "$3" == push ]]; then printf '%s\n' "$*" >> "$PUSH_CALLS"; fi
if [[ "${"$"}{FAIL_RESTORE:-0}" == 1 && "$*" == *'config --local --unset-all core.hooksPath'* ]]; then exit 1; fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(join(root, "bin", "git"), 0o755);
  git(root, "init", "--bare", remote); git(root, "clone", remote, agent); git(agent, "checkout", "-b", "feature");
  baseline = commit(agent, "baseline"); git(agent, "push", "origin", `HEAD:${ref}`); git(root, "clone", "--branch", "feature", remote, writer);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("fix-checks guarded publication", () => {
  const localCommit = 'printf local > .github/local; git add .github; git commit -m local';
  it("commits locally, runs the backstop, then pushes once and injects the marker", () => {
    const result = run(`${localCommit}; test "$(git --git-dir="$REMOTE" rev-parse refs/heads/feature)" = "$BASELINE"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.events).toMatch(/model\ncheck\nmarker\n/);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe("push origin feature\n");
    expect(git(remote, "rev-parse", ref)).toBe(git(agent, "rev-parse", "HEAD"));
    expect(readFileSync(join(root, "prompt"), "utf8")).toContain("Do not push");
  });
  it("rejects a model push, restores the original hook, then publishes", () => {
    const hooks = join(root, "hooks"); mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), '#!/bin/sh\necho original >> "$EVENTS"\n'); chmodSync(join(hooks, "pre-push"), 0o755);
    git(agent, "config", "core.hooksPath", hooks);
    const result = run(`${localCommit}; if git -C "$WORK_DIR" push origin feature; then return 1; fi; test "$(git --git-dir="$REMOTE" rev-parse refs/heads/feature)" = "$BASELINE"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Do not git push in this model session");
    expect(result.events).toMatch(/model\ncheck\noriginal\nmarker\n/);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe(`-C ${agent} push origin feature\npush origin feature\n`);
    expect(git(agent, "config", "core.hooksPath")).toBe(hooks);
    expect(git(remote, "rev-parse", ref)).toBe(git(agent, "rev-parse", "HEAD"));
  });
  it("succeeds with a native no-op push", () => {
    const result = run(":");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe("push origin feature\n");
    expect(result.events).toContain("marker\n");
    expect(git(remote, "rev-parse", ref)).toBe(baseline);
  });
  it("accepts equality when another writer publishes the same commit", () => {
    const result = run(`${localCommit}; git -C "$WRITER" fetch "$WORK_DIR" HEAD; git -C "$WRITER" push origin FETCH_HEAD:${ref}`, { check: 'printf "check\\n" >> "$EVENTS"' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.events).toMatch(/model\ncheck\nmarker\n/);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe("push origin feature\n");
    expect(git(remote, "rev-parse", ref)).toBe(git(agent, "rev-parse", "HEAD"));
  });
  it.each(["setup", "model", "restore"])("prevents publication on %s failure", (failure) => {
    const result = run(failure === "model" ? "return 7" : ":", { setupFailure: failure === "setup", restoreFailure: failure === "restore" });
    expect(result.status).not.toBe(0);
    expect(result.events).not.toMatch(/check\n|marker\n/);
    expect(existsSync(join(root, "push-calls"))).toBe(false);
    expect(git(remote, "rev-parse", ref)).toBe(baseline);
  });
  it("does not overwrite a competing writer or inject a marker", () => {
    const concurrent = commit(writer, "concurrent");
    const result = run(`${localCommit}; git -C "$WRITER" push origin HEAD:${ref}`, { check: 'printf "check\\n" >> "$EVENTS"' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[rejected]");
    expect(git(remote, "rev-parse", ref)).toBe(concurrent);
    expect(result.events).not.toContain("marker\n");
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe("push origin feature\n");
  });
  it("guards only the two intended action call sites", () => {
    const calls = [...entrypoint.matchAll(/^\s+run_agent_without_push\s+"([^"]+)"/gm)].map(m => m[1]);
    expect(calls).toEqual(["respond-to-checks.md", "respond-to-review.md"]);
    for (const prompt of ["implement.md", "design.md", "groom.md", "fix-deployment.md", "resolve-conflicts.md"]) {
      expect(entrypoint).toContain(`run_agent "${prompt}"`);
    }
  });
});
