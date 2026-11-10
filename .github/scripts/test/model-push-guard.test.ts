import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const helper = new URL("../../../docker/scripts/lib/model-push-guard.sh", import.meta.url).pathname;
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const message = "Do not git push in this model session. Commit locally; the entrypoint will push after the session exits.";
const branchRef = "refs/heads/feature";
let root: string;
let checkout: string;
let remote: string;
let hookLog: string;
let environment: NodeJS.ProcessEnv;
let baseline: string;

function git(directory: string, ...args: string[]): string {
  return execFileSync(realGit, ["-C", directory, ...args], {
    env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function localConfig(): Buffer {
  const result = spawnSync(realGit, ["-C", checkout, "config", "--local", "--null", "--get-all", "core.hooksPath"], {
    env: environment,
  });
  expect([0, 1]).toContain(result.status);
  return result.stdout;
}

function remoteTip(): string {
  return git(remote, "rev-parse", branchRef);
}

function hook(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' '${name}' >> "$HOOK_LOG"\n`);
  chmodSync(file, 0o755);
}

function runModel(script: string, overrides: NodeJS.ProcessEnv = {}) {
  const model = join(root, "model.sh");
  writeFileSync(model, `#!/bin/bash\nset -euo pipefail\n${script}\n`);
  return spawnSync("bash", ["-euo", "pipefail", "-c", `
    umask 0022
    source "$HELPER"
    run_agent() {
      printf 'arguments=<%s>|<%s>\\n' "$1" "$2"
      bash "$MODEL"
    }
    run_agent_without_push 'prompt with spaces' 'task text'
  `], {
    cwd: checkout, encoding: "utf8",
    env: { ...environment, HELPER: helper, MODEL: model, ...overrides },
  });
}

function injectFailures(mode: string): NodeJS.ProcessEnv {
  const bin = join(root, "injected bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/bash
if [[ "$FAILURE" == restore && "$*" == *'config --local --unset-all core.hooksPath'* ]]; then exit 9; fi
if [[ "$FAILURE" == activate && "$*" == *'config --local --replace-all core.hooksPath'* ]]; then exit 9; fi
if [[ "$FAILURE" == snapshot && "$*" == *'config --local --null --get-all core.hooksPath'* ]]; then exit 9; fi
exec "$REAL_GIT" "$@"
`);
  writeFileSync(join(bin, "rm"), `#!/bin/bash
if [[ "$FAILURE" == cleanup ]]; then printf '%s\\n' "$*" > "$FAILURE_LOG"; exit 9; fi
exec /bin/rm "$@"
`);
  writeFileSync(join(bin, "mktemp"), `#!/bin/bash
if [[ "$FAILURE" == mktemp ]]; then exit 9; fi
exec /usr/bin/mktemp "$@"
`);
  for (const name of ["git", "rm", "mktemp"]) chmodSync(join(bin, name), 0o755);
  return { PATH: `${bin}:${environment.PATH}`, REAL_GIT: realGit, FAILURE: mode, FAILURE_LOG: join(root, "cleanup-failure") };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "model guard with spaces "));
  checkout = join(root, "work tree");
  remote = join(root, "bare remote.git");
  hookLog = join(root, "hook log");
  environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", HOOK_LOG: hookLog,
  };
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, checkout);
  git(checkout, "config", "user.name", "Test Author");
  git(checkout, "config", "user.email", "author@example.com");
  git(checkout, "checkout", "-b", "feature");
  writeFileSync(join(checkout, "file"), "initial");
  git(checkout, "add", "file");
  git(checkout, "commit", "-m", "initial");
  git(checkout, "push", "origin", `HEAD:${branchRef}`);
  baseline = remoteTip();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("run_agent_without_push with real Git", () => {
  it("blocks ordinary, -C, force and deletion pushes while retaining other hooks", () => {
    const hooks = join(checkout, "custom hooks");
    for (const name of ["pre-commit", "commit-msg", "pre-push"]) hook(hooks, name);
    git(checkout, "config", "--local", "core.hooksPath", "custom hooks");
    const original = localConfig();
    const result = runModel(`
      printf 'local change' > file
      git add file
      git commit -m local
      for kind in ordinary directory force deletion; do
        case "$kind" in
          ordinary) args=(push origin HEAD:refs/heads/feature) ;;
          directory) args=(-C "$CHECKOUT" push origin HEAD:refs/heads/feature) ;;
          force) args=(push --force origin HEAD:refs/heads/feature) ;;
          deletion) args=(push origin :refs/heads/feature) ;;
        esac
        if env -i PATH="$PATH" HOME="$HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git "\${args[@]}"; then
          echo "unexpected push success: $kind" >&2
          exit 1
        fi
      done
      cd /
    `, { CHECKOUT: checkout });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("arguments=<prompt with spaces>|<task text>");
    expect(result.stderr.split(message)).toHaveLength(5);
    expect(remoteTip()).toBe(baseline);
    expect(git(checkout, "rev-parse", "HEAD")).not.toBe(baseline);
    expect(readFileSync(hookLog, "utf8").trim().split("\n")).toEqual(["pre-commit", "commit-msg"]);
    expect(localConfig()).toEqual(original);
    git(checkout, "push", "origin", `HEAD:${branchRef}`);
    expect(remoteTip()).toBe(git(checkout, "rev-parse", "HEAD"));
    expect(readFileSync(hookLog, "utf8").trim().split("\n")).toEqual(["pre-commit", "commit-msg", "pre-push"]);
  });

  it.each([
    { name: "unset", paths: [] },
    { name: "empty", paths: [""] },
    { name: "multiple", paths: ["first path", "", "line\nbreak", "last path"] },
    { name: "multiple ending empty", paths: ["first path", ""] },
  ])("restores $name local configuration exactly", ({ paths }) => {
    for (const path of paths) git(checkout, "config", "--local", "--add", "core.hooksPath", path);
    const original = localConfig();
    const result = runModel("printf 'model output\\n'; cd /");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("model output");
    expect(localConfig()).toEqual(original);
  });

  it("preserves default and global non-push hooks without changing global configuration", () => {
    const hooks = join(root, "global hooks with spaces");
    hook(hooks, "pre-commit");
    const global = join(root, "global config");
    execFileSync(realGit, ["config", "--file", global, "core.hooksPath", hooks], { env: environment });
    const before = readFileSync(global);
    const result = runModel("git commit --allow-empty -m guarded", { GIT_CONFIG_GLOBAL: global });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(hookLog, "utf8")).toContain("pre-commit");
    expect(readFileSync(global)).toEqual(before);
    expect(localConfig()).toEqual(Buffer.alloc(0));
  });

  it("forwards the default hooks directory", () => {
    hook(join(checkout, ".git", "hooks"), "pre-commit");
    const result = runModel("git commit --allow-empty -m guarded");
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(hookLog, "utf8")).toContain("pre-commit");
  });

  it("fails before running the model when a higher-precedence override wins", () => {
    const original = localConfig();
    const result = runModel("echo SHOULD_NOT_RUN", {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: join(root, "override"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("overridden by higher-precedence");
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(localConfig()).toEqual(original);
  });

  it("rejects a worktree-specific hooks override without changing it", () => {
    git(checkout, "config", "--local", "extensions.worktreeConfig", "true");
    git(checkout, "config", "--local", "core.hooksPath", "original hooks");
    git(checkout, "config", "--worktree", "core.hooksPath", "worktree hooks");
    const original = localConfig();
    const result = runModel("echo SHOULD_NOT_RUN");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("overridden by higher-precedence");
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(localConfig()).toEqual(original);
    expect(git(checkout, "config", "--worktree", "--get", "core.hooksPath")).toBe("worktree hooks");
  });

  it("keeps the overlay private without changing the model umask and removes it afterward", () => {
    const result = runModel("umask; git config --local --get core.hooksPath > \"$OVERLAY_FILE\"; stat -c %a \"$(dirname \"$(cat \"$OVERLAY_FILE\")\")\"", {
      OVERLAY_FILE: join(root, "overlay path"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0022");
    expect(result.stdout).toContain("700");
    const overlay = readFileSync(join(root, "overlay path"), "utf8").trim();
    expect(existsSync(dirname(overlay))).toBe(false);
  });

  it("preserves the model failure status and restores configuration", () => {
    git(checkout, "config", "core.hooksPath", "custom hooks");
    const original = localConfig();
    const result = runModel("cd /; echo failed >&2; exit 42");
    expect(result.status).toBe(42);
    expect(result.stderr).toContain("failed");
    expect(localConfig()).toEqual(original);
  });

  it.each(["mktemp", "snapshot", "activate"])("fails visibly on %s setup failure", (mode) => {
    const original = localConfig();
    const result = runModel("echo SHOULD_NOT_RUN", injectFailures(mode));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ERROR:");
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(localConfig()).toEqual(original);
  });

  it("fails visibly and retains the overlay if restoration fails", () => {
    const result = runModel("echo ran", injectFailures("restore"));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("ran");
    expect(result.stderr).toContain("Cannot restore local core.hooksPath");
    const overlay = git(checkout, "config", "--local", "--get", "core.hooksPath");
    expect(existsSync(join(overlay, "pre-push"))).toBe(true);
    rmSync(dirname(overlay), { recursive: true, force: true });
  });

  it("fails visibly if overlay cleanup fails", () => {
    const result = runModel("echo ran", injectFailures("cleanup"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot remove model push guard overlay");
    expect(localConfig()).toEqual(Buffer.alloc(0));
    const retained = readFileSync(join(root, "cleanup-failure"), "utf8").trim().replace(/^-rf -- /, "");
    expect(existsSync(retained)).toBe(true);
    rmSync(retained, { recursive: true, force: true });
  });
});
