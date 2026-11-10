import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const entrypoint = readFileSync(new URL("../../../docker/scripts/entrypoint.sh", import.meta.url), "utf8");
const runners = ["run_anthropic", "run_openai", "run_xai", "run_agent"].map(name => entrypoint.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))?.[0]).join("\n");
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
function run(model: string, options: { check?: string; setupFailure?: boolean; restoreFailure?: boolean; cleanupFailure?: boolean; provider?: string } = {}) {
  const events = join(root, "events");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
    log() { printf '%s\n' "$*"; }
    source "$GUARD"
    source "$CHECKS"
    setup_repo() { cd "$WORK_DIR"; }
    fix_checks_should_run() { return 0; }
    gh() { printf 'gh %s\n' "$*" >> "$EVENTS"; }
    if [[ -n "$AGENT_PROVIDER" ]]; then eval "$RUNNERS"; else
      run_agent() { printf 'model\n' >> "$EVENTS"; printf '%s\n' "$*" > "$PROMPT"; eval "$MODEL"; }
    fi
    inject_authored_by_marker() { printf 'marker\n' >> "$EVENTS"; }
    eval "$ACTION"
    action_fix_checks
  `], { cwd: agent, encoding: "utf8", env: {
    ...env, ACTION: action, RUNNERS: runners, AGENT_PROVIDER: options.provider ?? "", AGENT_MODEL: "test-model", AGENT_MAX_TURNS: "7", SCRIPTS_DIR: new URL("../../../docker/scripts", import.meta.url).pathname, GUARD: guard, CHECKS: checks, WORK_DIR: agent, WRITER: writer,
    REMOTE: remote, BASELINE: baseline, EVENTS: events, PROMPT: join(root, "prompt"), MODEL: model,
    GITHUB_PR_NUMBER: "123", GITHUB_REPO: "example/repo", GH_TOKEN: "test",
    PRE_COMMIT_SCRIPTS_DIR: ".", PRE_COMMIT_CHECK_CMD: options.check ?? 'printf "check\\n" >> "$EVENTS"; test "$(git --git-dir="$REMOTE" rev-parse refs/heads/feature)" = "$BASELINE"',
    PATH: `${join(root, "bin")}:${env.PATH}`, REAL_GIT: realGit, PUSH_CALLS: join(root, "push-calls"),
    FAIL_RESTORE: options.restoreFailure ? "1" : "0", FAIL_CLEANUP: options.cleanupFailure ? "1" : "0",
    ...(options.setupFailure ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: join(root, "override") } : {}),
  } });
  if (process.env.PUBLICATION_EVIDENCE) {
    const read = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim().replaceAll("\n", " | ") : "none";
    console.log(`EVIDENCE fix-checks model=${model} status=${result.status} original=${baseline} local=${git(agent, "rev-parse", "HEAD")} writer=${git(writer, "rev-parse", "HEAD")} final=${git(remote, "rev-parse", ref)} attempts=${read("push-calls")} receives=${read("receives")} events=${read("events")} stderr=${result.stderr.trim().replaceAll("\n", " | ")}`);
  }
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
  writeFileSync(join(root, "bin", "rm"), `#!/bin/bash
if [[ "${"$"}{FAIL_CLEANUP:-0}" == 1 && "$*" == *model-push-guard.* ]]; then exit 1; fi
exec /bin/rm "$@"
`);
  chmodSync(join(root, "bin", "rm"), 0o755);
  for (const cli of ["claude", "codex", "grok"]) {
    writeFileSync(join(root, "bin", cli), `#!/bin/bash
printf '%s\\n' "$0 $*" >> "$EVENTS"
printf 'stub-output\\n'
env -i PATH="$PATH" HOME="$HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null REAL_GIT="$REAL_GIT" PUSH_CALLS="$PUSH_CALLS" WORK_DIR="$WORK_DIR" GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com bash -c "$MODEL"
`);
    chmodSync(join(root, "bin", cli), 0o755);
  }
  git(root, "init", "--bare", remote); git(root, "clone", remote, agent); git(agent, "checkout", "-b", "feature");
  baseline = commit(agent, "baseline"); git(agent, "push", "origin", `HEAD:${ref}`); git(root, "clone", "--branch", "feature", remote, writer);
  writeFileSync(join(remote, "hooks", "post-receive"), `#!/bin/sh
cat >> "${join(root, "receives")}"
printf 'receive\\n' >> "${join(root, "events")}"
`);
  chmodSync(join(remote, "hooks", "post-receive"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("fix-checks guarded publication", () => {
  const localCommit = 'printf local > .github/local; git add .github; git commit -m local';
  it("commits locally, runs the backstop, then pushes once and injects the marker", () => {
    const result = run(`${localCommit}; test "$(git --git-dir="$REMOTE" rev-parse refs/heads/feature)" = "$BASELINE"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.events).toMatch(/model\ncheck\nreceive\nmarker\n/);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe("push origin feature\n");
    expect(git(remote, "rev-parse", ref)).toBe(git(agent, "rev-parse", "HEAD"));
    expect(readFileSync(join(root, "receives"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(root, "prompt"), "utf8")).toContain("Do not push");
  });
  it("rejects a model push, restores the original hook, then publishes", () => {
    const hooks = join(root, "hooks"); mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), '#!/bin/sh\necho original >> "$EVENTS"\n'); chmodSync(join(hooks, "pre-push"), 0o755);
    git(agent, "config", "core.hooksPath", hooks);
    const result = run(`${localCommit}; if git -C "$WORK_DIR" push origin feature; then return 1; fi; test "$(git --git-dir="$REMOTE" rev-parse refs/heads/feature)" = "$BASELINE"`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Do not git push in this model session");
    expect(result.events).toMatch(/model\ncheck\noriginal\nreceive\nmarker\n/);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe(`-C ${agent} push origin feature\npush origin feature\n`);
    expect(readFileSync(join(root, "receives"), "utf8").trim().split("\n")).toHaveLength(1);
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
    expect(result.events).toMatch(/model\nreceive\ncheck\nmarker\n/);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe("push origin feature\n");
    expect(git(remote, "rev-parse", ref)).toBe(git(agent, "rev-parse", "HEAD"));
  });
  it.each(["setup", "model", "restore", "cleanup"])("prevents publication on %s failure", (failure) => {
    const result = run(failure === "model" ? "return 7" : ":", { setupFailure: failure === "setup", restoreFailure: failure === "restore", cleanupFailure: failure === "cleanup" });
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
  it.each(["anthropic", "openai", "xai"])("uses the production %s dispatch with a filtered tool environment", (provider) => {
    const result = run(`${localCommit}; if git push origin feature; then exit 1; fi`, { provider });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Do not git push in this model session");
    expect(result.stdout).toContain("stub-output");
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe("push origin feature\npush origin feature\n");
    expect(readFileSync(join(root, "receives"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(git(remote, "rev-parse", ref)).toBe(git(agent, "rev-parse", "HEAD"));
    expect(result.events).toContain(provider === "anthropic" ? "--system-prompt-file" : provider === "openai" ? "--sandbox danger-full-access" : "--always-approve");
  });
  it.each(["implement", "design"])("leaves %s model publication unguarded", (name) => {
    const body = entrypoint.match(new RegExp(`^action_${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))?.[0];
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
      log() { :; }
      source "$GUARD"
      setup_repo() { cd "$WORK_DIR"; }
      pre_commit_checks_run() { :; }
      check_pr_readiness_and_promote() { printf 'ready-check\\n' >> "$EVENTS"; }
      gh() {
        if [[ "$1 $2" == 'issue view' ]]; then printf '{"title":"test","body":"body","labels":[],"comments":[]}';
        elif [[ "$1 $2" == 'pr list' ]]; then
          if [[ -e "$WORK_DIR/.published" ]]; then printf 'https://example.invalid/pr/1'; fi
        elif [[ "$1" == api ]]; then printf 1; fi
      }
      run_agent() { git push origin "HEAD:refs/heads/$BRANCH_NAME"; touch .published; }
      eval "$ACTION"
      "action_$NAME"
    `], { cwd: agent, encoding: "utf8", env: { ...env, ACTION: body, NAME: name, GUARD: guard, WORK_DIR: agent,
      GITHUB_ISSUE_NUMBER: "123", GITHUB_REPO: "example/repo", CODE_REVIEWERS: "[]", EVENTS: join(root, "events"),
      PATH: `${join(root, "bin")}:${env.PATH}`, REAL_GIT: realGit, PUSH_CALLS: join(root, "push-calls") } });
    if (process.env.PUBLICATION_EVIDENCE) console.log(`EVIDENCE ${name} status=${result.status} original=${baseline} final=${git(remote, "rev-parse", `refs/heads/${name === "implement" ? "agent" : "design"}/issue-123`)} attempts=${readFileSync(join(root, "push-calls"), "utf8").trim()} receives=${readFileSync(join(root, "receives"), "utf8").trim()} events=${readFileSync(join(root, "events"), "utf8").trim().replaceAll("\n", " | ")}`);
    expect(result.status, result.stderr).toBe(0);
    expect(git(remote, "rev-parse", `refs/heads/${name === "implement" ? "agent" : "design"}/issue-123`)).toBe(baseline);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toContain("push origin HEAD:");
    expect(readFileSync(join(root, "receives"), "utf8")).toContain(`refs/heads/${name === "implement" ? "agent" : "design"}/issue-123`);
  });
  it("guards only the two intended action call sites", () => {
    const calls = [...entrypoint.matchAll(/^\s+run_agent_without_push\s+"([^"]+)"/gm)].map(m => m[1]);
    expect(calls).toEqual(["respond-to-checks.md", "respond-to-review.md"]);
    for (const prompt of ["implement.md", "design.md", "groom.md", "fix-deployment.md", "resolve-conflicts.md"]) {
      expect(entrypoint).toContain(`run_agent "${prompt}"`);
    }
  });
});
