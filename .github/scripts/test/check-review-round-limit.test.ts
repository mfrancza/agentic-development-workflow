import { describe, expect, it, vi } from "vitest";
import { checkReviewRoundLimit, countRounds, DEFAULT_REVIEWERS, findEpoch, formatSummary, makeDependencies, parseLimit, parseLogins, type Dependencies, type Event, type Pull, type Review } from "../src/check-review-round-limit.js";
import type { getOctokit } from "../src/lib/octokit.js";

const date = "2026-01-02T00:00:00Z";
const initial = { id: "initial", at: null };
const review: Review = { id: 1, state: "CHANGES_REQUESTED", submitted_at: date, commit_id: "sha1", user: { login: "Copilot" }, html_url: "https://example/review/1" };
const pull: Pull = { state: "open", head: "sha1", author: "dev[bot]", authorType: "Bot", labels: [], assignees: [], url: "https://example/pr/1" };
const reset: Event = { id: 10, event: "unlabeled", created_at: date, actor: { type: "User" }, label: { name: "human-required" } };
const input = { limit: 1, reviewers: DEFAULT_REVIEWERS, runUrl: "https://example/run" };
function deps(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    getPull: vi.fn().mockResolvedValue(pull), getReview: vi.fn().mockResolvedValue(review), listEvents: vi.fn().mockResolvedValue([]),
    listReviews: vi.fn().mockResolvedValue([review]), feedback: vi.fn().mockResolvedValue({ proceed: true, reason: "actionable" }),
    addLabel: vi.fn().mockResolvedValue(undefined), assign: vi.fn().mockResolvedValue([]), threads: vi.fn().mockResolvedValue([]),
    listComments: vi.fn().mockResolvedValue([]), createComment: vi.fn().mockResolvedValue(undefined), updateComment: vi.fn().mockResolvedValue(undefined), warn: vi.fn(), ...overrides,
  };
}

describe("pure accounting", () => {
  it.each([["", 8], ["   ", 8], ["0", 0], [" 08 ", 8], ["9007199254740991", Number.MAX_SAFE_INTEGER]])("parses %j", (value, expected) => expect(parseLimit(value)).toBe(expected));
  it.each(["-1", "+1", "1.0", "1e2", "NaN", "9007199254740992"])("rejects %s", (value) => expect(() => parseLimit(value)).toThrow());
  it("accepts only explicit reviewer lists", () => {
    expect(parseLogins("", DEFAULT_REVIEWERS)).toEqual(DEFAULT_REVIEWERS);
    expect(parseLogins('["new[bot]"]', DEFAULT_REVIEWERS)).toEqual(["new[bot]"]);
    expect(() => parseLogins('{}', [])).toThrow();
    expect(() => parseLogins('[1]', [])).toThrow();
  });
  it("counts distinct submitted SHAs, including dismissed and matrix reviews, excluding author, humans and pending", () => {
    const entries: Review[] = [review, { ...review, id: 2, state: "DISMISSED" }, { ...review, id: 3, commit_id: "sha2", state: "APPROVED", user: { login: "COPILOT" } }, { ...review, id: 4, commit_id: "sha3", user: { login: "human" } }, { ...review, id: 5, commit_id: "sha4", user: { login: "DEV[bot]" } }, { ...review, id: 6, state: "PENDING", submitted_at: null, commit_id: null }];
    expect(countRounds(entries, [...DEFAULT_REVIEWERS, "dev[bot]"], "dev[bot]", initial)).toBe(2);
    expect(countRounds(entries, ["human"], "dev[bot]", initial)).toBe(1);
    expect(() => countRounds([{ ...review, commit_id: null }], DEFAULT_REVIEWERS, "dev", initial)).toThrow(/SHA/);
    expect(() => countRounds([{ ...review, user: null }], DEFAULT_REVIEWERS, "dev", initial)).toThrow(/author/);
  });
  it("uses latest human reset timestamp and ID, excludes equal timestamps and ignores bot resets", () => {
    const epoch = findEpoch([reset, { ...reset, id: 11 }, { ...reset, id: 12, actor: { type: "Bot" }, created_at: "2026-02-01T00:00:00Z" }]);
    expect(epoch).toEqual({ id: "11", at: date });
    expect(countRounds([review, { ...review, id: 2, commit_id: "new", submitted_at: "2026-01-02T00:00:01Z" }], DEFAULT_REVIEWERS, "dev", epoch)).toBe(1);
    expect(() => findEpoch([{ ...reset, actor: null }])).toThrow();
  });
  it("bounds and sanitizes thread summaries", () => {
    const summary = formatSummary(Array.from({ length: 25 }, (_, index) => ({ path: `file[${index}]`, url: `https://example/${index}` })), pull.url, "COMMENTED");
    expect(summary).toContain("25 unresolved");
    expect(summary).toContain("5 additional");
    expect(summary).not.toContain("https://example/20");
    expect(formatSummary([], pull.url, "CHANGES_REQUESTED")).toContain("top-level changes");
  });
});

describe("orchestration", () => {
  it("allows below threshold and stops at or above it", async () => {
    expect((await checkReviewRoundLimit({ ...input, limit: 2 }, deps())).proceed).toBe(true);
    const api = deps();
    expect(await checkReviewRoundLimit(input, api)).toMatchObject({ proceed: false, count: 1, epoch: initial });
    expect(api.addLabel).toHaveBeenCalledBefore(api.assign as ReturnType<typeof vi.fn>);
    expect(api.createComment).toHaveBeenCalledOnce();
    expect(await checkReviewRoundLimit({ ...input, limit: 1 }, deps({ listReviews: vi.fn().mockResolvedValue([review, { ...review, id: 2, commit_id: "old" }]) }))).toMatchObject({ proceed: false, count: 2 });
  });
  it("honors pause in unlimited and below-limit modes without notification", async () => {
    const api = deps({ getPull: vi.fn().mockResolvedValue({ ...pull, labels: ["human-required"] }) });
    expect(await checkReviewRoundLimit({ ...input, limit: 0 }, api)).toMatchObject({ proceed: false, limit: 0 });
    expect(api.listReviews).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
    expect((await checkReviewRoundLimit({ ...input, limit: 2 }, api)).reason).toMatch(/already present.*not reached/);
  });
  it("skips settled feedback and old or equal-trigger replays", async () => {
    const clean = deps({ feedback: vi.fn().mockResolvedValue({ proceed: false, reason: "clean" }) });
    expect((await checkReviewRoundLimit(input, clean)).reason).toBe("clean");
    expect(clean.addLabel).not.toHaveBeenCalled();
    const replay = deps({ listEvents: vi.fn().mockResolvedValue([reset]) });
    expect((await checkReviewRoundLimit(input, replay)).reason).toMatch(/predates/);
    expect(replay.listReviews).not.toHaveBeenCalled();
  });
  it("skips when feedback resolves or head changes while collecting", async () => {
    const feedback = vi.fn().mockResolvedValueOnce({ proceed: true, reason: "open" }).mockResolvedValueOnce({ proceed: false, reason: "resolved" });
    expect((await checkReviewRoundLimit(input, deps({ feedback }))).reason).toBe("resolved");
    const getPull = vi.fn().mockResolvedValueOnce(pull).mockResolvedValueOnce({ ...pull, head: "new" });
    expect((await checkReviewRoundLimit(input, deps({ getPull }))).reason).toMatch(/changed/);
  });
  it("recollects a changing epoch once and fails closed on repeated changes", async () => {
    const newer = { ...reset, created_at: "2026-01-01T00:00:00Z" };
    const events = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([newer]).mockResolvedValue([newer]);
    const api = deps({ listEvents: events });
    expect((await checkReviewRoundLimit({ ...input, limit: 2 }, api)).epoch?.id).toBe("10");
    expect(api.listReviews).toHaveBeenCalledTimes(2);
    const changing = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([newer]).mockResolvedValueOnce([newer]).mockResolvedValueOnce([]);
    await expect(checkReviewRoundLimit(input, deps({ listEvents: changing }))).rejects.toThrow(/changed repeatedly/);
  });
  it("repairs missing comments, updates only bot-authored markers, and ignores spoofing", async () => {
    const marker = "<!-- review-round-limit:v1 epoch=initial -->";
    const api = deps({ getPull: vi.fn().mockResolvedValue({ ...pull, labels: ["human-required"] }), listComments: vi.fn().mockResolvedValue([{ id: 7, author: "human", body: marker }]) });
    await checkReviewRoundLimit(input, api);
    expect(api.addLabel).not.toHaveBeenCalled();
    expect(api.createComment).toHaveBeenCalledOnce();
    const rerun = deps({ listComments: vi.fn().mockResolvedValue([{ id: 7, author: "human", body: marker }, { id: 8, author: "DEV[bot]", body: marker }]) });
    await checkReviewRoundLimit(input, rerun);
    expect(rerun.updateComment).toHaveBeenCalledWith(8, expect.stringContaining(marker));
    expect(rerun.createComment).not.toHaveBeenCalled();
  });
  it("fails closed on accounting, label, and comment failures; assignment and summary failures remain visible", async () => {
    for (const overrides of [{ listReviews: vi.fn().mockRejectedValue(new Error("reviews")) }, { addLabel: vi.fn().mockRejectedValue(new Error("label")) }, { createComment: vi.fn().mockRejectedValue(new Error("comment")) }]) {
      await expect(checkReviewRoundLimit(input, deps(overrides))).rejects.toThrow();
    }
    const api = deps({ assign: vi.fn().mockRejectedValue(new Error("assignment")), threads: vi.fn().mockRejectedValue(new Error("graphql")) });
    expect((await checkReviewRoundLimit(input, api)).proceed).toBe(false);
    expect(api.createComment).toHaveBeenCalledWith(expect.stringContaining("Assignment failed"));
    expect(api.createComment).toHaveBeenCalledWith(expect.stringContaining("summary unavailable"));
  });
});

describe("GitHub adapter", () => {
  it("paginates REST history and GraphQL threads and routes assignment failures", async () => {
    const listEvents = vi.fn();
    const listReviews = vi.fn();
    const listComments = vi.fn();
    const addAssignees = vi.fn().mockRejectedValue(new Error("not assignable"));
    const paginate = vi.fn(async (method: unknown, args: { per_page?: number }) => {
      expect(args.per_page).toBe(100);
      if (method === listEvents) return [reset, { ...reset, id: 11 }];
      if (method === listReviews) return [review, { ...review, id: 2, commit_id: "second-page" }];
      if (method === listComments) return [{ id: 3, user: { login: "dev[bot]" }, body: "marker" }];
      throw new Error("unexpected endpoint");
    });
    const graphql = vi.fn().mockResolvedValueOnce({ repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, path: "a", comments: { nodes: [{ url: "url1" }] } }], pageInfo: { hasNextPage: true, endCursor: "next" } } } } }).mockResolvedValueOnce({ repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, path: "b", comments: { nodes: [{ url: "url2" }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    const octokit = { paginate, graphql, rest: { pulls: { listReviews }, issues: { listEvents, listComments, checkUserCanBeAssigned: vi.fn().mockResolvedValue({}), addAssignees } } } as unknown as ReturnType<typeof getOctokit>;
    const api = makeDependencies({ octokit, owner: "org", repo: "repo", prNumber: 1, reviewId: 1, assignees: ["alice", "org/team"] });
    expect(await api.listEvents()).toHaveLength(2);
    expect(await api.listReviews()).toHaveLength(2);
    expect(await api.listComments()).toHaveLength(1);
    expect(await api.threads()).toEqual([{ path: "a", url: "url1" }, { path: "b", url: "url2" }]);
    const warnings = await api.assign(pull);
    expect(warnings.join(" ")).toMatch(/team expansion unavailable/i);
    expect(warnings.join(" ")).toMatch(/Unable to assign alice/);
  });
  it("uses the resolver for teams, preserves existing assignees, and reports capacity", async () => {
    const addAssignees = vi.fn().mockResolvedValue({});
    const octokit = { rest: { issues: { checkUserCanBeAssigned: vi.fn().mockResolvedValue({}), addAssignees } } } as unknown as ReturnType<typeof getOctokit>;
    const resolver = { paginate: vi.fn().mockResolvedValue([{ login: "Alice" }, { login: "Bob" }]), rest: { teams: { listMembersInOrg: vi.fn() } } } as unknown as ReturnType<typeof getOctokit>;
    const api = makeDependencies({ octokit, resolver, owner: "org", repo: "repo", prNumber: 1, reviewId: 1, assignees: ["org/team", "other/team"] });
    const warnings = await api.assign({ ...pull, assignees: ["alice", ...Array.from({ length: 9 }, (_, index) => `user${index}`)] });
    expect(addAssignees).not.toHaveBeenCalled();
    expect(warnings.join(" ")).toMatch(/capacity exceeded: Bob/);
    expect(warnings.join(" ")).toMatch(/cross_org/);
  });
});

describe("live feedback integration", () => {
  it("preserves stale, self-review, clean and fail-open feedback semantics", async () => {
    const graphql = vi.fn().mockResolvedValue({ repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    const octokit = { graphql, rest: { pulls: { listCommentsForReview: vi.fn() } } } as unknown as ReturnType<typeof getOctokit>;
    const api = makeDependencies({ octokit, owner: "org", repo: "repo", prNumber: 1, reviewId: 1, assignees: [] });
    expect((await api.feedback(pull, { ...review, commit_id: "old" })).proceed).toBe(false);
    expect((await api.feedback(pull, { ...review, user: { login: pull.author } })).proceed).toBe(false);
    expect((await api.feedback(pull, { ...review, state: "APPROVED" })).proceed).toBe(false);
    graphql.mockRejectedValue(new Error("unavailable"));
    expect((await api.feedback(pull, { ...review, state: "COMMENTED" })).proceed).toBe(true);
  });
  it("fails if an automated triggering review is missing from history", async () => {
    await expect(checkReviewRoundLimit(input, deps({ listReviews: vi.fn().mockResolvedValue([]) }))).rejects.toThrow(/missing from review history/);
  });
});

describe("boundary and recovery regressions", () => {
  it.each([[7, true], [8, false], [9, false]])("default limit handles %i distinct historical SHAs", async (count, proceed) => {
    const reviews = Array.from({ length: count }, (_, index) => ({ ...review, id: index + 1, commit_id: `sha${index + 1}` }));
    expect((await checkReviewRoundLimit({ ...input, limit: parseLimit("") }, deps({ listReviews: vi.fn().mockResolvedValue(reviews) }))).proceed).toBe(proceed);
  });
  it("repairs a comment after the label was written but the original comment failed", async () => {
    const failed = deps({ createComment: vi.fn().mockRejectedValue(new Error("write failed")) });
    await expect(checkReviewRoundLimit(input, failed)).rejects.toThrow(/write failed/);
    expect(failed.addLabel).toHaveBeenCalledOnce();
    const retry = deps({ getPull: vi.fn().mockResolvedValue({ ...pull, labels: ["human-required"] }) });
    expect((await checkReviewRoundLimit(input, retry)).proceed).toBe(false);
    expect(retry.addLabel).not.toHaveBeenCalled();
    expect(retry.assign).toHaveBeenCalledOnce();
    expect(retry.createComment).toHaveBeenCalledOnce();
  });
  it("rejects missing reset label metadata and missing trigger timestamp", async () => {
    expect(() => findEpoch([{ ...reset, label: null }])).toThrow(/removed label/);
    await expect(checkReviewRoundLimit(input, deps({ getReview: vi.fn().mockResolvedValue({ ...review, submitted_at: null }) }))).rejects.toThrow(/timestamp/);
  });
  it("warns about team expansion errors without losing explicit assignments", async () => {
    const assign = vi.fn().mockResolvedValue({});
    const octokit = { rest: { issues: { checkUserCanBeAssigned: vi.fn().mockResolvedValue({}), addAssignees: assign } } } as unknown as ReturnType<typeof getOctokit>;
    const resolver = { paginate: vi.fn().mockRejectedValue({ status: 403 }), rest: { teams: { listMembersInOrg: vi.fn() } } } as unknown as ReturnType<typeof getOctokit>;
    const api = makeDependencies({ octokit, resolver, owner: "org", repo: "repo", prNumber: 1, reviewId: 1, assignees: ["alice", "org/team"] });
    expect((await api.assign(pull)).join(" ")).toMatch(/forbidden/);
    expect(assign).toHaveBeenCalledWith(expect.objectContaining({ assignees: ["alice"] }));
  });
});
