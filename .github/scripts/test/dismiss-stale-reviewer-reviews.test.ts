import { describe, it, expect, vi } from "vitest";
import {
  fetchBotLogin,
  fetchAllReviews,
  filterStaleReviews,
  dismissReviews,
  type ReviewSummary,
} from "../src/dismiss-stale-reviewer-reviews.js";
import { getOctokit } from "../src/lib/octokit.js";

type OctokitType = ReturnType<typeof getOctokit>;

/** Build a minimal mock Octokit with stubs for the methods under test. */
function makeOctokit({
  graphql,
  listReviews,
  dismissReview,
}: {
  graphql?: ReturnType<typeof vi.fn>;
  listReviews?: ReturnType<typeof vi.fn>;
  dismissReview?: ReturnType<typeof vi.fn>;
} = {}): OctokitType {
  return {
    graphql: graphql ?? vi.fn(),
    rest: {
      pulls: {
        listReviews:
          listReviews ??
          vi.fn().mockResolvedValue({ data: [] }),
        dismissReview:
          dismissReview ??
          vi.fn().mockResolvedValue({}),
      },
    },
  } as unknown as OctokitType;
}

/** Build a ReviewSummary test fixture. */
function makeReview(
  id: number,
  userLogin: string | null,
  state: string
): ReviewSummary {
  return { id, userLogin, state };
}

// ---------------------------------------------------------------------------
// fetchBotLogin
// ---------------------------------------------------------------------------

describe("fetchBotLogin", () => {
  it("returns the viewer login on success", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ viewer: { login: "reviewer-bot[bot]" } });
    const octokit = makeOctokit({ graphql });

    const login = await fetchBotLogin(octokit);

    expect(login).toBe("reviewer-bot[bot]");
    expect(graphql).toHaveBeenCalledOnce();
  });

  it("returns null and does not throw when the query fails (fail-open)", async () => {
    const graphql = vi
      .fn()
      .mockRejectedValueOnce(new Error("GraphQL error"));
    const octokit = makeOctokit({ graphql });

    const login = await fetchBotLogin(octokit);

    expect(login).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchAllReviews
// ---------------------------------------------------------------------------

describe("fetchAllReviews", () => {
  it("returns an empty array when the PR has no reviews", async () => {
    const listReviews = vi
      .fn()
      .mockResolvedValueOnce({ data: [] });
    const octokit = makeOctokit({ listReviews });

    const reviews = await fetchAllReviews(octokit, "owner", "repo", 1);

    expect(reviews).toEqual([]);
    expect(listReviews).toHaveBeenCalledOnce();
  });

  it("returns all reviews from a single page (fewer than 100 items)", async () => {
    const listReviews = vi.fn().mockResolvedValueOnce({
      data: [
        { id: 1, user: { login: "bot[bot]" }, state: "CHANGES_REQUESTED" },
        { id: 2, user: { login: "human" }, state: "APPROVED" },
      ],
    });
    const octokit = makeOctokit({ listReviews });

    const reviews = await fetchAllReviews(octokit, "owner", "repo", 7);

    expect(reviews).toEqual([
      { id: 1, userLogin: "bot[bot]", state: "CHANGES_REQUESTED" },
      { id: 2, userLogin: "human", state: "APPROVED" },
    ]);
    expect(listReviews).toHaveBeenCalledOnce();
  });

  it("paginates across multiple pages and accumulates all reviews", async () => {
    // First page: exactly 100 items (triggers next-page fetch).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      user: { login: "bot[bot]" },
      state: "CHANGES_REQUESTED",
    }));
    // Second page: 1 item (signals last page).
    const page2 = [{ id: 101, user: { login: "human" }, state: "APPROVED" }];

    const listReviews = vi
      .fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    const octokit = makeOctokit({ listReviews });

    const reviews = await fetchAllReviews(octokit, "owner", "repo", 5);

    expect(reviews).toHaveLength(101);
    expect(listReviews).toHaveBeenCalledTimes(2);
    // Verify the page parameter increments correctly.
    expect(listReviews).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ page: 1 })
    );
    expect(listReviews).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2 })
    );
  });

  it("maps a null user to a null userLogin", async () => {
    const listReviews = vi.fn().mockResolvedValueOnce({
      data: [{ id: 99, user: null, state: "COMMENTED" }],
    });
    const octokit = makeOctokit({ listReviews });

    const reviews = await fetchAllReviews(octokit, "owner", "repo", 1);

    expect(reviews).toEqual([{ id: 99, userLogin: null, state: "COMMENTED" }]);
  });
});

// ---------------------------------------------------------------------------
// filterStaleReviews
// ---------------------------------------------------------------------------

describe("filterStaleReviews", () => {
  const BOT = "reviewer-bot[bot]";

  it("returns an empty array for an empty reviews list", () => {
    expect(filterStaleReviews([], BOT)).toEqual([]);
  });

  it("returns an empty array when no reviews are authored by the bot", () => {
    const reviews = [
      makeReview(1, "human", "CHANGES_REQUESTED"),
      makeReview(2, "other-bot[bot]", "CHANGES_REQUESTED"),
    ];
    expect(filterStaleReviews(reviews, BOT)).toEqual([]);
  });

  it("returns an empty array when the bot has reviews but none are CHANGES_REQUESTED", () => {
    const reviews = [
      makeReview(1, BOT, "APPROVED"),
      makeReview(2, BOT, "COMMENTED"),
      makeReview(3, BOT, "DISMISSED"),
    ];
    expect(filterStaleReviews(reviews, BOT)).toEqual([]);
  });

  it("skips a review already in DISMISSED state (already in target state)", () => {
    const reviews = [makeReview(1, BOT, "DISMISSED")];
    expect(filterStaleReviews(reviews, BOT)).toEqual([]);
  });

  it("returns the one matching review when exactly one qualifies", () => {
    const target = makeReview(42, BOT, "CHANGES_REQUESTED");
    const reviews = [
      makeReview(1, BOT, "APPROVED"),
      target,
      makeReview(2, "human", "CHANGES_REQUESTED"),
    ];
    expect(filterStaleReviews(reviews, BOT)).toEqual([target]);
  });

  it(
    "targets only CHANGES_REQUESTED among a mixed set of " +
      "APPROVED / COMMENTED / CHANGES_REQUESTED / DISMISSED",
    () => {
      const cr1 = makeReview(10, BOT, "CHANGES_REQUESTED");
      const cr2 = makeReview(11, BOT, "CHANGES_REQUESTED");
      const reviews = [
        makeReview(1, BOT, "APPROVED"),
        makeReview(2, BOT, "COMMENTED"),
        cr1,
        makeReview(3, BOT, "DISMISSED"),
        cr2,
        makeReview(4, "human", "CHANGES_REQUESTED"),
      ];
      expect(filterStaleReviews(reviews, BOT)).toEqual([cr1, cr2]);
    }
  );

  it("returns multiple matching reviews when several qualify", () => {
    const cr1 = makeReview(7, BOT, "CHANGES_REQUESTED");
    const cr2 = makeReview(8, BOT, "CHANGES_REQUESTED");
    expect(filterStaleReviews([cr1, cr2], BOT)).toEqual([cr1, cr2]);
  });
});

// ---------------------------------------------------------------------------
// dismissReviews
// ---------------------------------------------------------------------------

describe("dismissReviews", () => {
  const BOT = "reviewer-bot[bot]";

  it("returns empty arrays and makes no API calls for an empty input list", async () => {
    const dismissReview = vi.fn();
    const octokit = makeOctokit({ dismissReview });

    const result = await dismissReviews(octokit, "owner", "repo", 1, []);

    expect(result).toEqual({ dismissed: [], failed: [] });
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it("dismisses one matching review and records its ID", async () => {
    const dismissReview = vi.fn().mockResolvedValueOnce({});
    const octokit = makeOctokit({ dismissReview });
    const reviews = [makeReview(42, BOT, "CHANGES_REQUESTED")];

    const result = await dismissReviews(octokit, "owner", "repo", 7, reviews);

    expect(result.dismissed).toEqual([42]);
    expect(result.failed).toEqual([]);
    expect(dismissReview).toHaveBeenCalledOnce();
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        pull_number: 7,
        review_id: 42,
        message: "Superseded by re-review from this bot.",
      })
    );
  });

  it("dismisses multiple reviews in sequence", async () => {
    const dismissReview = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const octokit = makeOctokit({ dismissReview });
    const reviews = [
      makeReview(10, BOT, "CHANGES_REQUESTED"),
      makeReview(11, BOT, "CHANGES_REQUESTED"),
    ];

    const result = await dismissReviews(octokit, "owner", "repo", 3, reviews);

    expect(result.dismissed).toEqual([10, 11]);
    expect(result.failed).toEqual([]);
    expect(dismissReview).toHaveBeenCalledTimes(2);
  });

  it(
    "fails open on an API error: logs the failure, " +
      "continues with remaining reviews, and records both outcomes",
    async () => {
      const dismissReview = vi
        .fn()
        .mockRejectedValueOnce(new Error("403 Forbidden"))
        .mockResolvedValueOnce({});
      const octokit = makeOctokit({ dismissReview });
      const reviews = [
        makeReview(20, BOT, "CHANGES_REQUESTED"),
        makeReview(21, BOT, "CHANGES_REQUESTED"),
      ];

      const result = await dismissReviews(
        octokit,
        "owner",
        "repo",
        9,
        reviews
      );

      // First dismissal failed; second succeeded.
      expect(result.failed).toEqual([20]);
      expect(result.dismissed).toEqual([21]);
      // Both reviews were attempted.
      expect(dismissReview).toHaveBeenCalledTimes(2);
    }
  );
});
