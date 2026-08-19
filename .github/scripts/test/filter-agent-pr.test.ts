import { describe, it, expect, vi, beforeEach } from "vitest";
import { filterAgentPr } from "../src/filter-agent-pr.js";
import type { getOctokit } from "../src/lib/octokit.js";

// Silence core.info output during tests.
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
  setOutput: vi.fn(),
}));

type Octokit = ReturnType<typeof getOctokit>;

/** Build a minimal Octokit mock with the pulls.get method filterAgentPr uses. */
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
const AGENT_LOGIN = "mfrancza-developer-agent[bot]";

describe("filterAgentPr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns proceed=true when the PR author matches the agent login", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { user: { login: AGENT_LOGIN } },
    });

    const result = await filterAgentPr(
      makeOctokit(pullsGet),
      OWNER,
      REPO,
      42,
      AGENT_LOGIN
    );

    expect(result).toEqual({ proceed: true });
    expect(pullsGet).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 42,
    });
  });

  it("returns proceed=false when the PR author does not match the agent login", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { user: { login: "some-human" } },
    });

    const result = await filterAgentPr(
      makeOctokit(pullsGet),
      OWNER,
      REPO,
      7,
      AGENT_LOGIN
    );

    expect(result).toEqual({ proceed: false });
  });

  it("returns proceed=false when the PR user field is null", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { user: null },
    });

    const result = await filterAgentPr(
      makeOctokit(pullsGet),
      OWNER,
      REPO,
      3,
      AGENT_LOGIN
    );

    expect(result).toEqual({ proceed: false });
  });

  it("comparison is exact (case-sensitive)", async () => {
    // The login check must be exact — a bot with a different casing
    // should not pass the gate.
    const pullsGet = vi.fn().mockResolvedValue({
      data: { user: { login: AGENT_LOGIN.toUpperCase() } },
    });

    const result = await filterAgentPr(
      makeOctokit(pullsGet),
      OWNER,
      REPO,
      1,
      AGENT_LOGIN
    );

    expect(result).toEqual({ proceed: false });
  });
});
