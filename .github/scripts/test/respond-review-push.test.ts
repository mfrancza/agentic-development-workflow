import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const entrypoint = readFileSync(new URL("../../../docker/scripts/entrypoint.sh", import.meta.url), "utf8");
const action = entrypoint.match(/^action_respond_review\(\) \{\n[\s\S]*?^\}/m)?.[0];
const helper = new URL("../../../docker/scripts/lib/branch-push.sh", import.meta.url).pathname;
const checks = new URL("../../../docker/scripts/lib/pre-commit-checks.sh", import.meta.url).pathname;
const guard = new URL("../../../docker/scripts/lib/model-push-guard.sh", import.meta.url).pathname;
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const branch = "review/feature";
const branchRef = `refs/heads/${branch}`;
let root: string;
let remote: string;
let agent: string;
let writer: string;
let baseline: string;
let parent: string;
let environment: NodeJS.ProcessEnv;
let lastStderr = "";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(directory: string, name: string): string {
  mkdirSync(join(directory, ".github"), { recursive: true });
  writeFileSync(join(directory, ".github", `${name}.txt`), name);
  git(directory, "add", ".github");
  git(directory, "commit", "-m", name);
  return git(directory, "rev-parse", "HEAD");
}

function remoteTip(): string {
  return git(remote, "rev-parse", branchRef);
}

function evidence(scenario: string, status: number | null, concurrent: string, local: string, ref = branchRef) {
  if (!process.env.PUBLICATION_EVIDENCE) return;
  const final = spawnSync(realGit, ["-C", remote, "rev-parse", "--verify", ref], { encoding: "utf8" });
  const tip = final.status === 0 ? final.stdout.trim() : "missing";
  const reachable = concurrent === "none" || tip === "missing" ? "n/a" :
    String(spawnSync(realGit, ["-C", remote, "merge-base", "--is-ancestor", concurrent, tip]).status === 0);
  const read = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim().replaceAll("\n", " | ") : "none";
  console.log(`EVIDENCE ${scenario} attempts=${read("push-calls")} receives=${read("receives")} events=${read("events")} status=${status} original=${baseline} writer=${concurrent} local=${local} final=${tip} writer-reachable=${reachable} stderr=${lastStderr.trim().replaceAll("\n", " | ")}`);
}

function runAction(model: string, options: { checkout?: string; check?: string; race?: boolean } = {}) {
  const events = join(root, "events");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
    log() { printf '%s\n' "$*"; }
    source "$HELPER"
    source "$CHECKS"
    source "$GUARD"
    setup_repo() { cd "$WORK_DIR"; }
    gh() {
      printf 'gh %s\n' "$*" >> "$EVENTS"
      if [[ "$1 $2" == 'pr checkout' ]]; then eval "$CHECKOUT"; fi
      if [[ "$1 $2" == 'pr view' ]]; then printf 'main\n'; fi
      if [[ "$1" == 'api' ]]; then printf '[]\n'; fi
    }
    run_agent() { printf 'model\n' >> "$EVENTS"; eval "$MODEL"; }
    request_rereview() { printf 'rereview\n' >> "$EVENTS"; }
    inject_authored_by_marker() { printf 'marker\n' >> "$EVENTS"; }
    eval "$ACTION"
    action_respond_review
  `], {
    cwd: agent,
    encoding: "utf8",
    env: {
      ...environment, ACTION: action, HELPER: helper, CHECKS: checks, GUARD: guard, WORK_DIR: agent,
      WRITER: writer, BRANCH_REF: branchRef, EVENTS: events, GITHUB_PR_NUMBER: "123",
      GITHUB_REPO: "example/repo", GH_TOKEN: "test-token", CHECKOUT: options.checkout ?? ":", MODEL: model,
      PRE_COMMIT_SCRIPTS_DIR: ".", PRE_COMMIT_CHECK_CMD: options.check ?? "true",
      PATH: `${join(root, "bin")}:${environment.PATH}`, REAL_GIT: realGit, PUSH_CALLS: join(root, "push-calls"),
      RACE_PUSH: options.race ? "1" : "0",
    },
  });
  lastStderr = result.stderr;
  return { ...result, events: readFileSync(events, "utf8") };
}

function runNormalAction(name: string, model: string, ref: string) {
  const body = entrypoint.match(new RegExp(`^action_${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))?.[0];
  expect(body).toBeDefined();
  const events = join(root, "events");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
    log() { printf '%s\n' "$*"; }
    source "$CHECKS"
    source "$GUARD"
    setup_repo() { cd "$WORK_DIR"; }
    fix_checks_should_run() { return 0; }
    gh() {
      printf 'gh %s\n' "$*" >> "$EVENTS"
      if [[ "$*" == *'--json labels'* ]]; then printf '{"labels":[]}\n';
      elif [[ "$*" == *'--json title,body,baseRefName'* ]]; then printf '{"title":"test","body":"","baseRefName":"main"}\n'; fi
    }
    run_agent() { printf 'model\n' >> "$EVENTS"; eval "$MODEL"; }
    inject_authored_by_marker() { printf 'marker\n' >> "$EVENTS"; }
    eval "$ACTION"
    "action_$ACTION_NAME"
  `], {
    cwd: agent,
    encoding: "utf8",
    env: {
      ...environment, ACTION: body, ACTION_NAME: name, CHECKS: checks, GUARD: guard, WORK_DIR: agent,
      WRITER: writer, BRANCH_REF: ref, EVENTS: events, GITHUB_PR_NUMBER: "123",
      GITHUB_ISSUE_NUMBER: "123", GITHUB_RUN_ID: "123", GITHUB_REPO: "example/repo", GH_TOKEN: "test-token",
      MODEL: model, PRE_COMMIT_SCRIPTS_DIR: ".", PRE_COMMIT_CHECK_CMD: "true",
      PATH: `${join(root, "bin")}:${environment.PATH}`, REAL_GIT: realGit,
      PUSH_CALLS: join(root, "push-calls"), RACE_PUSH: "1",
    },
  });
  lastStderr = result.stderr;
  return { ...result, events: readFileSync(events, "utf8") };
}

const amend = 'printf amended > .github/amended.txt; git add .github; git commit --amend -m amended';
const writerPush = 'git -C "$WRITER" push origin "HEAD:$BRANCH_REF"';

beforeEach(() => {
  lastStderr = "";
  root = mkdtempSync(join(tmpdir(), "respond-review-push-"));
  remote = join(root, "remote.git");
  agent = join(root, "agent");
  writer = join(root, "writer");
  environment = {
    ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test Author", GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "Test Author", GIT_COMMITTER_EMAIL: "author@example.com", GIT_TERMINAL_PROMPT: "0",
  };
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "git"), `#!/usr/bin/env bash
if [[ "$1" == push ]]; then printf '%s\n' "$*" >> "$PUSH_CALLS"; fi
if [[ "$1" == push && "\${RACE_PUSH:-0}" == 1 ]]; then
  "$REAL_GIT" -C "$WRITER" push origin "HEAD:$BRANCH_REF" || exit $?
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(join(root, "bin", "git"), 0o755);
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, agent);
  git(agent, "checkout", "-b", branch);
  parent = commit(agent, "parent");
  git(agent, "push", "origin", "HEAD:refs/heads/main");
  baseline = commit(agent, "baseline");
  git(agent, "push", "origin", `HEAD:${branchRef}`);
  git(root, "clone", "--branch", branch, remote, writer);
  writeFileSync(join(remote, "hooks", "post-receive"), `#!/bin/sh
cat >> "${join(root, "receives")}"
printf 'receive\\n' >> "${join(root, "events")}"
`);
  chmodSync(join(remote, "hooks", "post-receive"), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("respond-review publication wiring", () => {
  it("sources the production helper", () => {
    expect(entrypoint).toContain('source "${SCRIPTS_DIR}/lib/branch-push.sh"');
    expect(entrypoint).toContain('source "${SCRIPTS_DIR}/lib/model-push-guard.sh"');
    expect(action).toBeDefined();
  });

  it("rejects a model push and publishes after restoring the original hook", () => {
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), '#!/bin/sh\necho original >> "$EVENTS"\n');
    chmodSync(join(hooks, "pre-push"), 0o755);
    git(agent, "config", "core.hooksPath", hooks);
    const result = runAction('printf local > .github/local.txt; git add .github; git commit -m local; if git push origin HEAD; then exit 1; fi');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Do not git push in this model session");
    expect(result.events).toMatch(/model\noriginal\nreceive\nrereview\nmarker\n/);
    expect(git(agent, "config", "--local", "core.hooksPath")).toBe(hooks);
    expect(remoteTip()).toBe(git(agent, "rev-parse", "HEAD"));
  });

  it("stops after a model failure without publishing", () => {
    const result = runAction('return 7');
    expect(result.status).not.toBe(0);
    expect(result.events).not.toMatch(/rereview|marker/);
    expect(remoteTip()).toBe(baseline);
    expect(existsSync(join(root, "push-calls"))).toBe(false);
  });

  it("stops before retrieving reviews or invoking the model on checkout mismatch", () => {
    const concurrent = commit(writer, "concurrent");
    const result = runAction(":", { checkout: writerPush });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("checkout differs from initial remote");
    expect(result.stdout).toContain(`start=${baseline} observed=${concurrent}`);
    expect(result.events).not.toMatch(/model|gh pr view|gh api|rereview|marker/);
    expect(remoteTip()).toBe(concurrent);
    expect(git(agent, "rev-parse", "HEAD")).toBe(baseline);
    evidence("checkout mismatch", result.status, concurrent, baseline);
  });

  it.each(["missing-branch", "fetch-failure"])("stops before the model on initial %s", (failure) => {
    const checkout = failure === "missing-branch"
      ? 'git -C "$WRITER" push origin ":$BRANCH_REF"'
      : 'git remote set-url origin "$WORK_DIR/missing.git"';
    const result = runAction(":", { checkout });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("initial fetch failed");
    expect(result.events).not.toMatch(/model|gh pr view|gh api|rereview|marker/);
    evidence(`initial ${failure}`, result.status, "none", baseline);
  });

  it("skips publication and re-review when HEAD is unchanged", () => {
    const result = runAction(":");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("HEAD unchanged; skipping push and re-review request");
    expect(result.events).toContain("model\n");
    expect(result.events).not.toContain("rereview");
    expect(result.events).toContain("marker\n");
    expect(remoteTip()).toBe(baseline);
    expect(existsSync(join(root, "push-calls"))).toBe(false);
    evidence("unchanged HEAD", result.status, "none", baseline);
  });

  it("publishes an uncontended rewrite and requests re-review", () => {
    const result = runAction(amend);
    expect(result.status, result.stderr).toBe(0);
    expect(remoteTip()).toBe(git(agent, "rev-parse", "HEAD"));
    expect(remoteTip()).not.toBe(baseline);
    expect(git(agent, "rev-parse", "HEAD^")).toBe(parent);
    expect(spawnSync(realGit, ["-C", agent, "merge-base", "--is-ancestor", baseline, "HEAD"]).status).toBe(1);
    expect(readFileSync(join(root, "push-calls"), "utf8"))
      .toContain(`--force-with-lease=${branchRef}:${baseline}`);
    expect(result.events).toMatch(/rereview\nmarker\n/);
    evidence("uncontended rewrite", result.status, "none", git(agent, "rev-parse", "HEAD"));
  });

  it("normally publishes a fast-forward", () => {
    const result = runAction('printf local > .github/local.txt; git add .github; git commit -m local');
    expect(result.status, result.stderr).toBe(0);
    expect(remoteTip()).toBe(git(agent, "rev-parse", "HEAD"));
    expect(spawnSync(realGit, ["-C", agent, "merge-base", "--is-ancestor", baseline, "HEAD"]).status).toBe(0);
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe(`push origin HEAD:${branchRef}\n`);
    expect(result.events).toMatch(/rereview\nmarker\n/);
    evidence("uncontended normal", result.status, "none", git(agent, "rev-parse", "HEAD"));
  });

  it.each(["normal", "force"])("rejects a %s push raced after the helper's final fetch", (kind) => {
    const concurrent = commit(writer, "concurrent");
    const model = kind === "force" ? amend : 'printf local > .github/local.txt; git add .github; git commit -m local';
    const result = runAction(model, { race: true, check: 'git fetch origin' });
    const local = git(agent, "rev-parse", "HEAD");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(kind === "force" ? "explicit-lease push rejected" : "normal push rejected");
    expect(result.stdout).toContain("pre-commit-checks: passed");
    expect(result.stderr).toContain("[rejected]");
    expect(remoteTip()).toBe(concurrent);
    expect(spawnSync(realGit, ["-C", remote, "merge-base", "--is-ancestor", concurrent, remoteTip()]).status).toBe(0);
    expect(result.events).not.toMatch(/rereview|marker/);
    const push = readFileSync(join(root, "push-calls"), "utf8");
    if (kind === "force") expect(push).toContain(`--force-with-lease=${branchRef}:${baseline}`);
    evidence(`respond-review post-fetch ${kind}`, result.status, concurrent, local);
  });

  it.each([
    ["model", "amend"], ["model", "append"], ["pre-commit", "amend"], ["pre-commit", "append"],
  ])("rejects local %s-phase divergence after %s despite a fetch", (phase, change) => {
    const concurrent = commit(writer, "concurrent");
    const localChange = change === "amend" ? amend : 'printf local > .github/local.txt; git add .github; git commit -m local';
    const model = phase === "model" ? `${localChange}; ${writerPush}; git fetch origin` : localChange;
    const check = phase === "pre-commit" ? `${writerPush}; git fetch origin; exit 1` : "true";
    const result = runAction(model, { check });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("remote changed during the run");
    expect(result.stdout).toContain(`start=${baseline} observed=${concurrent}`);
    expect(remoteTip()).toBe(concurrent);
    expect(result.events).not.toMatch(/rereview|marker/);
    if (phase === "pre-commit") expect(result.events).toContain("gh pr comment");
    expect(spawnSync(realGit, ["-C", remote, "merge-base", "--is-ancestor", concurrent, remoteTip()]).status).toBe(0);
    evidence(`${phase} ${change} extra fetch`, result.status, concurrent, git(agent, "rev-parse", "HEAD"));
  });

  it.each(["missing-branch", "fetch-failure"])("fails safely on publication %s", (failure) => {
    const disruption = failure === "missing-branch"
      ? 'git -C "$WRITER" push origin ":$BRANCH_REF"'
      : 'git remote set-url origin "$WORK_DIR/missing.git"';
    const result = runAction(`${amend}; ${disruption}`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("fetch failed");
    expect(result.events).not.toMatch(/rereview|marker/);
    if (failure === "fetch-failure") expect(remoteTip()).toBe(baseline);
    else expect(spawnSync(realGit, ["-C", remote, "show-ref", "--verify", "--quiet", branchRef]).status).toBe(1);
    expect(existsSync(join(root, "push-calls"))).toBe(false);
    evidence(`publication ${failure}`, result.status, "none", git(agent, "rev-parse", "HEAD"));
  });

  it("rejects a remote-ahead branch without re-review or marker mutation", () => {
    const result = runAction(`git reset --hard ${parent}`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("remote is ahead");
    expect(remoteTip()).toBe(baseline);
    expect(result.events).not.toMatch(/rereview|marker/);
  });

  it("publishes despite a failing pre-commit check", () => {
    const result = runAction(amend, { check: "exit 1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.events).toContain("gh pr comment");
    expect(result.events).toMatch(/rereview\nmarker\n/);
    expect(remoteTip()).toBe(git(agent, "rev-parse", "HEAD"));
  });
});

describe("normal-only entrypoint publication against concurrent writers", () => {
  it.each(["fix_checks", "resolve_clean", "resolve_conflicted", "fix_deployment"])("preserves a competing tip in %s", (scenario) => {
    const isResolve = scenario.startsWith("resolve_");
    const conflicted = scenario === "resolve_conflicted";
    const ref = scenario === "fix_deployment" ? "refs/heads/agent/fix-deploy-issue-123" : branchRef;
    if (isResolve) {
      git(writer, "checkout", "-B", "main", parent);
      writeFileSync(join(writer, conflicted ? "conflict.txt" : "main.txt"), "main\n");
      git(writer, "add", ".");
      git(writer, "commit", "-m", "main change");
      git(writer, "push", "origin", "HEAD:refs/heads/main");
      git(writer, "checkout", branch);
      if (conflicted) {
        writeFileSync(join(agent, "conflict.txt"), "branch\n");
        git(agent, "add", ".");
        git(agent, "commit", "-m", "branch change");
        git(agent, "push", "origin", `HEAD:${branchRef}`);
        baseline = git(agent, "rev-parse", "HEAD");
        git(writer, "fetch", "origin", branch);
        git(writer, "reset", "--hard", baseline);
      }
    }
    if (scenario === "fix_deployment") git(agent, "push", "origin", `HEAD:${ref}`);
    const concurrent = commit(writer, "concurrent");
    const model = conflicted ? 'printf "resolved\\n" > conflict.txt; git add conflict.txt' :
      'printf local > .github/local.txt; git add .github; git commit -m local';
    const actionName = isResolve ? "resolve_conflicts" : scenario;
    const result = runNormalAction(actionName, model, ref);
    const local = git(agent, "rev-parse", "HEAD");
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("[rejected]");
    expect(git(remote, "rev-parse", ref)).toBe(concurrent);
    expect(spawnSync(realGit, ["-C", remote, "merge-base", "--is-ancestor", concurrent, ref]).status).toBe(0);
    git(agent, "fetch", "origin", ref);
    expect(spawnSync(realGit, ["-C", agent, "merge-base", "--is-ancestor", concurrent, local]).status).toBe(1);
    expect(result.events).not.toMatch(/marker|gh pr create|gh pr comment/);
    expect(readFileSync(join(root, "push-calls"), "utf8")).not.toMatch(/--force|\s-f\b|\+HEAD/);
    if (isResolve) expect(result.stdout).toContain(conflicted ? "Verification passed — committing merge" : "Clean merge — pushing");
    evidence(scenario, result.status, concurrent, local, ref);
  });
});
