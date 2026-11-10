import { describe, expect, it, vi } from "vitest";
import { checkReviewFreshness } from "../src/check-review-freshness.js";
import { checkReviewRoundLimit, DEFAULT_REVIEWERS, makeDependencies } from "../src/check-review-round-limit.js";
import type { getOctokit } from "../src/lib/octokit.js";

const input = { prNumber: 42, reviewId: 7, author: "mfrancza-reviewer-agent[bot]", reviewCommitId: "old" };
describe("post-lock freshness", () => {
  it("skips a stale bot with identifying details", async () => {
    const getHead = vi.fn().mockResolvedValue("new");
    const result = await checkReviewFreshness(input, getHead);
    expect(getHead).toHaveBeenCalledOnce();
    expect(result.proceed).toBe(false);
    for (const detail of ["after lock", "42", "7", input.author, "old", "new"]) expect(result.reason).toContain(detail);
  });
  it("allows a current bot and matches identity case-insensitively", async () => {
    expect((await checkReviewFreshness({ ...input, author: input.author.toUpperCase() }, async () => "old")).proceed).toBe(true);
  });
  it.each(["human", "other[bot]", "Copilot", "copilot-pull-request-reviewer[bot]"])("allows %s without a lookup", async (author) => {
    const getHead = vi.fn();
    expect((await checkReviewFreshness({ ...input, author }, getHead)).proceed).toBe(true);
    expect(getHead).not.toHaveBeenCalled();
  });
  it("fails open for blank reviewed or live SHAs and lookup errors", async () => {
    const getHead = vi.fn();
    expect((await checkReviewFreshness({ ...input, reviewCommitId: "  " }, getHead)).proceed).toBe(true);
    expect(getHead).not.toHaveBeenCalled();
    for (const head of ["", "  ", undefined]) expect((await checkReviewFreshness(input, async () => head)).proceed).toBe(true);
    expect((await checkReviewFreshness(input, async () => { throw new Error("temporary"); })).proceed).toBe(true);
  });
  it("continues to mandatory accounting after a transient failure, but accounting errors fail closed", async () => {
    const review = { id: 7, state: "CHANGES_REQUESTED", body: "", commit_id: "old", user: { login: input.author }, submitted_at: "2026-01-01T00:00:00Z" };
    const get = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue({ data: { state: "open", head: { sha: "new" }, user: { login: "dev", type: "Bot" }, labels: [], assignees: [], html_url: "url" } });
    const getReview = vi.fn().mockResolvedValue({ data: review });
    const listEvents = vi.fn();
    const listReviews = vi.fn();
    const paginate = vi.fn().mockImplementation(async (method) => method === listReviews ? [review] : []);
    const octokit = { rest: { pulls: { get, getReview, listReviews }, issues: { listEvents } }, paginate } as unknown as ReturnType<typeof getOctokit>;
    expect((await checkReviewFreshness(input, async () => (await octokit.rest.pulls.get({ owner: "org", repo: "repo", pull_number: 42 })).data.head.sha)).proceed).toBe(true);
    const deps = makeDependencies({ octokit, owner: "org", repo: "repo", prNumber: 42, reviewId: 7, assignees: [] });
    const options = { limit: 8, reviewers: DEFAULT_REVIEWERS, runUrl: "" };
    expect(await checkReviewRoundLimit(options, deps)).toMatchObject({ proceed: true, count: 1 });
    expect(paginate).toHaveBeenCalledWith(listReviews, expect.anything());
    get.mockRejectedValue(new Error("accounting unavailable"));
    await expect(checkReviewRoundLimit(options, deps)).rejects.toThrow("accounting unavailable");
  });
});
