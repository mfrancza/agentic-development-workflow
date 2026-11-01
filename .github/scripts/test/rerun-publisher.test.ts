import { beforeEach, describe, expect, it, vi } from "vitest";
import { rerunPublisher } from "../src/lib/rerun-publisher.js";
import type { RerunResult } from "../src/lib/rerun-publisher.js";

// Minimal Octokit mock shape needed by rerunPublisher.
function makeOctokit(overrides: {
  listWorkflowRuns?: ReturnType<typeof vi.fn>;
  reRunWorkflow?: ReturnType<typeof vi.fn>;
}) {
  return {
    rest: {
      actions: {
        listWorkflowRuns: overrides.listWorkflowRuns ?? vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
        reRunWorkflow: overrides.reRunWorkflow ?? vi.fn().mockResolvedValue({}),
      },
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Builds a mock workflow_run object with the given id and PR numbers. */
function workflowRun(id: number, prNumbers: number[], createdAt = "2024-01-01T00:00:00Z") {
  return { id, created_at: createdAt, pull_requests: prNumbers.map(number => ({ number })) };
}

const OWNER = "owner";
const REPO = "repo";
const WORKFLOW = "protected-approval-gate-publisher.yml";

describe("rerunPublisher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("triggers a rerun of the latest pull_request_target run for the given PR and returns rerun-triggered", async () => {
    const reRunWorkflow = vi.fn().mockResolvedValue({});
    const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: [workflowRun(42, [10, 11])] } });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result: RerunResult = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "rerun-triggered", runId: 42 });
    expect(listWorkflowRuns).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, workflow_id: WORKFLOW, event: "pull_request_target", per_page: 100, page: 1 });
    expect(reRunWorkflow).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, run_id: 42 });
  });

  it("returns no-prior-run when no workflow run includes the target PR number", async () => {
    const reRunWorkflow = vi.fn();
    const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: [workflowRun(42, [99])] } });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "no-prior-run" });
    expect(reRunWorkflow).not.toHaveBeenCalled();
  });

  it("returns no-prior-run when the workflow has no runs at all", async () => {
    const reRunWorkflow = vi.fn();
    const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: [] } });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "no-prior-run" });
    expect(reRunWorkflow).not.toHaveBeenCalled();
  });

  it("returns api-error (does not throw) when the reRunWorkflow call fails", async () => {
    const reRunWorkflow = vi.fn().mockRejectedValue(new Error("Not Found"));
    const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: [workflowRun(42, [10])] } });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "api-error", message: "Not Found" });
    expect(reRunWorkflow).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, run_id: 42 });
  });

  it("stops at the first matching run (latest) without fetching subsequent pages", async () => {
    const reRunWorkflow = vi.fn().mockResolvedValue({});
    // Two runs on page 1; first (id=100) is the latest. Second (id=50) should not be rerun.
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: { workflow_runs: [workflowRun(100, [10], "2024-02-01T00:00:00Z"), workflowRun(50, [10], "2024-01-01T00:00:00Z")] },
    });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "rerun-triggered", runId: 100 });
    expect(reRunWorkflow).toHaveBeenCalledTimes(1);
    expect(reRunWorkflow).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, run_id: 100 });
    // Should only have fetched page 1 (found immediately)
    expect(listWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  it("paginates to find a matching run when the first page has no match", async () => {
    const reRunWorkflow = vi.fn().mockResolvedValue({});
    const listWorkflowRuns = vi.fn()
      // Page 1: 100 runs, none matching PR 10
      .mockResolvedValueOnce({ data: { workflow_runs: Array.from({ length: 100 }, (_, i) => workflowRun(1000 + i, [99])) } })
      // Page 2: 1 run matching PR 10
      .mockResolvedValueOnce({ data: { workflow_runs: [workflowRun(77, [10])] } });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "rerun-triggered", runId: 77 });
    expect(listWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(listWorkflowRuns).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
    expect(listWorkflowRuns).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
  });

  it("returns no-prior-run after exhausting all pages with no match", async () => {
    const reRunWorkflow = vi.fn();
    const listWorkflowRuns = vi.fn()
      // Page 1: 100 runs, none matching PR 10
      .mockResolvedValueOnce({ data: { workflow_runs: Array.from({ length: 100 }, (_, i) => workflowRun(1000 + i, [99])) } })
      // Page 2: 0 runs (end of pagination)
      .mockResolvedValueOnce({ data: { workflow_runs: [] } });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "no-prior-run" });
    expect(reRunWorkflow).not.toHaveBeenCalled();
  });

  it("handles runs with null pull_requests gracefully", async () => {
    const reRunWorkflow = vi.fn();
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      // Some runs have null pull_requests (e.g. push-triggered runs listed by the same endpoint)
      data: { workflow_runs: [{ id: 42, created_at: "2024-01-01T00:00:00Z", pull_requests: null }] },
    });
    const octokit = makeOctokit({ listWorkflowRuns, reRunWorkflow });

    const result = await rerunPublisher(octokit, OWNER, REPO, 10, WORKFLOW);

    expect(result).toEqual({ status: "no-prior-run" });
    expect(reRunWorkflow).not.toHaveBeenCalled();
  });
});
