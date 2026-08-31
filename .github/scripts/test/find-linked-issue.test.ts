import { describe, it, expect, vi, beforeEach } from "vitest";
import { findLinkedIssue } from "../src/find-linked-issue.js";
import type { getOctokit } from "../src/lib/octokit.js";

// Silence core.info output during tests.
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
  setOutput: vi.fn(),
}));

type Octokit = ReturnType<typeof getOctokit>;

/** Build a minimal Octokit mock with the pulls.get method findLinkedIssue uses. */
function makeOctokit(pullsGet: ReturnType<typeof vi.fn>): Octokit {
  return {
    rest: {
      pulls: {
        get: pullsGet,
      },
    },
  } as unknown as Octokit;
}

const OWNER = "acme";
const REPO = "my-repo";

describe("findLinkedIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns proceed=true with issueNumber when the PR body contains a well-formed Closes #N reference", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { body: "Implement feature\n\nCloses #137" },
    });

    const result = await findLinkedIssue(makeOctokit(pullsGet), OWNER, REPO, 15);

    expect(result).toEqual({ proceed: true, issueNumber: 137 });
    expect(pullsGet).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 15,
    });
  });

  it("returns proceed=false when the PR body contains no Closes #N reference", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { body: "No issue reference here." },
    });

    const result = await findLinkedIssue(makeOctokit(pullsGet), OWNER, REPO, 7);

    expect(result).toEqual({ proceed: false });
  });

  it("returns proceed=false when the PR body is null", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { body: null },
    });

    const result = await findLinkedIssue(makeOctokit(pullsGet), OWNER, REPO, 7);

    expect(result).toEqual({ proceed: false });
  });

  it("matches case-insensitively", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { body: "CLOSES #42" },
    });

    const result = await findLinkedIssue(makeOctokit(pullsGet), OWNER, REPO, 3);

    expect(result).toEqual({ proceed: true, issueNumber: 42 });
  });

  it("parses the first Closes #N when multiple references appear in the body", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { body: "Closes #10\nAlso closes #20" },
    });

    const result = await findLinkedIssue(makeOctokit(pullsGet), OWNER, REPO, 8);

    expect(result).toEqual({ proceed: true, issueNumber: 10 });
  });
});
