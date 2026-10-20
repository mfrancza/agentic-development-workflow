import { beforeEach, describe, expect, it, vi } from "vitest";

const { listReviews, listPulls, getPull, createCheck, paginate, listMembersInOrg } = vi.hoisted(() => ({
  listReviews: vi.fn(), listPulls: vi.fn(), getPull: vi.fn(), createCheck: vi.fn(), paginate: vi.fn(), listMembersInOrg: vi.fn(),
}));
vi.mock("@actions/core", () => ({ getInput: vi.fn().mockReturnValue(""), error: vi.fn(), setFailed: vi.fn() }));
vi.mock("@actions/github", () => ({ getOctokit: vi.fn().mockReturnValue({ paginate, rest: { pulls: { listReviews, list: listPulls, get: getPull }, checks: { create: createCheck }, teams: { listMembersInOrg } } }) }));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { run } from "../src/check-protected-approval-gate.js";

function mockInputs(overrides: Record<string, string> = {}) {
  const inputs: Record<string, string> = {
    protected_pr_author_logins: '["developer[bot]", "other[bot]"]', required_approval_count: "2", enabled: "true",
    pr_number: "42", pr_author: "ignored", head_sha: "event-sha", repo: "owner/repo", departed_sha: "", departed_pr_number: "", ...overrides,
  };
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? "");
}
function pr(number: number, author: string, sha = "live-sha", state = "open") { return { number, user: { login: author }, head: { sha }, state }; }
function review(login: string, state: string) { return { user: { login }, state }; }
function callsFor(sha: string) { return createCheck.mock.calls.filter(([input]) => input.head_sha === sha).map(([input]) => input); }

describe("check-protected-approval-gate", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("GITHUB_TOKEN", "test-token"); mockInputs();
    getPull.mockResolvedValue({ data: pr(42, "developer[bot]") });
    listPulls.mockResolvedValue({ data: [pr(42, "developer[bot]")] });
    listReviews.mockResolvedValue({ data: [] }); createCheck.mockResolvedValue({});
    paginate.mockResolvedValue([]);
  });

  it("uses the fixed enforcing context and the live, not event, head SHA", async () => {
    await run();
    expect(createCheck).toHaveBeenCalledWith(expect.objectContaining({ name: "protected-approval-gate", head_sha: "live-sha", conclusion: "failure" }));
    expect(getPull).toHaveBeenCalledWith({ owner: "owner", repo: "repo", pull_number: 42 });
  });

  it("does not publish the enforcing context when disabled", async () => {
    mockInputs({ enabled: "false" }); listReviews.mockResolvedValue({ data: [review("alice", "APPROVED"), review("bob", "APPROVED")] });
    await run();
    expect(createCheck).toHaveBeenCalledWith(expect.objectContaining({ name: "protected-approval-gate (preview)", conclusion: "success" }));
    expect(createCheck).not.toHaveBeenCalledWith(expect.objectContaining({ name: "protected-approval-gate" }));
  });

  it.each([
    ["zero approvals", [], "failure"], ["one approval", [review("alice", "APPROVED")], "failure"],
    ["two approvals", [review("alice", "APPROVED"), review("bob", "APPROVED")], "success"],
    ["a later comment preserves an approval", [review("alice", "APPROVED"), review("alice", "COMMENTED"), review("bob", "APPROVED")], "success"],
    ["a later dismissal removes an approval", [review("alice", "APPROVED"), review("alice", "DISMISSED"), review("bob", "APPROVED")], "failure"],
  ])("evaluates %s using latest opinionated reviews", async (_name, reviews, conclusion) => {
    listReviews.mockResolvedValue({ data: reviews }); await run(); expect(callsFor("live-sha")[0].conclusion).toBe(conclusion);
  });

  it("applies custom thresholds and self-excludes the author of each protected PR", async () => {
    mockInputs({ required_approval_count: "1" }); listReviews.mockResolvedValue({ data: [review("other[bot]", "APPROVED"), review("alice", "APPROVED")] });
    await run(); expect(callsFor("live-sha")[0].conclusion).toBe("success");
    getPull.mockResolvedValue({ data: pr(42, "other[bot]") }); listPulls.mockResolvedValue({ data: [pr(42, "other[bot]")] }); listReviews.mockResolvedValue({ data: [review("other[bot]", "APPROVED")] });
    await run(); expect(callsFor("live-sha")[1].conclusion).toBe("failure");
  });

  it.each([
    ["malformed JSON", { protected_pr_author_logins: "nope" }], ["empty list", { protected_pr_author_logins: "[]" }],
    ["duplicate login", { protected_pr_author_logins: '["developer[bot]", "developer[bot]"]' }], ["empty login", { protected_pr_author_logins: '["developer[bot]", " "]' }],
    ["zero threshold", { required_approval_count: "0" }], ["non-integer threshold", { required_approval_count: "1.5" }],
  ])("fails every PR visibly for %s", async (_name, inputs) => {
    mockInputs(inputs); await expect(run()).rejects.toThrow();
    expect(createCheck).toHaveBeenCalledWith(expect.objectContaining({ name: "protected-approval-gate", conclusion: "failure", head_sha: "live-sha" }));
    expect(core.error).toHaveBeenCalled();
  });

  it("uses paginated open PR listing and publishes the strictest shared-SHA result", async () => {
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({ data: pull_number === 42 ? pr(42, "human") : pr(43, "developer[bot]") }));
    listPulls.mockResolvedValue({ data: [pr(42, "human"), pr(43, "developer[bot]")] }); listReviews.mockResolvedValue({ data: [] });
    await run();
    expect(listPulls).toHaveBeenCalledWith({ owner: "owner", repo: "repo", state: "open", per_page: 100, page: 1 });
    expect(callsFor("live-sha")[0].conclusion).toBe("failure");
  });

  it("fails closed when open-PR listing fails", async () => {
    listPulls.mockRejectedValue(new Error("listing unavailable")); await expect(run()).rejects.toThrow("listing unavailable");
    expect(callsFor("live-sha")[0]).toEqual(expect.objectContaining({ conclusion: "failure" }));
  });

  it("reconciles a departed SHA while excluding the departed pull request", async () => {
    mockInputs({ departed_sha: "old-sha", departed_pr_number: "42" });
    getPull.mockImplementation(async ({ pull_number }: { pull_number: number }) => ({ data: pull_number === 42 ? pr(42, "developer[bot]", "live-sha") : pr(43, "human", "old-sha") }));
    listPulls.mockImplementation(async ({ page }: { page: number }) => ({ data: page === 1 ? [pr(42, "developer[bot]", "live-sha"), pr(43, "human", "old-sha")] : [] }));
    await run(); expect(callsFor("old-sha")[0]).toEqual(expect.objectContaining({ conclusion: "success" }));
  });

  describe("qualifying reviewers", () => {
    const twoApprovals = [review("alice", "APPROVED"), review("Bob", "APPROVED")];

    it("counts only approvals from listed logins, case-insensitively", async () => {
      mockInputs({ qualifying_reviewers: '["alice"]' }); listReviews.mockResolvedValue({ data: twoApprovals });
      await run(); expect(callsFor("live-sha")[0]).toEqual(expect.objectContaining({ conclusion: "failure" }));
      mockInputs({ qualifying_reviewers: '["alice", "bob"]' });
      await run(); expect(callsFor("live-sha")[1]).toEqual(expect.objectContaining({ conclusion: "success" }));
    });

    it("never counts the PR author, even when listed", async () => {
      mockInputs({ qualifying_reviewers: '["developer[bot]", "alice"]' });
      listReviews.mockResolvedValue({ data: [review("developer[bot]", "APPROVED"), review("alice", "APPROVED")] });
      await run(); expect(callsFor("live-sha")[0].conclusion).toBe("failure");
    });

    it("expands team references with the resolver token for the repository owner's organization", async () => {
      mockInputs({ qualifying_reviewers: '["owner/maintainers"]', resolver_token: "resolver-token" });
      paginate.mockResolvedValue([{ login: "alice" }, { login: "bob" }]);
      listReviews.mockResolvedValue({ data: twoApprovals });
      await run();
      expect(vi.mocked(github.getOctokit)).toHaveBeenCalledWith("resolver-token");
      expect(paginate).toHaveBeenCalledWith(listMembersInOrg, { org: "owner", team_slug: "maintainers" });
      expect(callsFor("live-sha")[0].conclusion).toBe("success");
    });

    it.each([
      ["no resolver token", { qualifying_reviewers: '["owner/maintainers"]' }, "no allowlist-resolver token"],
      ["a cross-organization team", { qualifying_reviewers: '["other-org/maintainers"]', resolver_token: "resolver-token" }, "other-org/maintainers"],
    ])("fails protected PRs closed with %s", async (_name, inputs, message) => {
      mockInputs(inputs); listReviews.mockResolvedValue({ data: twoApprovals });
      await run();
      expect(callsFor("live-sha")[0]).toEqual(expect.objectContaining({ conclusion: "failure", output: expect.objectContaining({ summary: expect.stringContaining(message) }) }));
      expect(core.error).toHaveBeenCalledWith(expect.stringContaining(message));
    });

    it("fails protected PRs closed when a team lookup fails", async () => {
      mockInputs({ qualifying_reviewers: '["owner/maintainers"]', resolver_token: "resolver-token" });
      paginate.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
      listReviews.mockResolvedValue({ data: twoApprovals });
      await run(); expect(callsFor("live-sha")[0].conclusion).toBe("failure");
    });

    it("does not affect PRs from unprotected authors when the list cannot be resolved", async () => {
      mockInputs({ qualifying_reviewers: '["owner/maintainers"]' });
      getPull.mockResolvedValue({ data: pr(42, "human") }); listPulls.mockResolvedValue({ data: [pr(42, "human")] });
      await run(); expect(callsFor("live-sha")[0].conclusion).toBe("success");
    });

    it.each([
      ["malformed JSON", "nope"], ["a non-array", '"alice"'], ["an empty entry", '["alice", " "]'],
      ["a malformed team reference", '["owner/team/extra"]'], ["a duplicate entry", '["alice", "ALICE"]'],
    ])("fails every PR visibly for %s", async (_name, list) => {
      mockInputs({ qualifying_reviewers: list }); await expect(run()).rejects.toThrow();
      expect(createCheck).toHaveBeenCalledWith(expect.objectContaining({ name: "protected-approval-gate", conclusion: "failure" }));
    });
  });

  it("uses the GitHub token and Checks API", async () => {
    await run(); expect(vi.mocked(github.getOctokit)).toHaveBeenCalledWith("test-token");
  });
});
