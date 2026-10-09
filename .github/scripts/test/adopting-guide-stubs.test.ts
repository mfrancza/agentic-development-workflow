import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static contract test: every caller stub published in docs/adopting.md must
 * satisfy the `workflow_call` contract of the reusable workflow it calls.
 *
 * Why this exists: PR #578 added two required inputs (`review-author`,
 * `pr-author`) to agent-respond-review-reusable.yml, and the guide's stub was
 * not updated. Any adopter who copied that stub and pinned `@v0` would have
 * failed at workflow validation the moment the moving tag advanced. The same
 * failure class hit an external adopter with `secrets: inherit` (#581). This
 * test fails CI when a reusable's required inputs or declared secrets drift
 * away from the stub the guide tells adopters to copy.
 *
 * The parser is deliberately indentation-based (no YAML dependency), matching
 * the style of the other static workflow tests in this directory. It relies on
 * the formatting conventions the reusables and the guide already follow:
 * two-space indentation, one key per line.
 */

const repoRoot = new URL("../../../", import.meta.url);
const workflowsDir = new URL(".github/workflows/", repoRoot);
const guide = readFileSync(new URL("docs/adopting.md", repoRoot), "utf8");

function indentOf(line: string): number {
  return (line.match(/^( *)/) ?? ["", ""])[1].length;
}

/**
 * Collects the child keys of a mapping that starts on `startLine` (the line
 * holding `key:`), i.e. every line whose indentation is exactly
 * `childIndent` and that looks like `name:` or `name: value`, until a
 * non-blank, non-comment line with indentation < childIndent is reached.
 * For each child key, also captures the raw lines of its nested block so the
 * caller can inspect attributes such as `required: true`.
 */
function childBlocks(
  lines: string[],
  startLine: number,
  childIndent: number,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string | null = null;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const ind = indentOf(line);
    if (ind < childIndent) break;
    if (ind === childIndent) {
      const m = line.match(/^ *([A-Za-z0-9_.-]+):/);
      if (!m) break;
      current = m[1];
      result.set(current, []);
      continue;
    }
    if (current !== null) result.get(current)!.push(line);
  }
  return result;
}

/** Finds the first line index matching `re` at exactly `indent` spaces. */
function findLine(
  lines: string[],
  re: RegExp,
  indent: number,
  from = 0,
): number {
  for (let i = from; i < lines.length; i++) {
    if (indentOf(lines[i]) === indent && re.test(lines[i].trim())) return i;
  }
  return -1;
}

interface ReusableContract {
  requiredInputs: string[];
  allInputs: string[];
  secrets: string[];
}

function parseReusable(content: string): ReusableContract {
  const lines = content.split("\n");
  const onIdx = findLine(lines, /^on:$/, 0);
  expect(onIdx, "reusable has a top-level on:").toBeGreaterThanOrEqual(0);
  const callIdx = findLine(lines, /^workflow_call:$/, 2, onIdx);
  expect(callIdx, "reusable has on.workflow_call").toBeGreaterThanOrEqual(0);
  const sections = childBlocks(lines, callIdx, 4);

  const inputs = new Map<string, string[]>();
  const secrets = new Map<string, string[]>();
  const inputsIdx = findLine(lines, /^inputs:$/, 4, callIdx);
  if (inputsIdx >= 0 && sections.has("inputs")) {
    for (const [k, v] of childBlocks(lines, inputsIdx, 6)) inputs.set(k, v);
  }
  const secretsIdx = findLine(lines, /^secrets:$/, 4, callIdx);
  if (secretsIdx >= 0 && sections.has("secrets")) {
    for (const [k, v] of childBlocks(lines, secretsIdx, 6)) secrets.set(k, v);
  }

  const isRequired = (block: string[]) =>
    block.some((l) => /^\s*required:\s*true\s*$/.test(l));

  return {
    requiredInputs: [...inputs].filter(([, b]) => isRequired(b)).map(([k]) => k),
    allInputs: [...inputs.keys()],
    secrets: [...secrets.keys()],
  };
}

interface Stub {
  reusable: string;
  job: string;
  withKeys: string[];
  secretKeys: string[];
}

/** Extracts every job in the guide's ```yaml blocks that `uses:` a published reusable. */
function parseGuideStubs(): Stub[] {
  const stubs: Stub[] = [];
  const blocks = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const usesRe =
    /^( *)uses:\s+mfrancza\/agentic-development-workflow\/\.github\/workflows\/([A-Za-z0-9_-]+-reusable\.yml)@/;

  for (const block of blocks) {
    const lines = block.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(usesRe);
      if (!m) continue;
      const indent = m[1].length;
      // Walk back to the job key (the nearest line at indent-2 ending in ':').
      let job = "?";
      for (let j = i - 1; j >= 0; j--) {
        if (indentOf(lines[j]) === indent - 2 && /^[A-Za-z0-9_-]+:$/.test(lines[j].trim())) {
          job = lines[j].trim().slice(0, -1);
          break;
        }
      }
      // A `uses:` line with no enclosing job key is an illustrative fragment
      // (e.g. the helpers-ref gotcha shows `uses:` + `with:` on their own),
      // not a stub adopters copy wholesale. Skip it.
      if (job === "?") continue;
      // Sibling keys of `uses:` within this job block.
      const siblings = childBlocks(lines, i - 1, indent);
      const withIdx = findLine(lines, /^with:$/, indent, i);
      const secretsIdx = findLine(lines, /^secrets:$/, indent, i);
      const withKeys =
        withIdx >= 0 && siblings.has("with")
          ? [...childBlocks(lines, withIdx, indent + 2).keys()]
          : [];
      const secretKeys =
        secretsIdx >= 0 && siblings.has("secrets")
          ? [...childBlocks(lines, secretsIdx, indent + 2).keys()]
          : [];
      stubs.push({ reusable: m[2], job, withKeys, secretKeys });
    }
  }
  return stubs;
}

const reusableFiles = readdirSync(workflowsDir).filter((f) =>
  f.endsWith("-reusable.yml"),
);
const stubs = parseGuideStubs();

describe("docs/adopting.md caller stubs match their reusable workflow contracts", () => {
  it("finds at least one stub per externally published agent reusable", () => {
    const covered = new Set(stubs.map((s) => s.reusable));
    for (const f of reusableFiles) {
      // terraform-ci-reusable.yml is consumer-only (documented gotcha) and
      // test-*-reusable.yml are this repo's own regression harnesses.
      if (f === "terraform-ci-reusable.yml" || f.startsWith("test-")) continue;
      expect(covered, `guide has a stub for ${f}`).toContain(f);
    }
  });

  for (const stub of stubs) {
    const contract = parseReusable(
      readFileSync(new URL(stub.reusable, workflowsDir), "utf8"),
    );

    describe(`${stub.reusable} (job: ${stub.job})`, () => {
      it("passes every required input", () => {
        const missing = contract.requiredInputs.filter(
          (k) => !stub.withKeys.includes(k),
        );
        expect(missing, "required inputs missing from the guide stub").toEqual([]);
      });

      it("passes only inputs the reusable declares", () => {
        const unknown = stub.withKeys.filter((k) => !contract.allInputs.includes(k));
        expect(unknown, "stub passes inputs the reusable does not declare").toEqual([]);
      });

      it("names every secret the reusable declares", () => {
        const missing = contract.secrets.filter((k) => !stub.secretKeys.includes(k));
        expect(missing, "declared secrets missing from the guide stub").toEqual([]);
      });
    });
  }
});
