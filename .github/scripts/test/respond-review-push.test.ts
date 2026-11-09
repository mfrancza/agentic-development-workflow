import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const entrypoint = readFileSync(new URL("../../../docker/scripts/entrypoint.sh", import.meta.url), "utf8");
const action = entrypoint.match(/^action_respond_review\(\) \{\n[\s\S]*?^\}/m)?.[0];
const helper = new URL("../../../docker/scripts/lib/branch-push.sh", import.meta.url).pathname;
const checks = new URL("../../../docker/scripts/lib/pre-commit-checks.sh", import.meta.url).pathname;
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

function runAction(model: string, options: { checkout?: string; check?: string } = {}) {
  const events = join(root, "events");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
    log() { printf '%s\n' "$*"; }
    source "$HELPER"
    source "$CHECKS"
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
      ...environment, ACTION: action, HELPER: helper, CHECKS: checks, WORK_DIR: agent,
      WRITER: writer, BRANCH_REF: branchRef, EVENTS: events, GITHUB_PR_NUMBER: "123",
      GITHUB_REPO: "example/repo", GH_TOKEN: "test-token", CHECKOUT: options.checkout ?? ":", MODEL: model,
      PRE_COMMIT_SCRIPTS_DIR: ".", PRE_COMMIT_CHECK_CMD: options.check ?? "true",
      PATH: `${join(root, "bin")}:${environment.PATH}`, REAL_GIT: realGit, PUSH_CALLS: join(root, "push-calls"),
    },
  });
  return { ...result, events: readFileSync(events, "utf8") };
}

const amend = 'printf amended > .github/amended.txt; git add .github; git commit --amend -m amended';
const writerPush = 'git -C "$WRITER" push origin "HEAD:$BRANCH_REF"';

beforeEach(() => {
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
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("respond-review publication wiring", () => {
  it("sources the production helper", () => {
    expect(entrypoint).toContain('source "${SCRIPTS_DIR}/lib/branch-push.sh"');
    expect(action).toBeDefined();
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
  });

  it.each(["missing-branch", "fetch-failure"])("stops before the model on initial %s", (failure) => {
    const checkout = failure === "missing-branch"
      ? 'git -C "$WRITER" push origin ":$BRANCH_REF"'
      : 'git remote set-url origin "$WORK_DIR/missing.git"';
    const result = runAction(":", { checkout });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("initial fetch failed");
    expect(result.events).not.toMatch(/model|gh pr view|gh api|rereview|marker/);
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
  });

  it("publishes an uncontended rewrite and requests re-review", () => {
    const result = runAction(amend);
    expect(result.status, result.stderr).toBe(0);
    expect(remoteTip()).toBe(git(agent, "rev-parse", "HEAD"));
    expect(remoteTip()).not.toBe(baseline);
    expect(git(agent, "rev-parse", "HEAD^")).toBe(parent);
    expect(readFileSync(join(root, "push-calls"), "utf8"))
      .toContain(`--force-with-lease=${branchRef}:${baseline}`);
    expect(result.events).toMatch(/rereview\nmarker\n/);
  });

  it("normally publishes a fast-forward", () => {
    const result = runAction('printf local > .github/local.txt; git add .github; git commit -m local');
    expect(result.status, result.stderr).toBe(0);
    expect(remoteTip()).toBe(git(agent, "rev-parse", "HEAD"));
    expect(readFileSync(join(root, "push-calls"), "utf8")).toBe(`push origin HEAD:${branchRef}\n`);
    expect(result.events).toMatch(/rereview\nmarker\n/);
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
