import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const helper = new URL("../../../docker/scripts/lib/branch-push.sh", import.meta.url).pathname;
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
  return execFileSync(realGit, ["-C", directory, ...args], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(directory: string, name: string): string {
  writeFileSync(join(directory, `${name}.txt`), name);
  git(directory, "add", `${name}.txt`);
  git(directory, "commit", "-m", name);
  return git(directory, "rev-parse", "HEAD");
}

function amend(directory: string, name: string): string {
  writeFileSync(join(directory, `${name}.txt`), name);
  git(directory, "add", `${name}.txt`);
  git(directory, "commit", "--amend", "-m", name);
  return git(directory, "rev-parse", "HEAD");
}

function remoteTip(): string {
  return git(remote, "rev-parse", "--verify", branchRef);
}

function isAncestor(directory: string, ancestor: string, descendant: string): boolean {
  return spawnSync(realGit, ["-C", directory, "merge-base", "--is-ancestor", ancestor, descendant], {
    env: environment,
  }).status === 0;
}

function runHelper(start = baseline, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", `
    log() { printf '%s\n' "$*"; }
    source "$HELPER"
    branch_push_review "$BRANCH" "$START"
  `], {
    cwd: agent,
    encoding: "utf8",
    env: { ...environment, HELPER: helper, BRANCH: branch, START: start, ...overrides },
  });
}

function wrapper(mode: string): NodeJS.ProcessEnv {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const marker = join(root, "wrapper-marker");
  const calls = join(root, "push-calls");
  writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
set -eu
if [[ "$1" == "push" ]]; then
  printf '%s\n' "$*" >> "$PUSH_CALLS"
  if [[ "$MODE" == race-* && ! -e "$MARKER" ]]; then
    touch "$MARKER"
    if [[ "$MODE" == race-delete ]]; then
      "$REAL_GIT" -C "$WRITER" push origin ":$BRANCH_REF"
    else
      "$REAL_GIT" -C "$WRITER" push origin "HEAD:$BRANCH_REF"
    fi
  fi
fi
if [[ "$1" == "merge-base" && "$MODE" == ancestry-* ]]; then
  if [[ "$MODE" == ancestry-first || -e "$MARKER" ]]; then
    exit 2
  fi
  touch "$MARKER"
fi
if [[ "$1" == "rev-parse" && "$MODE" == ref-error && "$*" == *refs/remotes/origin/* ]]; then
  exit 1
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(join(bin, "git"), 0o755);
  return {
    PATH: `${bin}:${environment.PATH}`,
    REAL_GIT: realGit,
    WRITER: writer,
    BRANCH_REF: branchRef,
    MARKER: marker,
    PUSH_CALLS: calls,
    MODE: mode,
  };
}

function expectFailure(result: ReturnType<typeof runHelper>, reason: string, observed: string, local: string) {
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stdout).toContain(reason);
  expect(result.stdout).toContain(`branch=${branch}`);
  expect(result.stdout).toContain(`start=${baseline}`);
  expect(result.stdout).toContain(`observed=${observed}`);
  expect(result.stdout).toContain(`local=${local}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "branch-push-"));
  remote = join(root, "remote.git");
  agent = join(root, "agent");
  writer = join(root, "writer");
  environment = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.com",
    GIT_TERMINAL_PROMPT: "0",
  };
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, agent);
  git(agent, "checkout", "-b", branch);
  parent = commit(agent, "parent");
  baseline = commit(agent, "baseline");
  git(agent, "push", "origin", `HEAD:${branchRef}`);
  git(root, "clone", "--branch", branch, remote, writer);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("branch_push_review with a real remote", () => {
  it("normally pushes a fast-forward and equality", () => {
    const local = commit(agent, "local");
    const injected = wrapper("record");
    expect(runHelper(baseline, injected).status).toBe(0);
    expect(remoteTip()).toBe(local);
    expect(isAncestor(remote, baseline, local)).toBe(true);
    expect(runHelper(baseline, injected).status).toBe(0);
    expect(remoteTip()).toBe(local);
    expect(readFileSync(injected.PUSH_CALLS as string, "utf8").trim().split("\n"))
      .toEqual([`push origin HEAD:${branchRef}`, `push origin HEAD:${branchRef}`]);
  });

  it("normally pushes when local HEAD incorporates a concurrent update", () => {
    const concurrent = commit(writer, "writer");
    git(writer, "push", "origin", `HEAD:${branchRef}`);
    git(agent, "fetch", "origin", branchRef);
    git(agent, "merge", "--ff-only", "FETCH_HEAD");
    const local = commit(agent, "local");
    expect(runHelper().status).toBe(0);
    expect(remoteTip()).toBe(local);
    expect(isAncestor(remote, concurrent, local)).toBe(true);
  });

  it("publishes an uncontended amendment with the original lease", () => {
    const local = amend(agent, "amended");
    git(agent, "fetch", "origin");
    const injected = wrapper("record");
    expect(runHelper(baseline, injected).status).toBe(0);
    expect(remoteTip()).toBe(local);
    expect(isAncestor(remote, baseline, local)).toBe(false);
    expect(readFileSync(injected.PUSH_CALLS as string, "utf8").trim())
      .toBe(`push --force-with-lease=${branchRef}:${baseline} origin HEAD:${branchRef}`);
  });

  it("publishes an uncontended rebase with the original lease", () => {
    git(agent, "checkout", "--detach", parent);
    const newBase = commit(agent, "new-base");
    git(agent, "checkout", branch);
    git(agent, "rebase", "--onto", newBase, parent);
    const local = git(agent, "rev-parse", "HEAD");
    expect(runHelper().status).toBe(0);
    expect(remoteTip()).toBe(local);
    expect(isAncestor(remote, newBase, local)).toBe(true);
    expect(isAncestor(remote, baseline, local)).toBe(false);
  });

  it.each(["append", "amend"])("rejects concurrent divergence after local %s", (kind) => {
    const local = kind === "append" ? commit(agent, "local") : amend(agent, "local");
    const concurrent = commit(writer, "writer");
    git(writer, "push", "origin", `HEAD:${branchRef}`);
    git(agent, "fetch", "origin");
    const result = runHelper();
    expectFailure(result, "remote changed during the run", concurrent, local);
    expect(remoteTip()).toBe(concurrent);
    expect(isAncestor(remote, concurrent, remoteTip())).toBe(true);
    expect(isAncestor(agent, local, concurrent)).toBe(false);
  });

  it("rejects a strict remote-ahead relationship", () => {
    const concurrent = commit(writer, "writer");
    git(writer, "push", "origin", `HEAD:${branchRef}`);
    expectFailure(runHelper(), "remote is ahead", concurrent, baseline);
    expect(remoteTip()).toBe(concurrent);
    expect(isAncestor(remote, baseline, concurrent)).toBe(true);
  });

  it.each(["normal", "force"])("rejects a second writer after final fetch on the %s path", (kind) => {
    const local = kind === "normal" ? commit(agent, "local") : amend(agent, "local");
    const concurrent = commit(writer, "writer");
    const injected = wrapper("race-push");
    const result = runHelper(baseline, injected);
    expectFailure(result, kind === "normal" ? "normal push rejected" : "explicit-lease push rejected", baseline, local);
    expect(remoteTip()).toBe(concurrent);
    expect(isAncestor(remote, concurrent, remoteTip())).toBe(true);
    expect(readFileSync(injected.PUSH_CALLS as string, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not recreate a branch deleted between fetch and force push", () => {
    const local = amend(agent, "local");
    const result = runHelper(baseline, wrapper("race-delete"));
    expectFailure(result, "explicit-lease push rejected", baseline, local);
    expect(spawnSync(realGit, ["-C", remote, "show-ref", "--verify", "--quiet", branchRef], { env: environment }).status).toBe(1);
  });

  it("fails closed when fetching fails", () => {
    const local = amend(agent, "local");
    git(agent, "remote", "set-url", "origin", join(root, "missing.git"));
    const injected = wrapper("record");
    expectFailure(runHelper(baseline, injected), "fetch failed", "unavailable", local);
    expect(remoteTip()).toBe(baseline);
    expect(() => readFileSync(injected.PUSH_CALLS as string)).toThrow();
  });

  it("fails closed when the remote branch was deleted before fetch", () => {
    const local = amend(agent, "local");
    git(writer, "push", "origin", `:${branchRef}`);
    expectFailure(runHelper(), "fetch failed", "unavailable", local);
    expect(spawnSync(realGit, ["-C", remote, "show-ref", "--verify", "--quiet", branchRef], { env: environment }).status).toBe(1);
  });

  it.each(["", "not-a-commit", "HEAD"])("rejects missing or invalid baseline %j", (start) => {
    const local = amend(agent, "local");
    const injected = wrapper("record");
    const result = runHelper(start, injected);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("invalid original commit");
    expect(result.stdout).toContain(`start=${start}`);
    expect(result.stdout).toContain(`local=${local}`);
    expect(remoteTip()).toBe(baseline);
    expect(() => readFileSync(injected.PUSH_CALLS as string)).toThrow();
  });

  it("fails closed when the fetched ref cannot be resolved", () => {
    const local = amend(agent, "local");
    const injected = wrapper("ref-error");
    expectFailure(runHelper(baseline, injected), "cannot resolve remote commit", "unavailable", local);
    expect(remoteTip()).toBe(baseline);
    expect(() => readFileSync(injected.PUSH_CALLS as string)).toThrow();
  });

  it("rejects invalid branch names without fetching or pushing", () => {
    const local = amend(agent, "local");
    const injected = wrapper("record");
    const result = runHelper(baseline, { ...injected, BRANCH: "../invalid" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("invalid branch");
    expect(result.stdout).toContain(`start=${baseline}`);
    expect(result.stdout).toContain("observed=unavailable");
    expect(result.stdout).toContain(`local=${local}`);
    expect(remoteTip()).toBe(baseline);
    expect(() => readFileSync(injected.PUSH_CALLS as string)).toThrow();
  });

  it.each(["first", "second"])("fails closed on %s ancestry check errors", (position) => {
    const local = amend(agent, "local");
    const injected = wrapper(`ancestry-${position}`);
    expectFailure(runHelper(baseline, injected), "ancestry check failed", baseline, local);
    expect(remoteTip()).toBe(baseline);
    expect(() => readFileSync(injected.PUSH_CALLS as string)).toThrow();
  });
});
