import { describe, it, expect, vi } from "vitest";
import {
  validatePrNumberInput,
  pollMergeability,
  listDeveloperAgentPrs,
  findConflictedPrs,
  DEFAULT_DELAYS,
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

/** Build a mock Octokit with both graphql and search. */
function makeFullOctokit(
  graphql: ReturnType<typeof vi.fn>,
  search: ReturnType<typeof vi.fn>
): OctokitType {
  return {
    graphql,
    rest: { search: { issuesAndPullRequests: search } },
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
// findConflictedPrs
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
