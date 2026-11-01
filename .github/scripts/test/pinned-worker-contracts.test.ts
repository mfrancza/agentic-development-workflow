/**
 * pinned-worker-contracts.test.ts
 *
 * For every self-referencing reusable workflow call that is pinned to a release
 * tag (`uses: mfrancza/agentic-development-workflow/.github/workflows/<file>@<ref>`),
 * this test:
 *
 *   1. Loads the referenced file **at the pinned tag** via `git show <ref>:...`.
 *      If the tag does not yet exist (pin was bumped to a release about to be
 *      cut), the branch's own copy is used and a notice is printed — the tag
 *      must be created promptly after merge (see README "Releasing").
 *
 *   2. Verifies the call passes every **required** input and secret that the
 *      pinned version declares, and nothing it doesn't declare. A mismatch
 *      means the call will fail at startup with no jobs running.
 *
 *   3. Fails when the pinned worker's contract differs from the branch's
 *      current version — this flags the hazard on the PR that introduces the
 *      change (e.g. dropping a required input from the worker without bumping
 *      the pin) before the call actually breaks in CI.
 *
 * CI checkout must fetch tags so that `git show <ref>:...` can resolve the
 * pinned version; `ci-reusable.yml` sets `fetch-tags: true` on the checkout
 * step for this reason.
 *
 * See also: .github/scripts/test/workflow-call-contracts.test.ts
 * See also: README "Releasing"
 */

import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowsDir = new URL("../../../.github/workflows/", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readWorkflow(name: string): string {
  return readFileSync(new URL(name, workflowsDir), "utf8");
}

function allWorkflowFiles(): string[] {
  return readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

/**
 * Run `git show <ref>:<path>` from the repository root and return the file
 * content, or null when the ref or path does not exist.
 *
 * Requires that the CI checkout fetches tags (`fetch-tags: true`); otherwise
 * tags pushed after the initial clone are invisible to git and this always
 * returns null.
 */
function gitShow(ref: string, gitPath: string): string | null {
  try {
    return execSync(
      `git -C "${repoRoot}" show "${ref}:${gitPath}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    return null;
  }
}

/** Required/optional declaration for one input or secret. */
interface Decl {
  required: boolean;
}

interface WorkflowCallContract {
  inputs: Map<string, Decl>;
  secrets: Map<string, Decl>;
}

/**
 * Parse the `on.workflow_call.inputs` and `on.workflow_call.secrets` sections
 * of a reusable workflow file and return a contract describing each declared
 * input/secret and whether it is required.
 *
 * Tracks YAML indentation levels:
 *   0  on:
 *   2    workflow_call:
 *   4      inputs:
 *   6        <name>:
 *   8          required: true|false
 */
function parseWorkflowCallContract(content: string): WorkflowCallContract {
  const inputs = new Map<string, Decl>();
  const secrets = new Map<string, Decl>();

  let inOn = false;
  let inWorkflowCall = false;
  let currentSection: Map<string, Decl> | null = null;
  let currentKey: string | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inOn = trimmed === "on:";
      inWorkflowCall = false;
      currentSection = null;
      currentKey = null;
      continue;
    }

    if (!inOn) continue;

    if (indent === 2) {
      inWorkflowCall = trimmed === "workflow_call:";
      currentSection = null;
      currentKey = null;
      continue;
    }

    if (!inWorkflowCall) continue;

    if (indent === 4) {
      currentKey = null;
      if (trimmed === "inputs:") {
        currentSection = inputs;
      } else if (trimmed === "secrets:") {
        currentSection = secrets;
      } else {
        currentSection = null;
      }
      continue;
    }

    if (currentSection === null) continue;

    if (indent === 6) {
      const m = trimmed.match(/^([\w-]+):/);
      if (m) {
        currentKey = m[1];
        currentSection.set(currentKey, { required: false });
      }
      continue;
    }

    if (indent === 8 && currentKey !== null) {
      if (trimmed === "required: true") {
        currentSection.set(currentKey, { required: true });
      }
    }
  }

  return { inputs, secrets };
}

/** One discovered pinned self-referencing call site. */
interface PinnedCallSite {
  /** Workflow file containing the call (filename only, not full path). */
  callerFile: string;
  /** Workflow file being called (filename only). */
  workerFile: string;
  /** The ref pinned in the `@<ref>` portion. */
  ref: string;
  /** Line index of the `uses:` line in callerFile (0-based). */
  usesLineIndex: number;
  /** Indentation (spaces) of the `uses:` line. */
  usesIndent: number;
}

/**
 * Pattern matching `uses: mfrancza/agentic-development-workflow/.github/workflows/<file>@<ref>`
 * on a non-comment YAML line.
 */
const PINNED_SELF_REF_RE =
  /uses:\s+mfrancza\/agentic-development-workflow\/\.github\/workflows\/([\w.-]+\.ya?ml)@(\S+)/;

/**
 * Scan all workflow files and return every pinned self-referencing reusable
 * call site, ignoring comment lines.
 */
function findPinnedSelfRefs(): PinnedCallSite[] {
  const sites: PinnedCallSite[] = [];

  for (const file of allWorkflowFiles()) {
    const content = readWorkflow(file);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Skip comment lines — the pattern could appear in example comments.
      if (/^\s*#/.test(lines[i])) continue;
      const m = lines[i].match(PINNED_SELF_REF_RE);
      if (m) {
        sites.push({
          callerFile: file,
          workerFile: m[1],
          ref: m[2],
          usesLineIndex: i,
          usesIndent: lines[i].length - lines[i].trimStart().length,
        });
      }
    }
  }
  return sites;
}

/**
 * Parse what a call site actually passes to the worker: the set of input keys
 * in the `with:` block and the set of secret keys in the `secrets:` block.
 *
 * Scans lines after `uses:` at the same indentation level as `uses:`. Stops
 * when indentation drops below `usesIndent` (i.e. we've left the job block).
 */
function parseCallSite(
  content: string,
  usesLineIndex: number,
  usesIndent: number,
): { passedInputs: Set<string>; passedSecrets: Set<string> } {
  const passedInputs = new Set<string>();
  const passedSecrets = new Set<string>();
  const lines = content.split("\n");

  let inWith = false;
  let inSecrets = false;

  for (let i = usesLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Exited the job block
    if (indent < usesIndent) break;

    if (indent === usesIndent) {
      if (trimmed === "with:") {
        inWith = true;
        inSecrets = false;
      } else if (trimmed === "secrets:") {
        inSecrets = true;
        inWith = false;
      } else {
        // Another job-level key — reset context but keep scanning
        inWith = false;
        inSecrets = false;
      }
    } else if (indent === usesIndent + 2) {
      const m = trimmed.match(/^([\w-]+):/);
      if (m) {
        if (inWith) passedInputs.add(m[1]);
        if (inSecrets) passedSecrets.add(m[1]);
      }
    }
  }

  return { passedInputs, passedSecrets };
}

/** Format a Map<string, Decl> for display, annotating required entries. */
function fmtContract(m: Map<string, Decl>): string {
  if (m.size === 0) return "(none)";
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => (v.required ? `${k}(required)` : k))
    .join(", ");
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function contractsMatch(a: Map<string, Decl>, b: Map<string, Decl>): boolean {
  if (!setsEqual(new Set(a.keys()), new Set(b.keys()))) return false;
  for (const [key, aDecl] of a) {
    const bDecl = b.get(key);
    if (!bDecl || aDecl.required !== bDecl.required) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Discover call sites once; used by all tests below.
// ---------------------------------------------------------------------------

const pinnedRefs = findPinnedSelfRefs();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pinned self-referencing reusable workflow calls", () => {
  it("finds at least one pinned self-referencing call to test", () => {
    // Sanity guard: the test must not silently pass on an empty match set.
    expect(pinnedRefs.length).toBeGreaterThan(0);
  });

  it(
    "caller passes all required inputs/secrets at the pinned tag, " +
      "and no inputs/secrets the pinned tag does not declare",
    () => {
      const violations: string[] = [];

      for (const site of pinnedRefs) {
        const callerContent = readWorkflow(site.callerFile);
        const gitPath = `.github/workflows/${site.workerFile}`;
        const pinnedContent = gitShow(site.ref, gitPath);

        let workerContent: string;
        if (pinnedContent === null) {
          // Tag does not yet exist. This happens when the pin has been bumped
          // to the release about to be cut. Fall back to the branch's current
          // version and print a notice; the tag must be created after merge.
          console.log(
            `[pinned-worker-contracts] NOTICE: tag '${site.ref}' was not found ` +
              `in the local git repository. Comparing ${site.workerFile} against ` +
              `the branch's current version instead. The tag must be created ` +
              `promptly after merge — see README "Releasing".`,
          );
          workerContent = readWorkflow(site.workerFile);
        } else {
          workerContent = pinnedContent;
        }

        const contract = parseWorkflowCallContract(workerContent);
        const { passedInputs, passedSecrets } = parseCallSite(
          callerContent,
          site.usesLineIndex,
          site.usesIndent,
        );

        const prefix =
          `${site.callerFile} → ${site.workerFile}@${site.ref}` +
          (pinnedContent === null ? " (tag not found; using branch copy)" : "");

        // Required inputs must be passed
        for (const [key, decl] of contract.inputs) {
          if (decl.required && !passedInputs.has(key)) {
            violations.push(
              `${prefix}: required input '${key}' is declared by the worker at the ` +
                `pinned tag but is not passed by the caller. The call will fail at ` +
                `startup. Either pass '${key}' or bump the pin to a tag where it is ` +
                `not required.`,
            );
          }
        }

        // No undeclared inputs may be passed
        for (const key of passedInputs) {
          if (!contract.inputs.has(key)) {
            violations.push(
              `${prefix}: caller passes input '${key}' but it is not declared by ` +
                `the worker at the pinned tag. The call will fail at startup. Either ` +
                `remove '${key}' from the caller or bump the pin to a tag that declares it.`,
            );
          }
        }

        // Required secrets must be passed
        for (const [key, decl] of contract.secrets) {
          if (decl.required && !passedSecrets.has(key)) {
            violations.push(
              `${prefix}: required secret '${key}' is declared by the worker at the ` +
                `pinned tag but is not passed by the caller.`,
            );
          }
        }

        // No undeclared secrets may be passed
        for (const key of passedSecrets) {
          if (!contract.secrets.has(key)) {
            violations.push(
              `${prefix}: caller passes secret '${key}' but it is not declared by ` +
                `the worker at the pinned tag. Either remove it or bump the pin.`,
            );
          }
        }
      }

      expect(
        violations,
        "One or more pinned self-referencing workflow calls have a contract " +
          "mismatch with the pinned tag's version of the worker. " +
          "The call will fail at startup with no jobs running.\n\n" +
          "Violations:\n" +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\nFix: bump the pin in the caller's `uses:` line to a tag whose " +
          "worker contract matches what the caller passes, or update the caller " +
          "to match the pinned tag's contract. See README \"Releasing\".",
      ).toEqual([]);
    },
  );

  it(
    "pinned worker contract matches the branch's current worker contract " +
      "(bump the pin when they diverge)",
    () => {
      const drifts: string[] = [];

      for (const site of pinnedRefs) {
        const gitPath = `.github/workflows/${site.workerFile}`;
        const pinnedContent = gitShow(site.ref, gitPath);

        if (pinnedContent === null) {
          // Tag does not exist yet — nothing to compare; the contract-match
          // test above already verified consistency with the branch's copy.
          continue;
        }

        const currentContent = readWorkflow(site.workerFile);
        const pinnedContract = parseWorkflowCallContract(pinnedContent);
        const currentContract = parseWorkflowCallContract(currentContent);

        const inputsMatch = contractsMatch(pinnedContract.inputs, currentContract.inputs);
        const secretsMatch = contractsMatch(pinnedContract.secrets, currentContract.secrets);

        if (!inputsMatch || !secretsMatch) {
          drifts.push(
            `${site.callerFile} pins ${site.workerFile}@${site.ref}, but that tag's ` +
              `contract differs from the branch's current version:\n` +
              `    Pinned  inputs:  ${fmtContract(pinnedContract.inputs)}\n` +
              `    Current inputs:  ${fmtContract(currentContract.inputs)}\n` +
              `    Pinned  secrets: ${fmtContract(pinnedContract.secrets)}\n` +
              `    Current secrets: ${fmtContract(currentContract.secrets)}\n` +
              `  The mismatch means that any running agent-review call that loads ` +
              `the worker at ${site.ref} uses a different contract than the branch's ` +
              `version. Bump the pin to the next release tag before merging. ` +
              `See README "Releasing".`,
          );
        }
      }

      expect(
        drifts,
        "One or more pinned worker calls have a contract drift between the " +
          "pinned tag and the branch's current worker. This means in-flight " +
          "agent-review runs load the worker at the old pin and fail with a " +
          "different contract than what is on the branch. Bump the pin first.\n\n" +
          drifts.join("\n\n"),
      ).toEqual([]);
    },
  );
});
