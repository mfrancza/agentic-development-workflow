import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveDeployment } from "../src/resolve-deployment.js";
import type { getOctokit } from "../src/lib/octokit.js";

// Silence core.info output during tests.
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
  setOutput: vi.fn(),
}));

type Octokit = ReturnType<typeof getOctokit>;

/** Build a minimal Octokit mock with the three methods resolveDeployment uses. */
function makeOctokit(overrides: {
  listWorkflowRunsForRepo?: ReturnType<typeof vi.fn>;
  listPullRequestsAssociatedWithCommit?: ReturnType<typeof vi.fn>;
  pullsGet?: ReturnType<typeof vi.fn>;
} = {}): Octokit {
  return {
    rest: {
      actions: {
        listWorkflowRunsForRepo:
          overrides.listWorkflowRunsForRepo ?? vi.fn(),
      },
      repos: {
        listPullRequestsAssociatedWithCommit:
          overrides.listPullRequestsAssociatedWithCommit ?? vi.fn(),
      },
      pulls: {
        get: overrides.pullsGet ?? vi.fn(),
      },
    },
  } as unknown as Octokit;
}

const OWNER = "acme";
const REPO = "my-repo";
const SHA = "abc1234";

describe("resolveDeployment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns proceed=false when no failed workflow run is found for the SHA", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: { workflow_runs: [] },
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: false });
  });

  it("returns proceed=false when no PR is associated with the commit", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: { workflow_runs: [{ id: 42 }] },
      }),
      listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
        data: [],
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: false });
  });

  it("returns proceed=false when the PR body contains no Closes #N reference", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: { workflow_runs: [{ id: 42 }] },
      }),
      listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
        data: [{ number: 7 }],
      }),
      pullsGet: vi.fn().mockResolvedValue({
        data: { body: "No issue reference here." },
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: false });
  });

  it("returns proceed=false when the PR body is null", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: { workflow_runs: [{ id: 42 }] },
      }),
      listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
        data: [{ number: 7 }],
      }),
      pullsGet: vi.fn().mockResolvedValue({
        data: { body: null },
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: false });
  });

  it("returns proceed=true with run_id and issue_number when all lookups succeed", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: { workflow_runs: [{ id: 99 }] },
      }),
      listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
        data: [{ number: 15 }],
      }),
      pullsGet: vi.fn().mockResolvedValue({
        data: { body: "Implement feature\n\nCloses #137" },
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: true, runId: 99, issueNumber: 137 });
  });

  it("matches 'closes #N' case-insensitively", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: { workflow_runs: [{ id: 1 }] },
      }),
      listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
        data: [{ number: 3 }],
      }),
      pullsGet: vi.fn().mockResolvedValue({
        data: { body: "CLOSES #42" },
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: true, runId: 1, issueNumber: 42 });
  });

  it("parses the first Closes #N when multiple references appear in the body", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        data: { workflow_runs: [{ id: 5 }] },
      }),
      listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
        data: [{ number: 8 }],
      }),
      pullsGet: vi.fn().mockResolvedValue({
        data: { body: "Closes #10\nAlso closes #20" },
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: true, runId: 5, issueNumber: 10 });
  });

  it("uses the first workflow run returned by the API", async () => {
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
        // The API returns them newest-first; take the first (highest) id.
        data: { workflow_runs: [{ id: 200 }, { id: 100 }] },
      }),
      listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
        data: [{ number: 4 }],
      }),
      pullsGet: vi.fn().mockResolvedValue({
        data: { body: "Closes #55" },
      }),
    });

    const result = await resolveDeployment(octokit, OWNER, REPO, SHA);

    expect(result).toEqual({ proceed: true, runId: 200, issueNumber: 55 });
  });
});
