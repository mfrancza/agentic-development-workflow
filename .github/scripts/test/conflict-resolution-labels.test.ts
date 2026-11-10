import { describe, expect, it, vi } from "vitest";
import { clearConflictEscalation, removeTriggerLabel } from "../src/lib/conflict-resolution-labels.js";
import type { getOctokit } from "../src/lib/octokit.js";

function mockClient() {
  const issues = {
    listLabelsOnIssue: vi.fn(),
    removeLabel: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
  };
  const paginate = vi.fn().mockResolvedValue([]);
  return { client: { rest: { issues }, paginate } as unknown as ReturnType<typeof getOctokit>, issues, paginate };
}

const params = { owner: "owner", repo: "repo", issue_number: 42 };

describe("clearConflictEscalation", () => {
  it("removes the escalation label and posts the audit comment", async () => {
    const { client, issues, paginate } = mockClient();
    paginate.mockResolvedValue([{ name: "other" }, { name: "conflicts-escalated" }]);
    await clearConflictEscalation(client, "owner", "repo", 42);
    expect(paginate).toHaveBeenCalledWith(issues.listLabelsOnIssue, { ...params, per_page: 100 });
    expect(issues.removeLabel).toHaveBeenCalledWith({ ...params, name: "conflicts-escalated" });
    expect(issues.createComment).toHaveBeenCalledWith({ ...params, body: "Operator re-attempted resolution via `agent:resolve-conflicts`; prior escalation marker removed." });
    expect(issues.removeLabel.mock.invocationCallOrder[0]).toBeLessThan(issues.createComment.mock.invocationCallOrder[0]);
  });

  it("does nothing when the escalation label is absent", async () => {
    const { client, issues } = mockClient();
    await clearConflictEscalation(client, "owner", "repo", 42);
    expect(issues.removeLabel).not.toHaveBeenCalled();
    expect(issues.createComment).not.toHaveBeenCalled();
  });

  it("propagates list, removal, and comment failures", async () => {
    for (const operation of ["list", "remove", "comment"] as const) {
      const { client, issues, paginate } = mockClient();
      const error = new Error(`${operation} failed`);
      paginate.mockResolvedValue([{ name: "conflicts-escalated" }]);
      if (operation === "list") paginate.mockRejectedValue(error);
      if (operation === "remove") issues.removeLabel.mockRejectedValue(error);
      if (operation === "comment") issues.createComment.mockRejectedValue(error);
      await expect(clearConflictEscalation(client, "owner", "repo", 42)).rejects.toBe(error);
      if (operation !== "comment") expect(issues.createComment).not.toHaveBeenCalled();
    }
  });
});

describe("removeTriggerLabel", () => {
  it("removes the trigger without a verification read on success", async () => {
    const { client, issues, paginate } = mockClient();
    await expect(removeTriggerLabel(client, "owner", "repo", 42)).resolves.toBe(true);
    expect(issues.removeLabel).toHaveBeenCalledWith({ ...params, name: "agent:resolve-conflicts" });
    expect(paginate).not.toHaveBeenCalled();
  });

  it("accepts a 404 only after a paginated read confirms absence", async () => {
    const { client, issues, paginate } = mockClient();
    issues.removeLabel.mockRejectedValue({ status: 404 });
    paginate.mockResolvedValue([{ name: "other" }]);
    await expect(removeTriggerLabel(client, "owner", "repo", 42)).resolves.toBe(false);
    expect(paginate).toHaveBeenCalledWith(issues.listLabelsOnIssue, { ...params, per_page: 100 });
  });

  it("fails if the trigger remains after a 404", async () => {
    const { client, issues, paginate } = mockClient();
    issues.removeLabel.mockRejectedValue({ status: 404 });
    paginate.mockResolvedValue([{ name: "other" }, { name: "agent:resolve-conflicts" }]);
    await expect(removeTriggerLabel(client, "owner", "repo", 42)).rejects.toThrow("still present");
  });

  it("propagates a failed 404 verification read", async () => {
    const { client, issues, paginate } = mockClient();
    const error = new Error("read failed");
    issues.removeLabel.mockRejectedValue({ status: 404 });
    paginate.mockRejectedValue(error);
    await expect(removeTriggerLabel(client, "owner", "repo", 42)).rejects.toBe(error);
  });

  it.each([{ status: 403 }, new Error("network error")])("propagates non-404 errors without reading labels: %o", async (error) => {
    const { client, issues, paginate } = mockClient();
    issues.removeLabel.mockRejectedValue(error);
    await expect(removeTriggerLabel(client, "owner", "repo", 42)).rejects.toBe(error);
    expect(paginate).not.toHaveBeenCalled();
  });
});
