import { describe, expect, it, vi } from "vitest";
import { rerunPublisher } from "../src/lib/rerun-publisher.js";
const run = (id: number, sha = "head", prs: number[] | null = [10], created_at = "2024-01-01T00:00:00Z") => ({ id, head_sha: sha, pull_requests: prs?.map(number => ({ number })) ?? null, created_at });
const job = (name = "protected-approval-gate", conclusion = "success", status = "completed") => ({ name, conclusion, status });
function setup(runs = [run(1)], jobs: Record<number, ReturnType<typeof job>[]> = {}) {
  const get = vi.fn().mockResolvedValue({ data: { head: { sha: "head" } } });
  const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: runs } });
  const listJobsForWorkflowRun = vi.fn().mockImplementation(async ({ run_id }: { run_id: number }) => ({ data: { jobs: jobs[run_id] ?? [] } }));
  const reRunWorkflow = vi.fn().mockResolvedValue({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const octokit = { rest: { pulls: { get }, actions: { listWorkflowRuns, listJobsForWorkflowRun, reRunWorkflow } } } as any;
  return { get, listWorkflowRuns, listJobsForWorkflowRun, reRunWorkflow, invoke: () => rerunPublisher(octokit, "owner", "repo", 10, "publisher.yml") };
}
describe("rerunPublisher", () => {
  it.each(["protected-approval-gate", "protected-approval-gate (preview)"])("prefers an evaluated %s over a first-listed skipped run", async name => {
    const t = setup([run(20), run(10)], { 20: [job(name, "skipped")], 10: [job(name, "failure")] });
    expect(await t.invoke()).toEqual({ status: "rerun-triggered", runId: 10 });
    expect(t.reRunWorkflow).toHaveBeenCalledTimes(1);
  });
  it("ranks evaluated candidates by timestamp then descending id", async () => {
    const t = setup([run(2), run(3), run(9, "head", [10], "2023-01-01T00:00:00Z")], { 2: [job()], 3: [job()], 9: [job()] });
    expect(await t.invoke()).toEqual({ status: "rerun-triggered", runId: 3 });
    expect(t.listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
  });
  it("ignores old heads and PRs sharing the SHA or missing identity", async () => {
    const t = setup([run(9, "old"), run(8, "head", [11]), run(7, "head", null), run(2)], { 9: [job()], 2: [job()] });
    expect(await t.invoke()).toEqual({ status: "rerun-triggered", runId: 2 });
    expect(t.listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
    const old = setup([run(9, "old")]);
    expect(await old.invoke()).toEqual({ status: "no-prior-run" });
    expect(old.reRunWorkflow).not.toHaveBeenCalled();
  });
  it("falls back to the highest-ranked matching run only after all jobs are checked", async () => {
    const t = setup([run(1), run(2)], { 2: [job("other"), job(undefined, "skipped")], 1: [job(undefined, "success", "in_progress")] });
    expect(await t.invoke()).toEqual({ status: "rerun-triggered", runId: 2 });
    expect(t.listJobsForWorkflowRun).toHaveBeenCalledTimes(2);
    expect(await setup([]).invoke()).toEqual({ status: "no-prior-run" });
  });
  it("searches all attempts, including an earlier completed job when the latest skipped", async () => {
    const t = setup([run(2), run(1)], { 2: [job(undefined, "skipped")], 1: [job(undefined, "skipped"), job(undefined, "failure")] });
    t.reRunWorkflow.mockRejectedValue(new Error("busy"));
    expect(await t.invoke()).toEqual({ status: "api-error", message: "busy" });
    expect(t.listJobsForWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 1, filter: "all" }));
    expect(t.reRunWorkflow).toHaveBeenCalledTimes(1);
  });
  it("handles run timestamp ties across pages and paginated jobs", async () => {
    const t = setup();
    t.listWorkflowRuns.mockResolvedValueOnce({ data: { workflow_runs: [run(1), ...Array.from({ length: 99 }, (_, i) => run(1000 + i, "head", [99]))] } }).mockResolvedValueOnce({ data: { workflow_runs: [run(2)] } });
    t.listJobsForWorkflowRun.mockImplementation(async ({ run_id, page }: { run_id: number; page: number }) => ({ data: { jobs: run_id === 2 && page === 1 ? Array.from({ length: 100 }, () => job("other")) : run_id === 2 ? [job()] : [] } }));
    expect(await t.invoke()).toEqual({ status: "rerun-triggered", runId: 2 });
    expect(t.listWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(t.listJobsForWorkflowRun).toHaveBeenCalledTimes(2);
  });
  it.each(["head", "runs", "jobs", "rerun", "recheck"])("normalizes %s errors without another rerun", async where => {
    const t = setup();
    if (where === "head") t.get.mockRejectedValue(new Error("bad head"));
    if (where === "runs") t.listWorkflowRuns.mockRejectedValue(new Error("bad runs"));
    if (where === "jobs") t.listJobsForWorkflowRun.mockRejectedValue(new Error("bad jobs"));
    if (where === "rerun") t.reRunWorkflow.mockRejectedValue(new Error("bad rerun"));
    if (where === "recheck") t.get.mockResolvedValueOnce({ data: { head: { sha: "head" } } }).mockRejectedValueOnce(new Error("bad recheck"));
    expect(await t.invoke()).toEqual({ status: "api-error", message: `bad ${where}` });
    expect(t.reRunWorkflow.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it("rejects a changed head before dispatch", async () => {
    const t = setup();
    t.get.mockResolvedValueOnce({ data: { head: { sha: "head" } } }).mockResolvedValueOnce({ data: { head: { sha: "new" } } });
    expect(await t.invoke()).toEqual({ status: "api-error", message: expect.stringContaining("head changed") });
    expect(t.reRunWorkflow).not.toHaveBeenCalled();
  });
});
