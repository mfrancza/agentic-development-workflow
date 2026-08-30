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
  }),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { run, getOpenBlockers, type Blocker } from "../src/check-blockers.js";

/** Shape of a blocker as returned by the GitHub API. */
interface BlockerPayload {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
}

/** Build a minimal mock Octokit that returns the given blocker payloads. */
function makeMockOctokit(blockers: BlockerPayload[]) {
  return {
    request: vi.fn().mockResolvedValue({ data: blockers }),
  };
}

/** Cast a partial mock to the Octokit type used by github.getOctokit. */
function asOctokit(
  mock: ReturnType<typeof makeMockOctokit>
): ReturnType<typeof github.getOctokit> {
  return mock as unknown as ReturnType<typeof github.getOctokit>;
}

/** Construct a blocker payload with sensible defaults. */
function makeBlocker(
  number: number,
  state: "open" | "closed",
  title = `Issue #${number}`
): BlockerPayload {
  return {
    number,
    html_url: `https://github.com/myorg/myrepo/issues/${number}`,
    title,
    state,
  };
}

/** Minimal getInput mock that returns values from a lookup table. */
function mockInputs(inputs: Record<string, string>) {
  vi.mocked(core.getInput).mockImplementation(
    (name: string) => inputs[name] ?? ""
  );
}

describe("getOpenBlockers", () => {
  it("returns an empty array when there are no blockers", async () => {
    const mock = makeMockOctokit([]);
    const result = await getOpenBlockers(asOctokit(mock), "myorg", "myrepo", 1);
    expect(result).toEqual([]);
  });

  it("returns an empty array when all blockers are closed", async () => {
    const mock = makeMockOctokit([
      makeBlocker(10, "closed"),
      makeBlocker(11, "closed"),
    ]);
    const result = await getOpenBlockers(asOctokit(mock), "myorg", "myrepo", 2);
    expect(result).toEqual([]);
  });

  it("returns only open blockers when mixed states are present", async () => {
    const mock = makeMockOctokit([
      makeBlocker(10, "open", "Open blocker"),
      makeBlocker(11, "closed", "Closed blocker"),
    ]);
    const result = await getOpenBlockers(asOctokit(mock), "myorg", "myrepo", 3);
    expect(result).toEqual<Blocker[]>([
      {
        number: 10,
        url: "https://github.com/myorg/myrepo/issues/10",
        title: "Open blocker",
      },
    ]);
  });

  it("maps number, url (from html_url), and title from the API response", async () => {
    const mock = makeMockOctokit([makeBlocker(42, "open", "Fix the thing")]);
    const result = await getOpenBlockers(asOctokit(mock), "myorg", "myrepo", 5);
    expect(result).toEqual<Blocker[]>([
      {
        number: 42,
        url: "https://github.com/myorg/myrepo/issues/42",
        title: "Fix the thing",
      },
    ]);
  });

  it("passes the correct owner, repo, and issue number to the API", async () => {
    const mock = makeMockOctokit([]);
    await getOpenBlockers(asOctokit(mock), "testowner", "testrepo", 99);
    expect(mock.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
      { owner: "testowner", repo: "testrepo", issue_number: 99 }
    );
  });

  it("propagates API errors so callers can fail loudly", async () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const mock = makeMockOctokit([]);
    mock.request.mockRejectedValueOnce(error);
    await expect(
      getOpenBlockers(asOctokit(mock), "myorg", "myrepo", 1)
    ).rejects.toThrow("Not Found");
  });
});

describe("check-blockers run()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets blocked=false and open-blockers=[] when there are no blockers", async () => {
    mockInputs({ token: "gh-token", repo: "myorg/myrepo", issue_number: "1" });
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(makeMockOctokit([])));

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("blocked", "false");
    expect(core.setOutput).toHaveBeenCalledWith("open-blockers", "[]");
  });

  it("sets blocked=false when all blockers are closed", async () => {
    mockInputs({ token: "gh-token", repo: "myorg/myrepo", issue_number: "2" });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(
        makeMockOctokit([makeBlocker(10, "closed"), makeBlocker(11, "closed")])
      )
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("blocked", "false");
    expect(core.setOutput).toHaveBeenCalledWith("open-blockers", "[]");
  });

  it("sets blocked=true and lists the single open blocker", async () => {
    mockInputs({ token: "gh-token", repo: "myorg/myrepo", issue_number: "3" });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([makeBlocker(20, "open", "Blocking issue")]))
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("blocked", "true");
    expect(core.setOutput).toHaveBeenCalledWith(
      "open-blockers",
      JSON.stringify([
        {
          number: 20,
          url: "https://github.com/myorg/myrepo/issues/20",
          title: "Blocking issue",
        },
      ])
    );
  });

  it("sets blocked=true and lists all open blockers when multiple are open", async () => {
    mockInputs({ token: "gh-token", repo: "myorg/myrepo", issue_number: "4" });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(
        makeMockOctokit([
          makeBlocker(30, "open", "First blocker"),
          makeBlocker(31, "open", "Second blocker"),
          makeBlocker(32, "closed", "Closed blocker"),
        ])
      )
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("blocked", "true");

    const openBlockersCall = vi.mocked(core.setOutput).mock.calls.find(
      (c) => c[0] === "open-blockers"
    );
    const openBlockers: Blocker[] = JSON.parse(openBlockersCall![1] as string);
    expect(openBlockers).toHaveLength(2);
    expect(openBlockers.map((b) => b.number)).toEqual([30, 31]);
    expect(openBlockers.map((b) => b.title)).toEqual([
      "First blocker",
      "Second blocker",
    ]);
  });

  it("fails loudly when the blockers endpoint returns 404", async () => {
    mockInputs({ token: "gh-token", repo: "myorg/myrepo", issue_number: "5" });
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const mock = makeMockOctokit([]);
    mock.request.mockRejectedValueOnce(error);
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await expect(run()).rejects.toThrow("Not Found");
  });

  it("throws when issue-number is not a valid integer", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      issue_number: "not-a-number",
    });
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(makeMockOctokit([])));

    await expect(run()).rejects.toThrow("Invalid issue-number");
  });

  it("throws when the repo format is invalid", async () => {
    mockInputs({
      token: "gh-token",
      repo: "noslash",
      issue_number: "1",
    });
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(makeMockOctokit([])));

    await expect(run()).rejects.toThrow("Invalid repo format");
  });
});
