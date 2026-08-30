import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock calls are hoisted before imports, so mocks are in place when the
// module under test is loaded (including the module-level run() invocation).
vi.mock("@actions/core", () => ({
  getInput: vi.fn().mockReturnValue(""),
  setFailed: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn().mockReturnValue({
    rest: {
      issues: {
        addLabels: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
      },
    },
  }),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  run,
  applyUnblockedLabels,
  applyAgentDeveloperLabel,
  removeBlockedLabel,
} from "../src/apply-unblocked-labels.js";

/** Shape of a label as returned by the issues.get API. */
type IssueLabel = { name: string } | string;

/** Build a mock issues API object. */
function makeMockIssues({
  addLabelsResult = Promise.resolve({}),
  removeLabelResult = Promise.resolve({}),
  getResult = Promise.resolve({ data: { labels: [] as IssueLabel[] } }),
}: {
  addLabelsResult?: Promise<unknown>;
  removeLabelResult?: Promise<unknown>;
  getResult?: Promise<{ data: { labels: IssueLabel[] } }>;
} = {}) {
  return {
    addLabels: vi.fn().mockReturnValue(addLabelsResult),
    removeLabel: vi.fn().mockReturnValue(removeLabelResult),
    get: vi.fn().mockReturnValue(getResult),
  };
}

/** Build a mock Octokit with the provided issues methods. */
function makeMockOctokit(issues: ReturnType<typeof makeMockIssues>) {
  return {
    rest: { issues },
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
// applyAgentDeveloperLabel
// ---------------------------------------------------------------------------

describe("applyAgentDeveloperLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true and calls addLabels on success", async () => {
    const issues = makeMockIssues();
    const result = await applyAgentDeveloperLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(true);
    expect(issues.addLabels).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      issue_number: 42,
      labels: ["agent:developer"],
    });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("returns true and emits a warning when agent:developer is already present", async () => {
    const issues = makeMockIssues({
      addLabelsResult: Promise.reject(new Error("Unprocessable Entity")),
      getResult: Promise.resolve({
        data: { labels: [{ name: "agent:developer" }] },
      }),
    });
    const result = await applyAgentDeveloperLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("already present on issue #42")
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("returns false and calls setFailed when label is absent after addLabels failure", async () => {
    const issues = makeMockIssues({
      addLabelsResult: Promise.reject(new Error("Server Error")),
      getResult: Promise.resolve({ data: { labels: [] } }),
    });
    const result = await applyAgentDeveloperLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(false);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("still absent")
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("returns false and calls setFailed when the re-check API call also fails", async () => {
    const issues = makeMockIssues({
      addLabelsResult: Promise.reject(new Error("Server Error")),
      getResult: Promise.reject(new Error("API unavailable")),
    });
    const result = await applyAgentDeveloperLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(false);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("re-check API call also failed")
    );
  });
});

// ---------------------------------------------------------------------------
// removeBlockedLabel
// ---------------------------------------------------------------------------

describe("removeBlockedLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true and calls removeLabel on success", async () => {
    const issues = makeMockIssues();
    const result = await removeBlockedLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(true);
    expect(issues.removeLabel).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      issue_number: 42,
      name: "blocked",
    });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("returns true and emits a warning when blocked label is already absent", async () => {
    const issues = makeMockIssues({
      removeLabelResult: Promise.reject(new Error("Label not found")),
      getResult: Promise.resolve({ data: { labels: [] } }),
    });
    const result = await removeBlockedLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("already absent from issue #42")
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("returns false and calls setFailed when blocked label is still present after failure", async () => {
    const issues = makeMockIssues({
      removeLabelResult: Promise.reject(new Error("Server Error")),
      getResult: Promise.resolve({
        data: { labels: [{ name: "blocked" }] },
      }),
    });
    const result = await removeBlockedLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(false);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("still present")
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("returns false and calls setFailed when the re-check API call also fails", async () => {
    const issues = makeMockIssues({
      removeLabelResult: Promise.reject(new Error("Server Error")),
      getResult: Promise.reject(new Error("API unavailable")),
    });
    const result = await removeBlockedLabel(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      42
    );
    expect(result).toBe(false);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("re-check API call also failed")
    );
  });
});

// ---------------------------------------------------------------------------
// applyUnblockedLabels
// ---------------------------------------------------------------------------

describe("applyUnblockedLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true and does nothing when the array is empty", async () => {
    const issues = makeMockIssues();
    const result = await applyUnblockedLabels(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      []
    );
    expect(result).toBe(true);
    expect(issues.addLabels).not.toHaveBeenCalled();
    expect(issues.removeLabel).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("processes a single issue successfully", async () => {
    const issues = makeMockIssues();
    const result = await applyUnblockedLabels(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      [10]
    );
    expect(result).toBe(true);
    expect(issues.addLabels).toHaveBeenCalledTimes(1);
    expect(issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 10, labels: ["agent:developer"] })
    );
    expect(issues.removeLabel).toHaveBeenCalledTimes(1);
    expect(issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 10, name: "blocked" })
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("processes multiple issues successfully", async () => {
    const issues = makeMockIssues();
    const result = await applyUnblockedLabels(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      [10, 20, 30]
    );
    expect(result).toBe(true);
    expect(issues.addLabels).toHaveBeenCalledTimes(3);
    expect(issues.removeLabel).toHaveBeenCalledTimes(3);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("returns false and stops processing when addLabels fails fatally", async () => {
    const issues = makeMockIssues({
      addLabelsResult: Promise.reject(new Error("Forbidden")),
      getResult: Promise.resolve({ data: { labels: [] } }),
    });
    const result = await applyUnblockedLabels(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      [10, 20]
    );
    expect(result).toBe(false);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("still absent")
    );
    // Should have stopped after first issue
    expect(issues.addLabels).toHaveBeenCalledTimes(1);
    expect(issues.removeLabel).not.toHaveBeenCalled();
  });

  it("returns false and stops processing when removeLabel fails fatally", async () => {
    const issues = makeMockIssues({
      removeLabelResult: Promise.reject(new Error("Forbidden")),
      getResult: Promise.resolve({
        data: { labels: [{ name: "blocked" }] },
      }),
    });
    const result = await applyUnblockedLabels(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      [10, 20]
    );
    expect(result).toBe(false);
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("still present")
    );
    // Should have stopped after first issue
    expect(issues.addLabels).toHaveBeenCalledTimes(1);
    expect(issues.removeLabel).toHaveBeenCalledTimes(1);
  });

  it("continues and warns when agent:developer is already present (non-fatal)", async () => {
    const addLabels = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unprocessable"))
      .mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({
      data: { labels: [{ name: "agent:developer" }] },
    });
    const removeLabel = vi.fn().mockResolvedValue({});
    const issues = { addLabels, removeLabel, get };

    const result = await applyUnblockedLabels(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      [10, 20]
    );
    expect(result).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("already present on issue #10")
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(issues.removeLabel).toHaveBeenCalledTimes(2);
  });

  it("continues and warns when blocked label is already absent (non-fatal)", async () => {
    const addLabels = vi.fn().mockResolvedValue({});
    const removeLabel = vi
      .fn()
      .mockRejectedValueOnce(new Error("Label not found"))
      .mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({ data: { labels: [] } });
    const issues = { addLabels, removeLabel, get };

    const result = await applyUnblockedLabels(
      asOctokit(makeMockOctokit(issues)),
      "myorg",
      "myrepo",
      [10, 20]
    );
    expect(result).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("already absent from issue #10")
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(issues.addLabels).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// run() integration
// ---------------------------------------------------------------------------

describe("apply-unblocked-labels run()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes issues from inputs and applies labels", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      unblocked: "[10, 20]",
    });
    const mockIssues = makeMockIssues();
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit(mockIssues))
    );

    await run();

    expect(mockIssues.addLabels).toHaveBeenCalledTimes(2);
    expect(mockIssues.removeLabel).toHaveBeenCalledTimes(2);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("does nothing when unblocked is an empty array", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      unblocked: "[]",
    });
    const mockIssues = makeMockIssues();
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit(mockIssues))
    );

    await run();

    expect(mockIssues.addLabels).not.toHaveBeenCalled();
    expect(mockIssues.removeLabel).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("throws when repo format is invalid", async () => {
    mockInputs({
      token: "gh-token",
      repo: "noslash",
      unblocked: "[1]",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit(makeMockIssues()))
    );

    await expect(run()).rejects.toThrow("Invalid repo format");
  });

  it("throws when unblocked is not valid JSON", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      unblocked: "not-json",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit(makeMockIssues()))
    );

    await expect(run()).rejects.toThrow("Invalid unblocked input");
  });

  it("throws when unblocked is not a JSON array", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      unblocked: '{"key": 1}',
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit(makeMockIssues()))
    );

    await expect(run()).rejects.toThrow("Invalid unblocked input");
  });
});
