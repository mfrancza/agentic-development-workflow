import { beforeEach, describe, expect, it, vi } from "vitest";

const { listReviews, listPulls, getPull, listWorkflowRuns, listJobs, reRunWorkflow, paginate, listMembersInOrg, summaryAddHeading, summaryAddRaw, summaryWrite } = vi.hoisted(() => {
  const summaryWrite = vi.fn().mockResolvedValue(undefined);
  return {
    listReviews: vi.fn(), listPulls: vi.fn(), getPull: vi.fn(),
    listWorkflowRuns: vi.fn(), listJobs: vi.fn(), reRunWorkflow: vi.fn(),
    paginate: vi.fn(), listMembersInOrg: vi.fn(),
    summaryAddHeading: vi.fn(), summaryAddRaw: vi.fn(), summaryWrite,
  };
});

vi.mock("@actions/core", () => {
  const summary = { addHeading: summaryAddHeading, addRaw: summaryAddRaw, write: summaryWrite };
  summaryAddHeading.mockImplementation(() => summary);
  summaryAddRaw.mockImplementation(() => summary);
  return {
    getInput: vi.fn().mockReturnValue(""),
    error: vi.fn(),
    warning: vi.fn(),
    notice: vi.fn(),
    info: vi.fn(),
    setFailed: vi.fn(),
    summary,
  };
});
vi.mock("@actions/github", () => ({
  getOctokit: vi.fn().mockReturnValue({
    paginate, rest: {
      pulls: { listReviews, list: listPulls, get: getPull },
      actions: { listWorkflowRuns, listJobsForWorkflowRun: listJobs, reRunWorkflow },
      teams: { listMembersInOrg },
    },
  }),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { run } from "../src/check-protected-approval-gate.js";

function mockInputs(overrides: Record<string, string> = {}) {
  const inputs: Record<string, string> = {
    protected_pr_author_logins: '["developer[bot]", "other[bot]"]', required_approval_count: "2", enabled: "true",
    pr_number: "42", repo: "owner/repo", departed_sha: "", departed_pr_number: "",
    publisher_workflow_file: "protected-approval-gate-publisher.yml",
    ...overrides,
  };
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? "");
}
function pr(number: number, author: string, sha = "live-sha", state = "open") { return { number, user: { login: author }, head: { sha }, state }; }
function review(login: string, state: string) { return { user: { login }, state }; }

describe("check-protected-approval-gate", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("GITHUB_TOKEN", "test-token"); mockInputs();
    getPull.mockResolvedValue({ data: pr(42, "developer[bot]") });
    listPulls.mockResolvedValue({ data: [pr(42, "developer[bot]")] });
    listReviews.mockResolvedValue({ data: [] });
    listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });
    listJobs.mockResolvedValue({ data: { jobs: [] } });
    reRunWorkflow.mockResolvedValue({});
    paginate.mockResolvedValue([]);
    summaryWrite.mockResolvedValue(undefined);
  });

  it("fetches the live head SHA from pulls.get, not from an event input", async () => {
    await run();
    expect(getPull).toHaveBeenCalledWith({ owner: "owner", repo: "repo", pull_number: 42 });
    // Failure (0 approvals) sets exit code via setFailed
    expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
  });

  it("exits non-zero (setFailed) when conclusion is failure", async () => {
    await run();
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledWith(expect.stringContaining("0 qualifying approval(s)"));
  });

  it("does not call setFailed when conclusion is success", async () => {
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    await run();
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    expect(vi.mocked(core.notice)).toHaveBeenCalled();
  });

  it("does not publish enforcing conclusion when disabled (preview mode still sets exit code)", async () => {
    mockInputs({ enabled: "false" });
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    await run();
    // Preview success: notice called, setFailed not called
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    expect(vi.mocked(core.notice)).toHaveBeenCalled();
  });

  it("writes the result to step summary", async () => {
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    await run();
    expect(summaryAddHeading).toHaveBeenCalledWith(expect.stringContaining("Approval gate"), expect.anything());
    expect(summaryWrite).toHaveBeenCalled();
  });

  it.each([
    ["zero approvals", [], "failure"], ["one approval", [review("alice", "APPROVED")], "failure"],
    ["two approvals", [review("alice", "APPROVED"), review("bob", "APPROVED")], "success"],
    ["a later comment preserves an approval", [review("alice", "APPROVED"), review("alice", "COMMENTED"), review("bob", "APPROVED")], "success"],
    ["a later dismissal removes an approval", [review("alice", "APPROVED"), review("alice", "DISMISSED"), review("bob", "APPROVED")], "failure"],
  ])("evaluates %s using latest opinionated reviews", async (_name, reviews, conclusion) => {
    listReviews.mockResolvedValue({ data: reviews }); await run();
    if (conclusion === "failure") {
      expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
    } else {
      expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    }
  });

  it("applies custom thresholds and self-excludes the author of each protected PR", async () => {
    mockInputs({ required_approval_count: "1" }); listReviews.mockResolvedValue({ data: [review("other[bot]", "APPROVED"), review("alice", "APPROVED")] });
    await run(); expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    vi.clearAllMocks();
    mockInputs({ required_approval_count: "1" });
    getPull.mockResolvedValue({ data: pr(42, "other[bot]") }); listPulls.mockResolvedValue({ data: [pr(42, "other[bot]")] }); listReviews.mockResolvedValue({ data: [review("other[bot]", "APPROVED")] });
    summaryWrite.mockResolvedValue(undefined);
    await run(); expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", { protected_pr_author_logins: "nope" }], ["empty list", { protected_pr_author_logins: "[]" }],
    ["duplicate login", { protected_pr_author_logins: '["developer[bot]", "developer[bot]"]' }], ["empty login", { protected_pr_author_logins: '["developer[bot]", " "]' }],
    ["zero threshold", { required_approval_count: "0" }], ["non-integer threshold", { required_approval_count: "1.5" }],
  ])("fails every PR visibly for %s", async (_name, inputs) => {
    mockInputs(inputs); await expect(run()).rejects.toThrow();
    expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
    expect(vi.mocked(core.error)).toHaveBeenCalled();
  });

  it("uses paginated open PR listing and publishes the strictest shared-SHA result", async () => {
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({ data: pull_number === 42 ? pr(42, "human") : pr(43, "developer[bot]") }));
    listPulls.mockResolvedValue({ data: [pr(42, "human"), pr(43, "developer[bot]")] }); listReviews.mockResolvedValue({ data: [] });
    await run();
    expect(listPulls).toHaveBeenCalledWith({ owner: "owner", repo: "repo", state: "open", per_page: 100, page: 1 });
    // developer[bot] on the same SHA has 0 approvals → strictest-wins → failure
    expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
  });

  it("fails closed when open-PR listing fails", async () => {
    listPulls.mockRejectedValue(new Error("listing unavailable")); await expect(run()).rejects.toThrow("listing unavailable");
    expect(vi.mocked(core.error)).toHaveBeenCalled();
  });

  it("falls back on a direct pulls.get when the listing omits the triggering PR (Decision 8 synchronize race)", async () => {
    // Simulate the race: listing returns empty but the triggering PR is open at liveHeadSha
    listPulls.mockResolvedValue({ data: [] });
    getPull.mockResolvedValue({ data: pr(42, "developer[bot]", "live-sha", "open") });
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    await run();
    // After fallback, PR 42 is included as a singleton candidate and evaluated
    expect(getPull).toHaveBeenCalledWith({ owner: "owner", repo: "repo", pull_number: 42 });
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });

  it("does not falsely pass when the fallback PR is not open at the live head SHA", async () => {
    // Listing empty AND the triggering PR has moved off the SHA (edge case)
    listPulls.mockResolvedValue({ data: [] });
    getPull.mockResolvedValue({ data: pr(42, "developer[bot]", "different-sha", "open") });
    await run();
    // Fallback PR fails the SHA check in evaluateSha → "none" candidates → failure
    expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
  });

  it("injects the fallback PR even when the listing is nonempty but omits it (mixed-list synchronize race)", async () => {
    // Simulate the mixed-list race: another PR (99) on live-sha was indexed first,
    // but the triggering protected PR (42) is absent from the listing.
    // Without the fix the gate would pass because PR 99 has an unprotected author.
    // With the fix PR 42 is injected and its 0 approvals drive a failure.
    listPulls.mockResolvedValue({ data: [pr(99, "human", "live-sha")] });
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({
      data: pull_number === 42 ? pr(42, "developer[bot]", "live-sha", "open") : pr(99, "human", "live-sha", "open"),
    }));
    listReviews.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({
      data: pull_number === 99 ? [{ user: { login: "alice" }, state: "APPROVED" }, { user: { login: "bob" }, state: "APPROVED" }] : [],
    }));
    await run();
    // PR 42 (developer[bot]) is injected into the candidate set and has 0 approvals →
    // strictest-wins → failure despite PR 99 having 2 approvals.
    expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
  });

  it("triggers departed-SHA sibling reruns for remaining open PRs on the old SHA", async () => {
    mockInputs({ departed_sha: "old-sha", departed_pr_number: "42" });
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({ data: pull_number === 43 ? pr(43, "human", "old-sha") : pr(42, "developer[bot]", "live-sha") }));
    listPulls.mockImplementation(async ({ page }: { page: number }) => ({
      data: page === 1 ? [pr(42, "developer[bot]", "live-sha"), pr(43, "human", "old-sha")] : [],
    }));
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [{ id: 999, head_sha: "old-sha", created_at: "2024-01-01T00:00:00Z", pull_requests: [{ number: 43 }] }] } });
    await run();
    expect(listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({ workflow_id: "protected-approval-gate-publisher.yml", event: "pull_request_target" }));
    expect(reRunWorkflow).toHaveBeenCalledWith({ owner: "owner", repo: "repo", run_id: 999 });
    expect(vi.mocked(core.notice)).toHaveBeenCalledWith(expect.stringContaining("PR #43"));
  });

  it("selects each sibling's current-head evaluated run independently", async () => {
    mockInputs({ departed_sha: "old-sha", departed_pr_number: "42" });
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({ data: pr(pull_number, "human", pull_number === 42 ? "live-sha" : "old-sha") }));
    listPulls.mockResolvedValue({ data: [pr(43, "human", "old-sha"), pr(44, "human", "old-sha")] });
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [
      { id: 101, head_sha: "old-sha", created_at: "2024-01-01T00:00:00Z", pull_requests: [{ number: 43 }] },
      { id: 102, head_sha: "old-sha", created_at: "2024-01-01T00:00:00Z", pull_requests: [{ number: 44 }] },
    ] } });
    listJobs.mockResolvedValue({ data: { jobs: [{ name: "protected-approval-gate (preview)", status: "completed", conclusion: "failure" }] } });
    await run();
    expect(reRunWorkflow.mock.calls.map(([args]) => args.run_id)).toEqual([101, 102]);
    expect(getPull).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 43 }));
    expect(getPull).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 44 }));
  });

  it("warns (does not fail) when a sibling's rerun API call errors", async () => {
    mockInputs({ departed_sha: "old-sha", departed_pr_number: "42" });
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({ data: pull_number === 43 ? pr(43, "human", "old-sha") : pr(42, "developer[bot]", "live-sha") }));
    listPulls.mockImplementation(async ({ page }: { page: number }) => ({
      data: page === 1 ? [pr(42, "developer[bot]", "live-sha"), pr(43, "human", "old-sha")] : [],
    }));
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [{ id: 999, head_sha: "old-sha", created_at: "2024-01-01T00:00:00Z", pull_requests: [{ number: 43 }] }] } });
    reRunWorkflow.mockRejectedValue(new Error("Forbidden"));
    await run();
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining("Rerun API error"));
    // Main result was success; do not fail the job over a sibling rerun error
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });

  it("warns (does not fail) when no prior publisher run exists for a sibling", async () => {
    mockInputs({ departed_sha: "old-sha", departed_pr_number: "42" });
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({ data: pull_number === 43 ? pr(43, "human", "old-sha") : pr(42, "developer[bot]", "live-sha") }));
    listPulls.mockImplementation(async ({ page }: { page: number }) => ({
      data: page === 1 ? [pr(42, "developer[bot]", "live-sha"), pr(43, "human", "old-sha")] : [],
    }));
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });
    await run();
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining("No prior pull_request_target publisher run"));
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });

  it("fails loudly when the departed-SHA sibling listing fails", async () => {
    mockInputs({ departed_sha: "old-sha", departed_pr_number: "42" });
    getPull.mockResolvedValue({ data: pr(42, "developer[bot]", "live-sha") });
    listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    let callCount = 0;
    listPulls.mockImplementation(async () => {
      callCount++;
      // First call (live SHA) returns live PR only; second call (departed SHA) throws
      if (callCount === 1) return { data: [pr(42, "developer[bot]", "live-sha")] };
      throw new Error("departed listing unavailable");
    });
    await expect(run()).rejects.toThrow("departed listing unavailable");
    expect(vi.mocked(core.error)).toHaveBeenCalledWith(expect.stringContaining("departed listing unavailable"));
  });

  it("does not trigger sibling reruns when disabled (preview mode)", async () => {
    mockInputs({ enabled: "false", departed_sha: "old-sha", departed_pr_number: "42" });
    getPull.mockResolvedValue({ data: pr(42, "developer[bot]", "live-sha") });
    listPulls.mockResolvedValue({ data: [pr(42, "developer[bot]", "live-sha"), pr(43, "human", "old-sha")] });
    listReviews.mockResolvedValue({ data: [] });
    await run();
    expect(listWorkflowRuns).not.toHaveBeenCalled();
    expect(reRunWorkflow).not.toHaveBeenCalled();
  });

  describe("qualifying reviewers", () => {
    const twoApprovals = [review("alice", "APPROVED"), review("Bob", "APPROVED")];

    it("counts only approvals from listed logins, case-insensitively", async () => {
      mockInputs({ qualifying_reviewers: '["alice"]' }); listReviews.mockResolvedValue({ data: twoApprovals });
      await run(); expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
      vi.clearAllMocks(); summaryWrite.mockResolvedValue(undefined);
      mockInputs({ qualifying_reviewers: '["alice", "bob"]' }); listReviews.mockResolvedValue({ data: twoApprovals });
      getPull.mockResolvedValue({ data: pr(42, "developer[bot]") }); listPulls.mockResolvedValue({ data: [pr(42, "developer[bot]")] });
      await run(); expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    });

    it("never counts the PR author, even when listed", async () => {
      mockInputs({ qualifying_reviewers: '["developer[bot]", "alice"]' });
      listReviews.mockResolvedValue({ data: [review("developer[bot]", "APPROVED"), review("alice", "APPROVED")] });
      await run(); expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
    });

    it("expands team references with the resolver token for the repository owner's organization", async () => {
      mockInputs({ qualifying_reviewers: '["owner/maintainers"]', resolver_token: "resolver-token" });
      paginate.mockResolvedValue([{ login: "alice" }, { login: "bob" }]);
      listReviews.mockResolvedValue({ data: twoApprovals });
      await run();
      expect(vi.mocked(github.getOctokit)).toHaveBeenCalledWith("resolver-token");
      expect(paginate).toHaveBeenCalledWith(listMembersInOrg, { org: "owner", team_slug: "maintainers" });
      expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    });

    it.each([
      ["no resolver token", { qualifying_reviewers: '["owner/maintainers"]' }, "no allowlist-resolver token"],
      ["a cross-organization team", { qualifying_reviewers: '["other-org/maintainers"]', resolver_token: "resolver-token" }, "other-org/maintainers"],
    ])("fails protected PRs closed with %s", async (_name, inputs, message) => {
      mockInputs(inputs); listReviews.mockResolvedValue({ data: twoApprovals });
      await run();
      // setFailed is called with the evaluateSha summary, which embeds the inner failure message
      expect(vi.mocked(core.setFailed)).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(vi.mocked(core.error)).toHaveBeenCalledWith(expect.stringContaining(message));
    });

    it("fails protected PRs closed when a team lookup fails", async () => {
      mockInputs({ qualifying_reviewers: '["owner/maintainers"]', resolver_token: "resolver-token" });
      paginate.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
      listReviews.mockResolvedValue({ data: twoApprovals });
      await run(); expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
    });

    it("does not affect PRs from unprotected authors when the list cannot be resolved", async () => {
      mockInputs({ qualifying_reviewers: '["owner/maintainers"]' });
      getPull.mockResolvedValue({ data: pr(42, "human") }); listPulls.mockResolvedValue({ data: [pr(42, "human")] });
      await run(); expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    });

    it.each([
      ["malformed JSON", "nope"], ["a non-array", '"alice"'], ["an empty entry", '["alice", " "]'],
      ["a malformed team reference", '["owner/team/extra"]'], ["a duplicate entry", '["alice", "ALICE"]'],
    ])("fails every PR visibly for %s", async (_name, list) => {
      mockInputs({ qualifying_reviewers: list }); await expect(run()).rejects.toThrow();
      expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
    });
  });

  it("uses the GitHub token from environment", async () => {
    await run(); expect(vi.mocked(github.getOctokit)).toHaveBeenCalledWith("test-token");
  });

  it("posts success for a non-protected author PR that is the sole open PR on its head", async () => {
    getPull.mockResolvedValue({ data: pr(42, "human") });
    listPulls.mockResolvedValue({ data: [pr(42, "human")] });
    await run();
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
    expect(vi.mocked(core.notice)).toHaveBeenCalled();
  });
});
