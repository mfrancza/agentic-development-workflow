import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const caller = read("workflows/agent-resolve-conflicts-labeled.yml");
const reusable = read("workflows/agent-resolve-conflicts-reusable.yml");
const pushCaller = read("workflows/agent-resolve-conflicts.yml");
const labels = readFileSync(
  new URL("../../../terraform/modules/labels/main.tf", import.meta.url),
  "utf8",
);

function job(name: string): string {
  const match = reusable.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|$(?![\\s\\S]))`, "m"),
  );
  expect(match, `missing ${name} job`).not.toBeNull();
  return match![1];
}

function step(block: string, name: string): string {
  const match = block.match(
    new RegExp(`^      - name: ${name}\\n([\\s\\S]*?)(?=^      - name: |$(?![\\s\\S]))`, "m"),
  );
  expect(match, `missing ${name} step`).not.toBeNull();
  return match![1];
}

describe("on-demand conflict resolution workflow contract", () => {
  it("defines the trigger label and routes trusted-base label events only", () => {
    expect(labels).toMatch(/"agent:resolve-conflicts"\s*=\s*\{\s*color\s*=\s*"6f42c1"\s*description\s*=\s*"Run the merge-conflict resolver against this PR on demand\."/);
    expect(caller).toMatch(/on:\s*\n  pull_request_target:\s*\n    types: \[labeled\]/);
    expect(caller).toContain("github.event.label.name == 'agent:resolve-conflicts'");
    expect(caller).toContain("github.event.sender.login != ''");
    expect(caller).toContain("github.event.pull_request.head.repo.full_name == github.event.pull_request.base.repo.full_name");
    expect(caller).toContain("pr-number: ${{ github.event.pull_request.number }}");
    expect(caller).toContain("sender-login: ${{ github.event.sender.login }}");
    expect(caller).toContain("helpers-ref: ${{ github.sha }}");
    expect(caller).not.toMatch(/actions\/checkout|\brun:/);
  });

  it("keeps all workflow tokens read-only", () => {
    expect(caller).toMatch(/permissions:\s*\n  contents: read\s*\n  pull-requests: read/);
    expect(caller).not.toMatch(/:\s*write\b/);
    for (const name of ["state-gate", "authorize", "find-conflicted-prs", "resolve"]) {
      const block = job(name);
      expect(block).toMatch(/^    permissions:\s*\n/m);
      expect(block).not.toMatch(/^      [\w-]+:\s*write\b/m);
    }
  });

  it("checks open state before authorization and finding PRs", () => {
    const state = job("state-gate");
    const authorize = job("authorize");
    const find = job("find-conflicted-prs");
    expect(state).toContain("contents: read");
    expect(state).toContain("pull-requests: read");
    expect(state).toContain("ref: ${{ steps.resolve-ref.outputs.sha }}");
    expect(state).toContain("name: Verify helper checkout HEAD matches resolved SHA");
    expect(state).toContain("run: npx --no-install tsx src/check-conflict-resolution-state.ts");
    expect(state).toContain("SENDER: ${{ inputs.sender-login }}");
    expect(state).toContain("PR_NUMBER: ${{ inputs.pr-number }}");
    expect(authorize).toContain("needs: state-gate");
    expect(authorize).toContain("needs.state-gate.outputs.proceed == 'true'");
    expect(find).toContain("needs: [state-gate, authorize]");
    expect(find).toContain("needs.authorize.result == 'success'");
    expect(job("resolve")).toContain("needs: find-conflicted-prs");
  });

  it("authorizes label senders and preserves the push/dispatch bypass", () => {
    expect(reusable).toMatch(/sender-login:\s*\n(?:.*\n)*?        default: ''/);
    for (const secret of ["ALLOWLIST_RESOLVER_APP_ID", "ALLOWLIST_RESOLVER_APP_PRIVATE_KEY"]) {
      expect(reusable).toContain(`${secret}: { required: false }`);
      expect(caller).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
    const authorize = job("authorize");
    expect(authorize).toContain("uses: ./_agentic-workflow/.github/actions/check-agent-allowlist");
    expect(authorize).toContain("principal: ${{ inputs.sender-login }}");
    expect(authorize).toContain("skip-gate: ${{ inputs.sender-login == '' }}");
    expect(authorize).toContain("resolver-token: ${{ steps.allowlist-resolver.outputs.token }}");
    expect(pushCaller).not.toContain("sender-login:");
  });

  it("clears escalation and cleans up only after success inside the existing lock", () => {
    const resolve = job("resolve");
    expect(resolve).toContain("group: agent-branch-pr-${{ matrix.pr_number }}");
    expect(resolve).toContain("cancel-in-progress: false");
    expect(reusable.match(/group: agent-branch-pr-/g)).toHaveLength(1);
    const clear = step(resolve, "Clear prior conflict escalation");
    const cleanup = step(resolve, "Remove on-demand trigger label");
    expect(clear).toContain("if: inputs.sender-login != ''");
    expect(clear).toContain("GH_TOKEN: ${{ steps.setup.outputs.token }}");
    expect(clear).toContain("labels/conflicts-escalated");
    expect(clear).toContain("gh pr comment");
    expect(cleanup).toContain("if: success() && inputs.sender-login != ''");
    expect(cleanup).toContain("GH_TOKEN: ${{ steps.setup.outputs.token }}");
    expect(cleanup).toContain("labels/agent%3Aresolve-conflicts");
    expect(resolve.indexOf("name: Mint installation token for developer-agent")).toBeLessThan(resolve.indexOf("name: Clear prior conflict escalation"));
    expect(resolve.indexOf("name: Clear prior conflict escalation")).toBeLessThan(resolve.indexOf("name: Run agent"));
    expect(resolve.indexOf("name: Run agent")).toBeLessThan(resolve.indexOf("name: Remove on-demand trigger label"));
  });

  it.each([
    { deleteStatus: "success", labelsStatus: "success", labels: "", status: 0, reads: false },
    { deleteStatus: "404", labelsStatus: "success", labels: "other", status: 0, reads: true },
    { deleteStatus: "404", labelsStatus: "success", labels: "agent:resolve-conflicts", status: 1, reads: true },
    { deleteStatus: "404", labelsStatus: "failure", labels: "", status: 1, reads: true },
    { deleteStatus: "403", labelsStatus: "success", labels: "", status: 1, reads: false },
    { deleteStatus: "network", labelsStatus: "success", labels: "", status: 1, reads: false },
  ])("handles trigger cleanup: $deleteStatus / $labelsStatus / $labels", ({ deleteStatus, labelsStatus, labels, status, reads }) => {
    const directory = mkdtempSync(join(tmpdir(), "conflict-cleanup-"));
    try {
      const log = join(directory, "calls");
      writeFileSync(join(directory, "gh"), `#!/bin/bash
echo "$*" >> "$CALLS"
if [[ "$*" == *"--method DELETE"* ]]; then
  if [[ "$DELETE_STATUS" == success ]]; then exit 0; fi
  if [[ "$DELETE_STATUS" == network ]]; then echo 'network error' >&2; exit 1; fi
  echo "gh: request failed (HTTP $DELETE_STATUS)" >&2
  exit 1
fi
if [[ "$LABELS_STATUS" == failure ]]; then exit 1; fi
printf '%s\\n' "$LABELS"
`, { mode: 0o755 });
      const cleanup = step(job("resolve"), "Remove on-demand trigger label");
      const script = cleanup.split("        run: |\n")[1].replace(/^          /gm, "");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CALLS: log, DELETE_STATUS: deleteStatus, LABELS_STATUS: labelsStatus, LABELS: labels, REPO: "owner/repo", PR_NUMBER: "42" },
      });
      expect(result.status, result.stderr).toBe(status);
      expect(readFileSync(log, "utf8").includes("--paginate")).toBe(reads);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
