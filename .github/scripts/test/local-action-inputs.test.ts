import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every `with:` key passed to a local composite action must be an input that
 * action declares.  GitHub only warns about undeclared inputs ("Unexpected
 * input(s) ...") and silently drops them, so drift between a call site and
 * the action's `inputs:` block never fails a run on its own (Issue #792:
 * the protected-approval-gate publisher passed an undeclared `head-sha`).
 *
 * Covers this repo's workflows, composite actions that call other local
 * actions, and the adopter stubs in docs/adopting.md (which reference the
 * actions through the `_agentic-workflow` helper checkout).
 */

const repoRoot = new URL("../../../", import.meta.url);
const workflowsDir = new URL(".github/workflows/", repoRoot);
const actionsDir = new URL(".github/actions/", repoRoot);

const LOCAL_ACTION_USES =
  /^(\s*(?:- )?)uses:\s+\.\/(?:_agentic-workflow\/)?\.github\/actions\/([\w-]+)\s*$/;

/**
 * Parse the top-level `inputs:` block of an action.yml:
 *
 *   0  inputs:
 *   2    <name>:
 */
function declaredInputs(actionYml: string): Set<string> {
  const inputs = new Set<string>();
  let inInputs = false;
  for (const line of actionYml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inInputs = trimmed === "inputs:";
      continue;
    }
    if (inInputs && indent === 2) {
      const m = trimmed.match(/^([\w-]+):/);
      if (m) inputs.add(m[1]);
    }
  }
  return inputs;
}

interface CallSite {
  file: string;
  line: number;
  action: string;
  passed: string[];
}

/**
 * Find each step that uses a local action and collect the keys of its
 * `with:` block.  The step's keys sit at the column of `uses:`; the step ends
 * when indentation drops below that column or the next list item starts.
 */
function localActionCalls(file: string, content: string): CallSite[] {
  const lines = content.split("\n");
  const calls: CallSite[] = [];
  lines.forEach((line, i) => {
    const m = line.match(LOCAL_ACTION_USES);
    if (!m) return;
    const keyIndent = m[1].length;
    const passed: string[] = [];
    let inWith = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      const trimmed = next.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const indent = next.length - next.trimStart().length;
      if (indent < keyIndent || trimmed.startsWith("- ") && indent <= keyIndent) break;
      if (indent === keyIndent) {
        inWith = trimmed === "with:";
      } else if (inWith && indent === keyIndent + 2) {
        const key = trimmed.match(/^([\w-]+):/);
        if (key) passed.push(key[1]);
      }
    }
    calls.push({ file, line: i + 1, action: m[2], passed });
  });
  return calls;
}

function sources(): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  for (const name of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
    files.push([`.github/workflows/${name}`, readFileSync(new URL(name, workflowsDir), "utf8")]);
  }
  for (const dir of readdirSync(actionsDir)) {
    const path = new URL(`${dir}/action.yml`, actionsDir);
    if (existsSync(path)) {
      files.push([`.github/actions/${dir}/action.yml`, readFileSync(path, "utf8")]);
    }
  }
  files.push(["docs/adopting.md", readFileSync(new URL("docs/adopting.md", repoRoot), "utf8")]);
  return files;
}

const calls = sources().flatMap(([file, content]) => localActionCalls(file, content));

describe("local composite action call sites", () => {
  it("finds call sites to check", () => {
    // Guards against the parser silently matching nothing.
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.some((c) => c.action === "check-protected-approval-gate")).toBe(true);
  });

  it.each(calls.map((c) => [`${c.file}:${c.line} → ${c.action}`, c] as const))(
    "%s passes only declared inputs",
    (_label, call) => {
      const actionPath = new URL(`${call.action}/action.yml`, actionsDir);
      expect(existsSync(actionPath), `${call.action} has an action.yml`).toBe(true);
      const declared = declaredInputs(readFileSync(actionPath, "utf8"));
      const undeclared = call.passed.filter((key) => !declared.has(key));
      expect(undeclared, `undeclared inputs (declared: ${[...declared].join(", ")})`).toEqual([]);
    },
  );
});
