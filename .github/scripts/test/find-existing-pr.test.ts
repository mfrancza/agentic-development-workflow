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
    paginate: vi.fn().mockResolvedValue([]),
    rest: { pulls: { list: vi.fn() } },
  }),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { run } from "../src/find-existing-pr.js";

/** Build a minimal mock Octokit for the pull-list paginate path. */
function makeMockOctokit(
  prs: Array<{ number: number; ownerLogin: string | null }>
) {
  const pullsList = vi.fn();
  return {
    paginate: vi.fn().mockResolvedValue(
      prs.map(({ number, ownerLogin }) => ({
        number,
        head: {
          repo: ownerLogin !== null ? { owner: { login: ownerLogin } } : null,
        },
      }))
    ),
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

describe("find-existing-pr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets skip=true and pr-number when a PR from the expected owner exists", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      branch: "agent/issue-99",
      owner: "myorg",
    });
    const mock = makeMockOctokit([{ number: 42, ownerLogin: "myorg" }]);
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "true");
    expect(core.setOutput).toHaveBeenCalledWith("pr-number", "42");
  });

  it("sets skip=false when no PRs are returned", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      branch: "agent/issue-99",
      owner: "myorg",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([]))
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "false");
    expect(core.setOutput).toHaveBeenCalledWith("pr-number", "");
  });

  it("sets skip=false when the only matching PR belongs to a different owner (fork)", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      branch: "agent/issue-99",
      owner: "myorg",
    });
    // A fork of myorg/myrepo whose owner is "fork-user" has an open PR with
    // the same branch name.  This should NOT trigger a skip.
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([{ number: 7, ownerLogin: "fork-user" }]))
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "false");
    expect(core.setOutput).toHaveBeenCalledWith("pr-number", "");
  });

  it("selects the first matching PR when multiple results are returned", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      branch: "agent/issue-99",
      owner: "myorg",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(
        makeMockOctokit([
          { number: 1, ownerLogin: "fork-user" }, // not a match
          { number: 2, ownerLogin: "myorg" }, // first match
          { number: 3, ownerLogin: "myorg" }, // second match (ignored)
        ])
      )
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "true");
    expect(core.setOutput).toHaveBeenCalledWith("pr-number", "2");
  });

  it("sets skip=false when the PR's head repo is null (deleted fork)", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      branch: "agent/issue-99",
      owner: "myorg",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([{ number: 5, ownerLogin: null }]))
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "false");
    expect(core.setOutput).toHaveBeenCalledWith("pr-number", "");
  });

  it("passes owner:branch in head filter to the paginate call", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      branch: "design/issue-5",
      owner: "myorg",
    });
    const mock = makeMockOctokit([]);
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await run();

    expect(mock.paginate).toHaveBeenCalledWith(
      mock.rest.pulls.list,
      expect.objectContaining({
        head: "myorg:design/issue-5",
        state: "open",
      })
    );
  });

  it("throws when the repo format is invalid", async () => {
    mockInputs({
      token: "gh-token",
      repo: "noslash",
      branch: "agent/issue-1",
      owner: "myorg",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([]))
    );

    await expect(run()).rejects.toThrow("Invalid repo format");
  });
});
