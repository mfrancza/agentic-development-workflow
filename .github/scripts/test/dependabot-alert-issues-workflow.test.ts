import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { getOctokit } from "../src/lib/octokit.js";
import { reconcile, ReconciliationError } from "../src/lib/dependabot-alert-issues.js";

vi.mock("@actions/core", () => ({ getInput: vi.fn(), info: vi.fn(), warning: vi.fn(), setOutput: vi.fn(), setFailed: vi.fn() }));
vi.mock("../src/lib/octokit.js", () => ({ getOctokit: vi.fn((token: string) => ({ token })) }));
vi.mock("../src/lib/dependabot-alert-issues.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/dependabot-alert-issues.js")>(),
  reconcile: vi.fn(),
}));

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/agent-dependabot-alert-issues.yml");
const wrapper = read(".github/actions/schedule-dependabot-alert-issues/action.yml");
const summary = { scanned: 2, eligible: 1, skipped: { "not-open": 1 }, existingOpen: 0, closedTombstone: 0, duplicates: 0,
  created: 1, groomingRepaired: 0, capacityDeferred: 0, staleOpen: 0, countedPrs: 0, reservations: 1, limit: 3 };

function gate(value: string): string {
  const script = workflow.match(/        run: \|\n((?:          .*\n)+)/)?.[1];
  if (!script) throw new Error("missing opt-in script");
  const directory = mkdtempSync(join(tmpdir(), "dependabot-gate-"));
  try {
    const output = join(directory, "output");
    const result = spawnSync("bash", ["-e", "-c", script], { env: { ...process.env, ENABLED: value, GITHUB_OUTPUT: output }, encoding: "utf8" });
    expect(result.status).toBe(0);
    try { return readFileSync(output, "utf8"); } catch { return ""; }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("scheduled workflow contract", () => {
  it("has only the requested schedule, least privilege and non-cancelling repository lock", () => {
    expect(workflow.match(/^on:\n([\s\S]*?)\n\S/m)?.[1]).toBe("  schedule:\n    - cron: '23 */6 * * *'\n");
    expect(workflow).toContain("permissions:\n  contents: read\n");
    expect(workflow).toContain("group: dependabot-alert-issues-${{ github.repository }}\n  cancel-in-progress: false");
    expect(workflow).toMatch(/timeout-minutes: (?:[1-9]|[12]\d|30)\n/);
  });

  it.each(["", "false", "TRUE", "True", " true", "true ", "1", "true\n"])('rejects opt-in %j before checkout or tokens', (value) => {
    expect(gate(value)).toBe("");
  });
  it("admits only exact true and gates every subsequent step", () => {
    expect(gate("true")).toBe("enabled=true\n");
    const steps = workflow.split(/\n      - name: /).slice(2);
    expect(steps).toHaveLength(4);
    for (const step of steps) expect(step).toContain("if: steps.opt-in.outputs.enabled == 'true'");
    expect(workflow.indexOf("id: opt-in")).toBeLessThan(workflow.indexOf("actions/checkout@"));
    expect(workflow).toContain("ref: ${{ github.sha }}\n          persist-credentials: false");
  });
  it("uses pinned actions and separates the reader and writer identities", () => {
    for (const uses of [...workflow.matchAll(/uses: ([^\s]+)/g), ...wrapper.matchAll(/uses: ([^\s]+)/g)]) {
      expect(uses[1]).toMatch(/^(?:\.\/|[^@]+@[0-9a-f]{40}$)/);
    }
    expect(workflow.match(/uses: \.\/\.github\/actions\/agent-token/g)).toHaveLength(2);
    expect(workflow).toContain("client-id: ${{ secrets.DEPENDABOT_READER_APP_ID }}");
    expect(workflow).toContain("private-key: ${{ secrets.DEPENDABOT_READER_APP_PRIVATE_KEY }}");
    expect(workflow).toContain("client-id: ${{ secrets.DEVELOPER_APP_ID }}");
    expect(workflow).toContain("private-key: ${{ secrets.DEVELOPER_APP_PRIVATE_KEY }}");
    expect(workflow).toContain("reader-token: ${{ steps.reader.outputs.token }}");
    expect(workflow).toContain("writer-token: ${{ steps.writer.outputs.token }}");
    expect(wrapper).toContain("INPUT_READER_TOKEN: ${{ inputs.reader-token }}");
    expect(wrapper).toContain("INPUT_WRITER_TOKEN: ${{ inputs.writer-token }}");
    expect(workflow + wrapper).not.toMatch(/run-agent|docker|AGENT_ACTION|agent:developer|workflow_call|workflow_dispatch/);
  });
  it("preserves the existing label, allowlist, and author gates", () => {
    const implement = read(".github/workflows/agent-implement.yml");
    const implementReusable = read(".github/workflows/agent-implement-reusable.yml");
    const autoTrigger = read(".github/workflows/agent-auto-trigger-reusable.yml");
    expect(implement).toContain("github.event.label.name == 'agent:developer'");
    expect(implementReusable).toContain("allowlist: ${{ vars.AGENT_ALLOWLIST }}");
    expect(implementReusable).toContain("needs.authorize.result == 'success'");
    expect(autoTrigger).toContain("allowlist: ${{ vars.AGENT_ALLOWLIST }}");
    expect(autoTrigger).toContain("contains(fromJSON(vars.AUTO_REVIEW_AUTHORS || '[]'), inputs.pr-author-login)");
    expect(autoTrigger).toContain("inputs.pr-author-login != inputs.developer-bot-login");
    expect(autoTrigger).toContain("<!-- authored-by-model:");
  });
});

describe("activity input and credential boundaries", () => {
  let inputs: Record<string, string>;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    inputs = { enabled: "true", max_open_prs: "3", reader_token: "reader", writer_token: "writer", repo_owner: "owner", repo_name: "repo" };
    vi.mocked(core.getInput).mockImplementation((name) => inputs[name] ?? "");
    vi.mocked(reconcile).mockResolvedValue(summary);
  });
  async function invoke(): Promise<void> {
    await import("../src/schedule-dependabot-alert-issues.js");
    await vi.waitFor(() => expect(vi.mocked(core.setOutput).mock.calls.length + vi.mocked(core.setFailed).mock.calls.length).toBeGreaterThan(0));
  }
  it.each(["", "false", "TRUE", " true", "true ", "1"])('rejects opt-in %j before any client or API call', async (enabled) => {
    inputs.enabled = enabled;
    await invoke();
    expect(getOctokit).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith("Dependabot issue reconciliation stopped: invalid-input");
  });
  it.each(["-1", "1.5", " 3", "3 ", "abc", "9007199254740992"])('rejects invalid capacity %j before API calls', async (limit) => {
    inputs.max_open_prs = limit;
    await invoke();
    expect(getOctokit).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalled();
  });
  it.each(["", "0", "3"])("passes capacity %j and distinct credentials to reconciliation", async (limit) => {
    inputs.max_open_prs = limit;
    await invoke();
    expect(core.getInput).toHaveBeenCalledWith("enabled", { trimWhitespace: false });
    expect(core.getInput).toHaveBeenCalledWith("max_open_prs", { trimWhitespace: false });
    expect(getOctokit).toHaveBeenNthCalledWith(1, "reader");
    expect(getOctokit).toHaveBeenNthCalledWith(2, "writer");
    expect(reconcile).toHaveBeenCalledWith({ reader: { token: "reader" }, writer: { token: "writer" }, contentReader: { token: "writer" }, owner: "owner", repo: "repo", limit });
    expect(core.setOutput).toHaveBeenCalledWith("skipped", '{"not-open":1}');
  });
  it("reports partial counts and a fixed failure reason without raw errors", async () => {
    vi.mocked(reconcile).mockRejectedValue(new ReconciliationError("inventory-failed", summary));
    await invoke();
    expect(core.setOutput).toHaveBeenCalledWith("created", "1");
    expect(core.setFailed).toHaveBeenCalledWith("Dependabot issue reconciliation stopped: inventory-failed");
  });
});
