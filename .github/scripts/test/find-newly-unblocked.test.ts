import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock calls are hoisted before imports, so mocks are in place when the
// module under test is loaded (including the module-level run() invocation).
vi.mock("@actions/core", () => ({
  getInput: vi.fn().mockReturnValue(""),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn().mockReturnValue({
    request: vi.fn().mockResolvedValue({ data: [] }),
    paginate: vi.fn().mockResolvedValue([]),
    rest: { pulls: { list: vi.fn() } },
  }),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  run,
  findNewlyUnblocked,
  getBlockingIssues,
  hasOpenBlockers,
  hasAgentPR,
} from "../src/find-newly-unblocked.js";

/** Shape of a blocking candidate as returned by the blocking API endpoint. */
interface BlockingIssue {
  number: number;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
}

/** Shape of a blocked_by entry as returned by the blocked_by API endpoint. */
interface BlockedByItem {
  number: number;
  state: "open" | "closed";
}

/** PR shape used in paginate results. */
type PrPayload = {
  number: number;
  head: { repo?: { owner: { login: string } } | null };
};

/** Construct a blocking issue payload with sensible defaults. */
function makeIssue(
  number: number,
  labels: string[] = ["blocked"],
  state: "open" | "closed" = "open"
): BlockingIssue {
  return {
    number,
    state,
    labels: labels.map((name) => ({ name })),
  };
}

/**
 * Build a mock Octokit whose behaviour is driven by the provided scenario
 * data:
 *
 * - `blockingIssues`      — returned by GET .../dependencies/blocking
 * - `openPRsByBranch`     — keyed by branch name (without owner prefix);
 *                           returned by paginate when the head filter matches
 * - `openBlockersByIssue` — keyed by issue number; returned by
 *                           GET .../dependencies/blocked_by for that issue
 */
function makeMockOctokit({
  blockingIssues,
  openPRsByBranch = {},
  openBlockersByIssue = {},
}: {
  blockingIssues: BlockingIssue[];
  openPRsByBranch?: Record<string, PrPayload[]>;
  openBlockersByIssue?: Record<number, BlockedByItem[]>;
}) {
  const pullsList = vi.fn();

  const requestMock = vi.fn().mockImplementation(
    async (endpoint: string, params: Record<string, unknown>) => {
      if (endpoint.includes("dependencies/blocking")) {
        return { data: blockingIssues };
      }
      if (endpoint.includes("dependencies/blocked_by")) {
        const issueNumber = params.issue_number as number;
        return { data: openBlockersByIssue[issueNumber] ?? [] };
      }
      throw new Error(`Unexpected request endpoint in mock: ${endpoint}`);
    }
  );

  const paginateMock = vi.fn().mockImplementation(
    async (
      _fn: unknown,
      params: { head?: string } & Record<string, unknown>
    ) => {
      // Extract the branch name from the "owner:branch" head filter.
      const branch = params.head?.split(":")?.[1] ?? "";
      return openPRsByBranch[branch] ?? [];
    }
  );

  return {
    request: requestMock,
    paginate: paginateMock,
    rest: { pulls: { list: pullsList } },
  };
}

/** Cast a partial mock to the Octokit type used by github.getOctokit. */
function asOctokit(
  mock: ReturnType<typeof makeMockOctokit>
): ReturnType<typeof github.getOctokit> {
  return mock as unknown as ReturnType<typeof github.getOctokit>;
}

/** Minimal getInput mock that returns values from a lookup table. */
function mockInputs(inputs: Record<string, string>) {
  vi.mocked(core.getInput).mockImplementation(
    (name: string) => inputs[name] ?? ""
  );
}

// ---------------------------------------------------------------------------
// getBlockingIssues
// ---------------------------------------------------------------------------

describe("getBlockingIssues", () => {
  it("returns an empty array when the blocking list is empty", async () => {
    const mock = makeMockOctokit({ blockingIssues: [] });
    const result = await getBlockingIssues(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("returns the issues from the API response", async () => {
    const issues = [makeIssue(10, ["blocked"]), makeIssue(11, ["enhancement"])];
    const mock = makeMockOctokit({ blockingIssues: issues });
    const result = await getBlockingIssues(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual(issues);
  });

  it("passes the correct owner, repo, and issue number to the API", async () => {
    const mock = makeMockOctokit({ blockingIssues: [] });
    await getBlockingIssues(asOctokit(mock), "testowner", "testrepo", 42);
    expect(mock.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking",
      { owner: "testowner", repo: "testrepo", issue_number: 42 }
    );
  });

  it("propagates API errors so callers can fail loudly", async () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const mock = makeMockOctokit({ blockingIssues: [] });
    mock.request.mockRejectedValueOnce(error);
    await expect(
      getBlockingIssues(asOctokit(mock), "myorg", "myrepo", 1)
    ).rejects.toThrow("Not Found");
  });
});

// ---------------------------------------------------------------------------
// hasOpenBlockers
// ---------------------------------------------------------------------------

describe("hasOpenBlockers", () => {
  it("returns false when there are no blockers", async () => {
    const mock = makeMockOctokit({ blockingIssues: [] });
    const result = await hasOpenBlockers(asOctokit(mock), "myorg", "myrepo", 5);
    expect(result).toBe(false);
  });

  it("returns false when all blockers are closed", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [],
      openBlockersByIssue: {
        5: [
          { number: 98, state: "closed" },
          { number: 99, state: "closed" },
        ],
      },
    });
    const result = await hasOpenBlockers(asOctokit(mock), "myorg", "myrepo", 5);
    expect(result).toBe(false);
  });

  it("returns true when at least one blocker is open", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [],
      openBlockersByIssue: {
        5: [
          { number: 98, state: "closed" },
          { number: 99, state: "open" },
        ],
      },
    });
    const result = await hasOpenBlockers(asOctokit(mock), "myorg", "myrepo", 5);
    expect(result).toBe(true);
  });

  it("passes the correct owner, repo, and issue number to the API", async () => {
    const mock = makeMockOctokit({ blockingIssues: [] });
    await hasOpenBlockers(asOctokit(mock), "testowner", "testrepo", 77);
    expect(mock.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
      { owner: "testowner", repo: "testrepo", issue_number: 77 }
    );
  });
});

// ---------------------------------------------------------------------------
// hasAgentPR
// ---------------------------------------------------------------------------

describe("hasAgentPR", () => {
  it("returns false when no open PR exists for the branch", async () => {
    const mock = makeMockOctokit({ blockingIssues: [] });
    const result = await hasAgentPR(asOctokit(mock), "myorg", "myrepo", 7);
    expect(result).toBe(false);
  });

  it("returns true when an open PR exists on branch agent/issue-{N}", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [],
      openPRsByBranch: {
        "agent/issue-7": [
          { number: 42, head: { repo: { owner: { login: "myorg" } } } },
        ],
      },
    });
    const result = await hasAgentPR(asOctokit(mock), "myorg", "myrepo", 7);
    expect(result).toBe(true);
  });

  it("passes the correct head filter to paginate", async () => {
    const mock = makeMockOctokit({ blockingIssues: [] });
    await hasAgentPR(asOctokit(mock), "myorg", "myrepo", 99);
    expect(mock.paginate).toHaveBeenCalledWith(
      mock.rest.pulls.list,
      expect.objectContaining({
        head: "myorg:agent/issue-99",
        state: "open",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// findNewlyUnblocked
// ---------------------------------------------------------------------------

describe("findNewlyUnblocked", () => {
  it("returns an empty array when the blocking list is empty", async () => {
    const mock = makeMockOctokit({ blockingIssues: [] });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("returns only issues that pass all five checks (mixed scenario)", async () => {
    // Issue 10: newly unblocked — passes all checks
    // Issue 11: still has an open blocker — fails check 5
    const mock = makeMockOctokit({
      blockingIssues: [makeIssue(10, ["blocked"]), makeIssue(11, ["blocked"])],
      openBlockersByIssue: {
        11: [{ number: 99, state: "open" }],
      },
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([10]);
  });

  it("skips a candidate that is closed (check 1)", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [makeIssue(50, ["blocked"], "closed")],
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("skips a candidate without the `blocked` label (check 2)", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [makeIssue(20, ["enhancement", "do"])],
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("skips a candidate already carrying the `agent:developer` label (check 3)", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [makeIssue(30, ["blocked", "agent:developer"])],
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("skips a candidate that has an existing open agent PR (check 4)", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [makeIssue(40, ["blocked"])],
      openPRsByBranch: {
        "agent/issue-40": [
          { number: 100, head: { repo: { owner: { login: "myorg" } } } },
        ],
      },
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("skips a candidate whose blocked_by list still contains an open blocker (check 5)", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [makeIssue(60, ["blocked"])],
      openBlockersByIssue: {
        60: [{ number: 3, state: "open" }],
      },
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("returns multiple newly-unblocked issues when all pass every check", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [makeIssue(70, ["blocked"]), makeIssue(71, ["blocked"])],
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([70, 71]);
  });

  it("handles a mix of passing and failing candidates across all skip reasons", async () => {
    const mock = makeMockOctokit({
      blockingIssues: [
        makeIssue(80, ["blocked"], "closed"),            // fails check 1
        makeIssue(81, ["enhancement"]),                  // fails check 2
        makeIssue(82, ["blocked", "agent:developer"]),   // fails check 3
        makeIssue(83, ["blocked"]),                      // fails check 4 (existing PR)
        makeIssue(84, ["blocked"]),                      // fails check 5 (still blocked)
        makeIssue(85, ["blocked"]),                      // passes all checks
      ],
      openPRsByBranch: {
        "agent/issue-83": [
          { number: 200, head: { repo: { owner: { login: "myorg" } } } },
        ],
      },
      openBlockersByIssue: {
        84: [{ number: 1, state: "open" }],
      },
    });
    const result = await findNewlyUnblocked(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([85]);
  });
});

// ---------------------------------------------------------------------------
// run() integration
// ---------------------------------------------------------------------------

describe("find-newly-unblocked run()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets unblocked=[] when the blocking list is empty", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      closed_issue_number: "1",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit({ blockingIssues: [] }))
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("unblocked", "[]");
  });

  it("sets unblocked with the numbers of newly-unblocked issues", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      closed_issue_number: "5",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(
        makeMockOctokit({
          blockingIssues: [makeIssue(10, ["blocked"]), makeIssue(11, ["blocked"])],
        })
      )
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith(
      "unblocked",
      JSON.stringify([10, 11])
    );
  });

  it("throws when closed-issue-number is not a valid integer", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      closed_issue_number: "not-a-number",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit({ blockingIssues: [] }))
    );

    await expect(run()).rejects.toThrow("Invalid closed-issue-number");
  });

  it("throws when the repo format is invalid", async () => {
    mockInputs({
      token: "gh-token",
      repo: "noslash",
      closed_issue_number: "1",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit({ blockingIssues: [] }))
    );

    await expect(run()).rejects.toThrow("Invalid repo format");
  });
});
