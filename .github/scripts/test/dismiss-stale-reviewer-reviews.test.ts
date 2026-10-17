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

/** Build a ReviewSummary test fixture. commitId defaults to a SHA that is
 * considered "old" (not the current head) so existing tests remain valid
 * when a specific commitId is not relevant to the scenario under test. */
function makeReview(
  id: number,
  userLogin: string | null,
  state: string,
  commitId: string = "old-sha-aaaaaa"
): ReviewSummary {
  return { id, userLogin, state, commitId };
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
        { id: 1, user: { login: "bot[bot]" }, state: "CHANGES_REQUESTED", commit_id: "sha-abc" },
        { id: 2, user: { login: "human" }, state: "APPROVED", commit_id: "sha-def" },
      ],
    });
    const octokit = makeOctokit({ listReviews });

    const reviews = await fetchAllReviews(octokit, "owner", "repo", 7);

    expect(reviews).toEqual([
      { id: 1, userLogin: "bot[bot]", state: "CHANGES_REQUESTED", commitId: "sha-abc" },
      { id: 2, userLogin: "human", state: "APPROVED", commitId: "sha-def" },
    ]);
    expect(listReviews).toHaveBeenCalledOnce();
  });

  it("paginates across multiple pages and accumulates all reviews", async () => {
    // First page: exactly 100 items (triggers next-page fetch).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      user: { login: "bot[bot]" },
      state: "CHANGES_REQUESTED",
      commit_id: `sha-${i}`,
    }));
    // Second page: 1 item (signals last page).
    const page2 = [{ id: 101, user: { login: "human" }, state: "APPROVED", commit_id: "sha-100" }];

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
    // Spot-check that commitId is mapped from commit_id.
    expect(reviews[0].commitId).toBe("sha-0");
    expect(reviews[100].commitId).toBe("sha-100");
  });

  it("maps a null user to a null userLogin", async () => {
    const listReviews = vi.fn().mockResolvedValueOnce({
      data: [{ id: 99, user: null, state: "COMMENTED", commit_id: "sha-xyz" }],
    });
    const octokit = makeOctokit({ listReviews });

    const reviews = await fetchAllReviews(octokit, "owner", "repo", 1);

    expect(reviews).toEqual([{ id: 99, userLogin: null, state: "COMMENTED", commitId: "sha-xyz" }]);
  });

  it("returns an empty array and does not throw when the API call fails (fail-open)", async () => {
    const listReviews = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"));
    const octokit = makeOctokit({ listReviews });

    const reviews = await fetchAllReviews(octokit, "owner", "repo", 5);

    expect(reviews).toEqual([]);
    expect(listReviews).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// filterStaleReviews
// ---------------------------------------------------------------------------

describe("filterStaleReviews", () => {
  const BOT = "reviewer-bot[bot]";
  const HEAD_SHA = "current-sha-111111";
  const OLD_SHA = "old-sha-aaaaaa";

  it("returns an empty array for an empty reviews list", () => {
    expect(filterStaleReviews([], BOT, HEAD_SHA)).toEqual([]);
  });

  it("returns an empty array when no reviews are authored by the bot", () => {
    const reviews = [
      makeReview(1, "human", "CHANGES_REQUESTED", OLD_SHA),
      makeReview(2, "other-bot[bot]", "CHANGES_REQUESTED", OLD_SHA),
    ];
    expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([]);
  });

  it("returns an empty array when the bot has reviews but none are CHANGES_REQUESTED", () => {
    const reviews = [
      makeReview(1, BOT, "APPROVED", OLD_SHA),
      makeReview(2, BOT, "COMMENTED", OLD_SHA),
      makeReview(3, BOT, "DISMISSED", OLD_SHA),
    ];
    expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([]);
  });

  it("skips a review already in DISMISSED state (already in target state)", () => {
    const reviews = [makeReview(1, BOT, "DISMISSED", OLD_SHA)];
    expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([]);
  });

  it("returns the one matching review when exactly one qualifies", () => {
    const target = makeReview(42, BOT, "CHANGES_REQUESTED", OLD_SHA);
    const reviews = [
      makeReview(1, BOT, "APPROVED", OLD_SHA),
      target,
      makeReview(2, "human", "CHANGES_REQUESTED", OLD_SHA),
    ];
    expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([target]);
  });

  it(
    "targets only CHANGES_REQUESTED among a mixed set of " +
      "APPROVED / COMMENTED / CHANGES_REQUESTED / DISMISSED",
    () => {
      const cr1 = makeReview(10, BOT, "CHANGES_REQUESTED", OLD_SHA);
      const cr2 = makeReview(11, BOT, "CHANGES_REQUESTED", OLD_SHA);
      const reviews = [
        makeReview(1, BOT, "APPROVED", OLD_SHA),
        makeReview(2, BOT, "COMMENTED", OLD_SHA),
        cr1,
        makeReview(3, BOT, "DISMISSED", OLD_SHA),
        cr2,
        makeReview(4, "human", "CHANGES_REQUESTED", OLD_SHA),
      ];
      expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([cr1, cr2]);
    }
  );

  it("returns multiple matching reviews when several qualify", () => {
    const cr1 = makeReview(7, BOT, "CHANGES_REQUESTED", OLD_SHA);
    const cr2 = makeReview(8, BOT, "CHANGES_REQUESTED", OLD_SHA);
    expect(filterStaleReviews([cr1, cr2], BOT, HEAD_SHA)).toEqual([cr1, cr2]);
  });

  // -------------------------------------------------------------------------
  // SHA-filter: only old-SHA reviews are dismissed; current-SHA reviews are
  // preserved (sibling-leg race safety, Issue #449 Decision 4c).
  // -------------------------------------------------------------------------

  it(
    "dismisses only old-SHA CHANGES_REQUESTED reviews in a mixed set of " +
      "old and current head SHAs",
    () => {
      // Reviews against the OLD SHA — eligible for dismissal.
      const oldCr1 = makeReview(10, BOT, "CHANGES_REQUESTED", OLD_SHA);
      const oldCr2 = makeReview(11, BOT, "CHANGES_REQUESTED", OLD_SHA);
      // Review against the CURRENT HEAD SHA — must NOT be dismissed
      // (it may have been posted by a sibling leg for this exact head).
      const currentCr = makeReview(12, BOT, "CHANGES_REQUESTED", HEAD_SHA);
      // Approved review on the old SHA — not CHANGES_REQUESTED, should be skipped.
      const oldApproved = makeReview(13, BOT, "APPROVED", OLD_SHA);

      const reviews = [oldCr1, oldApproved, currentCr, oldCr2];
      expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([oldCr1, oldCr2]);
    }
  );

  it(
    "sibling-leg race: a CHANGES_REQUESTED review on the current head SHA " +
      "is NOT dismissed",
    () => {
      // A sibling matrix leg just posted this verdict against the current head SHA.
      const siblingReview = makeReview(99, BOT, "CHANGES_REQUESTED", HEAD_SHA);
      expect(filterStaleReviews([siblingReview], BOT, HEAD_SHA)).toEqual([]);
    }
  );

  it(
    "returns an empty array when all bot CHANGES_REQUESTED reviews are on " +
      "the current head SHA (nothing stale to dismiss)",
    () => {
      const reviews = [
        makeReview(1, BOT, "CHANGES_REQUESTED", HEAD_SHA),
        makeReview(2, BOT, "CHANGES_REQUESTED", HEAD_SHA),
        makeReview(3, "human", "CHANGES_REQUESTED", OLD_SHA),
      ];
      expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([]);
    }
  );

  it(
    "dismisses old-SHA reviews while preserving current-SHA reviews, " +
      "regardless of non-CHANGES_REQUESTED states on the current SHA",
    () => {
      const stale = makeReview(5, BOT, "CHANGES_REQUESTED", OLD_SHA);
      const reviews = [
        stale,
        makeReview(6, BOT, "APPROVED", HEAD_SHA),
        makeReview(7, BOT, "COMMENTED", HEAD_SHA),
        makeReview(8, BOT, "CHANGES_REQUESTED", HEAD_SHA),
      ];
      expect(filterStaleReviews(reviews, BOT, HEAD_SHA)).toEqual([stale]);
    }
  );
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
