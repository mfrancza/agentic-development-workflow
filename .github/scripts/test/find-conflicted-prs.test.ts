import { describe, it, expect, vi } from "vitest";
import {
  validatePrNumberInput,
  validateAuthorAllowlist,
  pollMergeability,
  listDeveloperAgentPrs,
  listAllOpenPrs,
  isSameRepoHead,
  enumerateInScopePrs,
  pollCandidatesWithBoundedConcurrency,
  findConflictedPrs,
  DEFAULT_DELAYS,
  MAX_SCAN_PAGES,
  MAX_CANDIDATES,
  noopRateLimiter,
} from "../src/find-conflicted-prs.js";
import { getOctokit } from "../src/lib/octokit.js";

type OctokitType = ReturnType<typeof getOctokit>;

/** Build a mock Octokit with only a graphql method. */
function makeGraphqlOctokit(graphql: ReturnType<typeof vi.fn>): OctokitType {
  return { graphql } as unknown as OctokitType;
}

/** Build a mock Octokit with only a REST search method. */
function makeSearchOctokit(search: ReturnType<typeof vi.fn>): OctokitType {
  return {
    graphql: vi.fn(),
    rest: { search: { issuesAndPullRequests: search } },
  } as unknown as OctokitType;
}

/** Build a mock Octokit with only a REST pulls.list method. */
function makePullsListOctokit(
  pullsList: ReturnType<typeof vi.fn>
): OctokitType {
  return {
    graphql: vi.fn(),
    rest: {
      search: { issuesAndPullRequests: vi.fn() },
      pulls: { list: pullsList, get: vi.fn() },
    },
  } as unknown as OctokitType;
}

/** Build a mock Octokit with only a REST pulls.get method. */
function makePullsGetOctokit(
  pullsGet: ReturnType<typeof vi.fn>
): OctokitType {
  return {
    graphql: vi.fn(),
    rest: {
      search: { issuesAndPullRequests: vi.fn() },
      pulls: { list: vi.fn(), get: pullsGet },
    },
  } as unknown as OctokitType;
}

/** Build a mock Octokit with both graphql and search (default-mode tests). */
function makeFullOctokit(
  graphql: ReturnType<typeof vi.fn>,
  search: ReturnType<typeof vi.fn>
): OctokitType {
  return {
    graphql,
    rest: {
      search: { issuesAndPullRequests: search },
      pulls: { list: vi.fn(), get: vi.fn() },
    },
  } as unknown as OctokitType;
}

/** Build a mock Octokit with graphql, pulls.list, and pulls.get (allowlist-mode tests). */
function makeFullOctokitWithPulls(
  graphql: ReturnType<typeof vi.fn>,
  pullsList: ReturnType<typeof vi.fn>,
  pullsGet: ReturnType<typeof vi.fn>
): OctokitType {
  return {
    graphql,
    rest: {
      search: { issuesAndPullRequests: vi.fn() },
      pulls: { list: pullsList, get: pullsGet },
    },
  } as unknown as OctokitType;
}

/** A sleep stub that resolves immediately without actually waiting. */
const noopSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// validatePrNumberInput
// ---------------------------------------------------------------------------

describe("validatePrNumberInput", () => {
  it("returns null for an empty string", () => {
    expect(validatePrNumberInput("")).toBeNull();
  });

  it("returns null for a string containing only CR/LF", () => {
    expect(validatePrNumberInput("\r\n")).toBeNull();
  });

  it("returns the parsed integer for a valid positive number", () => {
    expect(validatePrNumberInput("42")).toBe(42);
    expect(validatePrNumberInput("1")).toBe(1);
    expect(validatePrNumberInput("9999")).toBe(9999);
  });

  it("strips trailing CR/LF before validating", () => {
    expect(validatePrNumberInput("123\r\n")).toBe(123);
  });

  it("throws for zero", () => {
    expect(() => validatePrNumberInput("0")).toThrowError(
      "pr_number must be a positive integer with no leading zeros; got '0'"
    );
  });

  it("throws for a number with a leading zero", () => {
    expect(() => validatePrNumberInput("01")).toThrowError(
      "pr_number must be a positive integer with no leading zeros; got '01'"
    );
  });

  it("throws for a negative number", () => {
    expect(() => validatePrNumberInput("-1")).toThrowError(
      "pr_number must be a positive integer with no leading zeros"
    );
  });

  it("throws for non-numeric input", () => {
    expect(() => validatePrNumberInput("abc")).toThrowError(
      "pr_number must be a positive integer with no leading zeros"
    );
  });

  it("throws for floating-point input", () => {
    expect(() => validatePrNumberInput("1.5")).toThrowError(
      "pr_number must be a positive integer with no leading zeros"
    );
  });
});

// ---------------------------------------------------------------------------
// validateAuthorAllowlist
// ---------------------------------------------------------------------------

describe("validateAuthorAllowlist", () => {
  it("returns an empty array for '[]'", () => {
    expect(validateAuthorAllowlist("[]")).toEqual([]);
  });

  it("returns ['*'] for the wildcard-only entry", () => {
    expect(validateAuthorAllowlist('["*"]')).toEqual(["*"]);
  });

  it("returns an explicit list of logins", () => {
    expect(validateAuthorAllowlist('["alice", "bob"]')).toEqual(["alice", "bob"]);
  });

  it("throws for non-JSON input", () => {
    expect(() => validateAuthorAllowlist("not-json")).toThrowError(
      "RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST is not valid JSON"
    );
  });

  it("throws when the input is a JSON object (not an array)", () => {
    expect(() => validateAuthorAllowlist('{"key": "value"}')).toThrowError(
      "RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST must be a JSON array"
    );
  });

  it("throws when an array entry is not a string", () => {
    expect(() => validateAuthorAllowlist('[42]')).toThrowError(
      "RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST contains a non-string or empty-string entry at index 0"
    );
  });

  it("throws when an array entry is an empty string", () => {
    expect(() => validateAuthorAllowlist('["alice", ""]')).toThrowError(
      "RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST contains a non-string or empty-string entry at index 1"
    );
  });

  it("throws when wildcard appears alongside other entries", () => {
    expect(() => validateAuthorAllowlist('["*", "alice"]')).toThrowError(
      `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST: wildcard "*" may only appear as the sole entry`
    );
  });

  it("throws when there are duplicate entries (case-insensitive)", () => {
    expect(() => validateAuthorAllowlist('["Alice", "alice"]')).toThrowError(
      "RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST contains duplicate entries: alice"
    );
  });
});

// ---------------------------------------------------------------------------
// pollMergeability
// ---------------------------------------------------------------------------

describe("pollMergeability", () => {
  it("returns immediately when mergeability is known on the first attempt", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollMergeability(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      1,
      DEFAULT_DELAYS,
      sleep
    );

    expect(result).toBe("MERGEABLE");
    expect(graphql).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries when UNKNOWN and returns the settled value", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "UNKNOWN" } } })
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "CONFLICTING" } } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollMergeability(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      5,
      DEFAULT_DELAYS,
      sleep
    );

    expect(result).toBe("CONFLICTING");
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    // First sleep uses DEFAULT_DELAYS[0] converted to ms.
    expect(sleep).toHaveBeenCalledWith(DEFAULT_DELAYS[0]! * 1000);
  });

  it("returns UNKNOWN after exhausting all retries", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "UNKNOWN" } } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollMergeability(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      1,
      DEFAULT_DELAYS,
      sleep
    );

    expect(result).toBe("UNKNOWN");
    // Polls exactly delays.length times.
    expect(graphql).toHaveBeenCalledTimes(DEFAULT_DELAYS.length);
    // Sleeps between attempts but NOT after the last one.
    expect(sleep).toHaveBeenCalledTimes(DEFAULT_DELAYS.length - 1);
  });

  it("treats an API error as UNKNOWN and continues retrying", async () => {
    const graphql = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollMergeability(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      1,
      DEFAULT_DELAYS,
      sleep
    );

    expect(result).toBe("MERGEABLE");
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not sleep after the final attempt when all retries are exhausted", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "UNKNOWN" } } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    // Single-element delay array: one attempt, no sleep.
    const singleDelay = [5] as const;

    const result = await pollMergeability(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      1,
      singleDelay,
      sleep
    );

    expect(result).toBe("UNKNOWN");
    expect(graphql).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses the correct delay value at each retry position", async () => {
    const delays = [1, 2, 3] as const;
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "UNKNOWN" } } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await pollMergeability(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      1,
      delays,
      sleep
    );

    expect(sleep).toHaveBeenNthCalledWith(1, 1 * 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2 * 1000);
    // Third (last) attempt: no sleep.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// listDeveloperAgentPrs
// ---------------------------------------------------------------------------

describe("listDeveloperAgentPrs", () => {
  it("returns PR numbers extracted from search results", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [{ number: 10 }, { number: 20 }, { number: 30 }] },
      });

    const result = await listDeveloperAgentPrs(
      makeSearchOctokit(search),
      "owner",
      "repo",
      "app/mfrancza-developer-agent"
    );

    expect(result).toEqual([10, 20, 30]);
  });

  it("passes the correct search query to the API", async () => {
    const search = vi.fn().mockResolvedValueOnce({ data: { items: [] } });

    await listDeveloperAgentPrs(
      makeSearchOctokit(search),
      "myorg",
      "myrepo",
      "app/my-bot"
    );

    expect(search).toHaveBeenCalledWith({
      q: "is:pr is:open repo:myorg/myrepo author:app/my-bot",
      per_page: 100,
    });
  });

  it("returns an empty array when no PRs match", async () => {
    const search = vi.fn().mockResolvedValueOnce({ data: { items: [] } });

    const result = await listDeveloperAgentPrs(
      makeSearchOctokit(search),
      "owner",
      "repo",
      "app/mfrancza-developer-agent"
    );

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listAllOpenPrs
// ---------------------------------------------------------------------------

describe("listAllOpenPrs", () => {
  it("returns PR numbers extracted from REST pulls results", async () => {
    const pullsList = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ number: 1 }, { number: 2 }, { number: 3 }],
      });

    const result = await listAllOpenPrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo"
    );

    expect(result).toEqual([1, 2, 3]);
  });

  it("calls the REST Pulls API with owner/repo/state=open, starting at page 1", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({ data: [] });

    await listAllOpenPrs(makePullsListOctokit(pullsList), "myorg", "myrepo");

    expect(pullsList).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      state: "open",
      per_page: 100,
      page: 1,
    });
  });

  it("returns an empty array when no open PRs exist", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({ data: [] });

    const result = await listAllOpenPrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo"
    );

    expect(result).toEqual([]);
  });

  it("paginates through multiple pages to collect all PR numbers", async () => {
    const page1Items = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
    const page2Items = [{ number: 101 }, { number: 102 }];

    const pullsList = vi
      .fn()
      .mockResolvedValueOnce({ data: page1Items })
      .mockResolvedValueOnce({ data: page2Items });

    const result = await listAllOpenPrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo"
    );

    expect(result).toHaveLength(102);
    expect(result[0]).toBe(1);
    expect(result[99]).toBe(100);
    expect(result[100]).toBe(101);
    expect(result[101]).toBe(102);
    expect(pullsList).toHaveBeenCalledTimes(2);
    expect(pullsList).toHaveBeenNthCalledWith(1, {
      owner: "owner",
      repo: "repo",
      state: "open",
      per_page: 100,
      page: 1,
    });
    expect(pullsList).toHaveBeenNthCalledWith(2, {
      owner: "owner",
      repo: "repo",
      state: "open",
      per_page: 100,
      page: 2,
    });
  });

  it("paginates beyond 1,000 results (no hard cap unlike the Search API)", async () => {
    // Simulate 1,050 open PRs: 10 full pages of 100 + a partial page of 50.
    // This proves there is no 1,000-item ceiling equivalent to the old Search API cap.
    const fullPages = 10;
    const lastPageSize = 50;
    const pullsList = vi.fn();
    for (let p = 0; p < fullPages; p++) {
      const start = p * 100 + 1;
      const items = Array.from({ length: 100 }, (_, i) => ({ number: start + i }));
      pullsList.mockResolvedValueOnce({ data: items });
    }
    // Page 11: partial page — signals the last page and terminates pagination.
    const lastStart = fullPages * 100 + 1;
    const lastItems = Array.from({ length: lastPageSize }, (_, i) => ({ number: lastStart + i }));
    pullsList.mockResolvedValueOnce({ data: lastItems });

    const result = await listAllOpenPrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo"
    );

    expect(result).toHaveLength(1050);
    expect(pullsList).toHaveBeenCalledTimes(fullPages + 1);
    // Confirm PR numbers beyond the old 1,000-item Search API cap are present.
    expect(result[1000]).toBe(1001);
    expect(result[1049]).toBe(1050);
  });
});

// ---------------------------------------------------------------------------
// isSameRepoHead
// ---------------------------------------------------------------------------

describe("isSameRepoHead", () => {
  it("returns true when the PR head and base repos are the same", async () => {
    const pullsGet = vi.fn().mockResolvedValueOnce({
      data: {
        head: { repo: { full_name: "owner/repo" } },
        base: { repo: { full_name: "owner/repo" } },
      },
    });

    const result = await isSameRepoHead(
      makePullsGetOctokit(pullsGet),
      "owner",
      "repo",
      42
    );

    expect(result).toBe(true);
  });

  it("returns false when the PR head is from a fork (different full_name)", async () => {
    const pullsGet = vi.fn().mockResolvedValueOnce({
      data: {
        head: { repo: { full_name: "fork-owner/repo" } },
        base: { repo: { full_name: "owner/repo" } },
      },
    });

    const result = await isSameRepoHead(
      makePullsGetOctokit(pullsGet),
      "owner",
      "repo",
      7
    );

    expect(result).toBe(false);
  });

  it("returns false when head.repo is null (deleted fork)", async () => {
    const pullsGet = vi.fn().mockResolvedValueOnce({
      data: {
        head: { repo: null },
        base: { repo: { full_name: "owner/repo" } },
      },
    });

    const result = await isSameRepoHead(
      makePullsGetOctokit(pullsGet),
      "owner",
      "repo",
      99
    );

    expect(result).toBe(false);
  });

  it("calls the REST Pulls API with the correct parameters", async () => {
    const pullsGet = vi.fn().mockResolvedValueOnce({
      data: {
        head: { repo: { full_name: "myorg/myrepo" } },
        base: { repo: { full_name: "myorg/myrepo" } },
      },
    });

    await isSameRepoHead(makePullsGetOctokit(pullsGet), "myorg", "myrepo", 55);

    expect(pullsGet).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      pull_number: 55,
    });
  });
});

// ---------------------------------------------------------------------------
// enumerateInScopePrs
// ---------------------------------------------------------------------------

/** Build a PR item with all fields needed by enumerateInScopePrs. */
function makePrItem(
  number: number,
  headFullName: string | null,
  baseFullName: string,
  userLogin: string
) {
  return {
    number,
    head: { repo: headFullName ? { full_name: headFullName } : null },
    base: { repo: { full_name: baseFullName } },
    user: { login: userLogin },
  };
}

describe("enumerateInScopePrs", () => {
  it("returns all same-repo PRs for wildcard allowlist (no author filter)", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(1, "owner/repo", "owner/repo", "alice"),
        makePrItem(2, "owner/repo", "owner/repo", "bob"),
        makePrItem(3, "fork-owner/repo", "owner/repo", "carol"), // fork — excluded
      ],
    });

    const result = await enumerateInScopePrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo",
      "app/my-bot",
      ["*"],
      noopSleep,
      noopRateLimiter
    );

    // Fork PR #3 excluded; PRs #1 and #2 included regardless of author
    expect(result).toEqual([1, 2]);
  });

  it("includes developer-agent-bot login plus explicit logins for non-wildcard allowlist", async () => {
    // author = "app/my-bot" normalizes to "my-bot[bot]"
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(10, "owner/repo", "owner/repo", "my-bot[bot]"),   // agent bot — in
        makePrItem(20, "owner/repo", "owner/repo", "alice"),          // in explicit list — in
        makePrItem(30, "owner/repo", "owner/repo", "carol"),          // not in list — excluded
        makePrItem(40, "owner/repo", "owner/repo", "Bob"),            // case-insensitive match — in
      ],
    });

    const result = await enumerateInScopePrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo",
      "app/my-bot",
      ["alice", "bob"],
      noopSleep,
      noopRateLimiter
    );

    expect(result).toEqual([10, 20, 40]);
  });

  it("excludes PRs with null head.repo (deleted fork)", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(5, null, "owner/repo", "alice"),          // deleted fork — excluded
        makePrItem(6, "owner/repo", "owner/repo", "alice"),  // same-repo — included
      ],
    });

    const result = await enumerateInScopePrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo",
      "app/bot",
      ["*"],
      noopSleep,
      noopRateLimiter
    );

    expect(result).toEqual([6]);
  });

  it("stops and emits a warning when MAX_CANDIDATES is reached", async () => {
    // Create MAX_CANDIDATES + 10 same-repo PRs on a single page
    const items = Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) =>
      makePrItem(i + 1, "owner/repo", "owner/repo", "alice")
    );
    const pullsList = vi.fn().mockResolvedValueOnce({ data: items });

    const result = await enumerateInScopePrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo",
      "app/bot",
      ["*"],
      noopSleep,
      noopRateLimiter
    );

    // Should stop at exactly MAX_CANDIDATES
    expect(result).toHaveLength(MAX_CANDIDATES);
    // Should only have called the list API once (stopped mid-page)
    expect(pullsList).toHaveBeenCalledTimes(1);
  });

  it("stops and emits a warning after MAX_SCAN_PAGES pages", async () => {
    // Each page has 100 items (full page) so pagination continues
    const pullsList = vi.fn();
    for (let p = 0; p < MAX_SCAN_PAGES; p++) {
      // All items are forks so candidates array stays empty — this ensures
      // we exhaust page budget rather than candidate cap.
      const items = Array.from({ length: 100 }, (_, i) =>
        makePrItem(p * 100 + i + 1, "fork-owner/repo", "owner/repo", "alice")
      );
      pullsList.mockResolvedValueOnce({ data: items });
    }

    const result = await enumerateInScopePrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo",
      "app/bot",
      ["*"],
      noopSleep,
      noopRateLimiter
    );

    // All items were forks — no candidates collected
    expect(result).toEqual([]);
    // Should have fetched exactly MAX_SCAN_PAGES pages and stopped
    expect(pullsList).toHaveBeenCalledTimes(MAX_SCAN_PAGES);
  });

  it("paginates correctly across multiple pages", async () => {
    // Page 1: 100 items but all forks (so no candidates collected yet);
    // Page 2: 2 same-repo items (last page). This avoids hitting MAX_CANDIDATES
    // before the second page is fetched.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makePrItem(i + 1, "fork-owner/repo", "owner/repo", "alice")
    );
    const page2 = [
      makePrItem(101, "owner/repo", "owner/repo", "alice"),
      makePrItem(102, "owner/repo", "owner/repo", "alice"),
    ];
    const pullsList = vi
      .fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });

    const result = await enumerateInScopePrs(
      makePullsListOctokit(pullsList),
      "owner",
      "repo",
      "app/bot",
      ["*"],
      noopSleep,
      noopRateLimiter
    );

    // Only the 2 same-repo PRs from page 2 are collected
    expect(result).toHaveLength(2);
    expect(result).toEqual([101, 102]);
    expect(pullsList).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// pollCandidatesWithBoundedConcurrency
// ---------------------------------------------------------------------------

describe("pollCandidatesWithBoundedConcurrency", () => {
  it("returns CONFLICTING PRs from a small batch", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "MERGEABLE" } } })
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "CONFLICTING" } } })
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });

    const result = await pollCandidatesWithBoundedConcurrency(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      [1, 2, 3],
      [1] as const,
      noopSleep,
      noopRateLimiter
    );

    expect(result).toEqual([2]);
  });

  it("fires all PRs in a batch in parallel (single wave for immediate results)", async () => {
    // Track call order to verify parallel firing
    const callOrder: number[] = [];
    const graphql = vi.fn().mockImplementation((_query: string, vars: { number: number }) => {
      callOrder.push(vars.number);
      return Promise.resolve({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });
    });

    await pollCandidatesWithBoundedConcurrency(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      [10, 20, 30, 40, 50],
      [1] as const,
      noopSleep,
      noopRateLimiter
    );

    // All 5 PRs should be queried in a single wave
    expect(graphql).toHaveBeenCalledTimes(5);
    expect(callOrder.sort()).toEqual([10, 20, 30, 40, 50]);
  });

  it("processes candidates in batches of P=5", async () => {
    // 7 candidates: batch 1 = [1,2,3,4,5], batch 2 = [6,7]
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "CONFLICTING" } } });

    const result = await pollCandidatesWithBoundedConcurrency(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      [1, 2, 3, 4, 5, 6, 7],
      [1] as const,
      noopSleep,
      noopRateLimiter
    );

    // All 7 are CONFLICTING
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(graphql).toHaveBeenCalledTimes(7);
  });

  it("retries UNKNOWN PRs within a batch", async () => {
    // PR 1: UNKNOWN on attempt 1, CONFLICTING on attempt 2
    // PR 2: MERGEABLE on attempt 1
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "UNKNOWN" } } })    // PR 1, attempt 1
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "MERGEABLE" } } })  // PR 2, attempt 1
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "CONFLICTING" } } }); // PR 1, attempt 2

    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollCandidatesWithBoundedConcurrency(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      [1, 2],
      [5, 10] as const,
      sleep,
      noopRateLimiter
    );

    expect(result).toEqual([1]);
    // Sleep called once between wave 1 and wave 2
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("returns an empty array when all candidates are MERGEABLE", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });

    const result = await pollCandidatesWithBoundedConcurrency(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      [1, 2, 3],
      [1] as const,
      noopSleep,
      noopRateLimiter
    );

    expect(result).toEqual([]);
  });

  it("returns an empty array for an empty candidate list", async () => {
    const graphql = vi.fn();

    const result = await pollCandidatesWithBoundedConcurrency(
      makeGraphqlOctokit(graphql),
      "owner",
      "repo",
      [],
      [1] as const,
      noopSleep,
      noopRateLimiter
    );

    expect(result).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// findConflictedPrs — default behavior (authorAllowlist = [])
// ---------------------------------------------------------------------------

describe("findConflictedPrs", () => {
  it("returns only CONFLICTING PR numbers", async () => {
    const search = vi.fn().mockResolvedValueOnce({
      data: { items: [{ number: 1 }, { number: 2 }, { number: 3 }] },
    });
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "MERGEABLE" } } })
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "CONFLICTING" } } })
      .mockResolvedValueOnce({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });

    const result = await findConflictedPrs(
      makeFullOctokit(graphql, search),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep
    );

    expect(result).toEqual([2]);
  });

  it("returns an empty array when no developer-agent PRs are open", async () => {
    const search = vi.fn().mockResolvedValueOnce({ data: { items: [] } });
    const graphql = vi.fn();

    const result = await findConflictedPrs(
      makeFullOctokit(graphql, search),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep
    );

    expect(result).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("returns an empty array when no PRs are conflicting", async () => {
    const search = vi.fn().mockResolvedValueOnce({
      data: { items: [{ number: 1 }, { number: 2 }] },
    });
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });

    const result = await findConflictedPrs(
      makeFullOctokit(graphql, search),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep
    );

    expect(result).toEqual([]);
  });

  it("returns multiple conflicting PRs in enumeration order", async () => {
    const search = vi.fn().mockResolvedValueOnce({
      data: { items: [{ number: 5 }, { number: 10 }, { number: 15 }] },
    });
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "CONFLICTING" } } });

    const result = await findConflictedPrs(
      makeFullOctokit(graphql, search),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep
    );

    expect(result).toEqual([5, 10, 15]);
  });
});

// ---------------------------------------------------------------------------
// findConflictedPrs — allowlist mode (authorAllowlist non-empty)
// ---------------------------------------------------------------------------

describe("findConflictedPrs (authorAllowlist non-empty)", () => {
  it("enumerates all open PRs via the REST Pulls API for wildcard allowlist", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(1, "owner/repo", "owner/repo", "mfrancza-developer-agent[bot]"),
      ],
    });
    const pullsGet = vi.fn(); // should NOT be called in allowlist mode
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "CONFLICTING" } } });

    await findConflictedPrs(
      makeFullOctokitWithPulls(graphql, pullsList, pullsGet),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep,
      ["*"],
      noopRateLimiter
    );

    // Must call REST Pulls API (not Search API) with state=open, starting at page 1.
    expect(pullsList).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      state: "open",
      per_page: 100,
      page: 1,
    });
    // The new implementation does NOT call pullsGet — fork filter is integrated
    expect(pullsGet).not.toHaveBeenCalled();
  });

  it("returns CONFLICTING same-repo PRs and skips fork-headed PRs", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(10, "owner/repo", "owner/repo", "alice"),
        makePrItem(20, "fork-owner/repo", "owner/repo", "bob"),  // fork — excluded
        makePrItem(30, "owner/repo", "owner/repo", "carol"),
      ],
    });
    const pullsGet = vi.fn(); // not called in new implementation
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "CONFLICTING" } } });

    const result = await findConflictedPrs(
      makeFullOctokitWithPulls(graphql, pullsList, pullsGet),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep,
      ["*"],
      noopRateLimiter
    );

    // Fork PR #20 is excluded; only same-repo PRs #10 and #30 are polled.
    expect(result).toContain(10);
    expect(result).toContain(30);
    expect(result).not.toContain(20);
  });

  it("excludes PRs whose head.repo is null (deleted fork)", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(5, null, "owner/repo", "alice"),             // deleted fork — excluded
        makePrItem(6, "owner/repo", "owner/repo", "alice"),    // same-repo — included
      ],
    });
    const pullsGet = vi.fn();
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "CONFLICTING" } } });

    const result = await findConflictedPrs(
      makeFullOctokitWithPulls(graphql, pullsList, pullsGet),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep,
      ["*"],
      noopRateLimiter
    );

    // Only PR #6 passes the fork filter.
    expect(result).toEqual([6]);
  });

  it("returns an empty array when all open PRs are fork-headed", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(1, "fork-owner/repo", "owner/repo", "alice"),
        makePrItem(2, "fork-owner/repo", "owner/repo", "bob"),
      ],
    });
    const pullsGet = vi.fn();
    const graphql = vi.fn();

    const result = await findConflictedPrs(
      makeFullOctokitWithPulls(graphql, pullsList, pullsGet),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep,
      ["*"],
      noopRateLimiter
    );

    expect(result).toEqual([]);
    // No mergeability polling should occur when all PRs are excluded.
    expect(graphql).not.toHaveBeenCalled();
  });

  it("returns an empty array when there are no open PRs", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({ data: [] });
    const pullsGet = vi.fn();
    const graphql = vi.fn();

    const result = await findConflictedPrs(
      makeFullOctokitWithPulls(graphql, pullsList, pullsGet),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep,
      ["*"],
      noopRateLimiter
    );

    expect(result).toEqual([]);
    // Fork filter and mergeability polling should not be called when no PRs exist.
    expect(pullsGet).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });

  it("returns an empty array when all same-repo PRs are MERGEABLE", async () => {
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(11, "owner/repo", "owner/repo", "alice"),
        makePrItem(22, "owner/repo", "owner/repo", "bob"),
      ],
    });
    const pullsGet = vi.fn();
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "MERGEABLE" } } });

    const result = await findConflictedPrs(
      makeFullOctokitWithPulls(graphql, pullsList, pullsGet),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep,
      ["*"],
      noopRateLimiter
    );

    expect(result).toEqual([]);
  });

  it("filters to explicit logins + developer-agent-bot when non-wildcard allowlist provided", async () => {
    // "app/mfrancza-developer-agent" normalizes to "mfrancza-developer-agent[bot]"
    const pullsList = vi.fn().mockResolvedValueOnce({
      data: [
        makePrItem(10, "owner/repo", "owner/repo", "mfrancza-developer-agent[bot]"),
        makePrItem(20, "owner/repo", "owner/repo", "alice"),
        makePrItem(30, "owner/repo", "owner/repo", "carol"),  // not in allowlist
      ],
    });
    const pullsGet = vi.fn();
    const graphql = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { mergeable: "CONFLICTING" } } });

    const result = await findConflictedPrs(
      makeFullOctokitWithPulls(graphql, pullsList, pullsGet),
      "owner",
      "repo",
      "app/mfrancza-developer-agent",
      DEFAULT_DELAYS,
      noopSleep,
      ["alice"],
      noopRateLimiter
    );

    // PRs #10 (agent bot) and #20 (alice) are in scope; #30 (carol) is not
    expect(result).toContain(10);
    expect(result).toContain(20);
    expect(result).not.toContain(30);
  });
});
