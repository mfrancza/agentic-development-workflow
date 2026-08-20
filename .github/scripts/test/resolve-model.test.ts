import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveModel } from "../src/resolve-model.js";

// ---------------------------------------------------------------------------
// Minimal mock Octokit — only the REST methods used by resolveModel.
// ---------------------------------------------------------------------------

const mockIssueGet = vi.fn();
const mockPullGet = vi.fn();

const mockOctokit = {
  rest: {
    issues: { get: mockIssueGet },
    pulls: { get: mockPullGet },
  },
};

// Cast to `any` so we don't have to satisfy every Octokit method.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const octokit = mockOctokit as any;

// Helper that builds a mock API response with the given label names.
function issueResponse(labelNames: string[]) {
  return {
    data: { labels: labelNames.map((name) => ({ name })) },
  };
}

function prResponse(labelNames: string[]) {
  return {
    data: { labels: labelNames.map((name) => ({ name })) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIssueGet.mockReset();
  mockPullGet.mockReset();
});

describe("resolveModel — issue subject type", () => {
  it("returns the defaultModel when no model:* labels are present", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["bug", "enhancement"]));

    const result = await resolveModel(
      octokit,
      "issue",
      42,
      "owner",
      "repo",
      "sonnet",
    );

    expect(result).toBe("sonnet");
    expect(mockIssueGet).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 42,
    });
  });

  it("returns the model name when exactly one model:* label is present", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["model:opus", "bug"]));

    const result = await resolveModel(
      octokit,
      "issue",
      7,
      "owner",
      "repo",
      "sonnet",
    );

    expect(result).toBe("opus");
  });

  it("strips the 'model:' prefix from the label", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["model:haiku"]));

    const result = await resolveModel(
      octokit,
      "issue",
      1,
      "owner",
      "repo",
      "sonnet",
    );

    expect(result).toBe("haiku");
  });

  it("throws when more than one model:* label is present", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:opus", "model:sonnet"]),
    );

    await expect(
      resolveModel(octokit, "issue", 42, "owner", "repo", "sonnet"),
    ).rejects.toThrow(/Multiple model:\* labels/);
  });

  it("includes the issue number and label names in the error message", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:opus", "model:haiku", "bug"]),
    );

    await expect(
      resolveModel(octokit, "issue", 99, "owner", "repo", "sonnet"),
    ).rejects.toThrow(/issue #99/);
  });

  it("returns the defaultModel when the label list is empty", async () => {
    mockIssueGet.mockResolvedValue(issueResponse([]));

    const result = await resolveModel(
      octokit,
      "issue",
      5,
      "owner",
      "repo",
      "haiku",
    );

    expect(result).toBe("haiku");
  });

  it("handles label objects where name is null (treats as empty string)", async () => {
    mockIssueGet.mockResolvedValue({
      data: { labels: [{ name: null }, { name: "bug" }] },
    });

    // null name → empty string → doesn't start with "model:" → falls back
    const result = await resolveModel(
      octokit,
      "issue",
      3,
      "owner",
      "repo",
      "default",
    );

    expect(result).toBe("default");
  });

  it("handles bare string labels (rare but legal Octokit shape)", async () => {
    mockIssueGet.mockResolvedValue({
      data: { labels: ["model:sonnet", "bug"] },
    });

    const result = await resolveModel(
      octokit,
      "issue",
      10,
      "owner",
      "repo",
      "haiku",
    );

    expect(result).toBe("sonnet");
  });
});

describe("resolveModel — pr subject type", () => {
  it("returns the defaultModel when no model:* labels are present", async () => {
    mockPullGet.mockResolvedValue(prResponse(["enhancement"]));

    const result = await resolveModel(
      octokit,
      "pr",
      12,
      "owner",
      "repo",
      "sonnet",
    );

    expect(result).toBe("sonnet");
    expect(mockPullGet).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 12,
    });
  });

  it("returns the model name when exactly one model:* label is present", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:haiku", "agent:review"]));

    const result = await resolveModel(
      octokit,
      "pr",
      88,
      "owner",
      "repo",
      "sonnet",
    );

    expect(result).toBe("haiku");
  });

  it("throws when more than one model:* label is present", async () => {
    mockPullGet.mockResolvedValue(
      prResponse(["model:opus", "model:haiku"]),
    );

    await expect(
      resolveModel(octokit, "pr", 77, "owner", "repo", "sonnet"),
    ).rejects.toThrow(/Multiple model:\* labels/);
  });

  it("includes 'pr' and the PR number in the error message", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:opus", "model:sonnet"]));

    await expect(
      resolveModel(octokit, "pr", 55, "owner", "repo", "sonnet"),
    ).rejects.toThrow(/pr #55/);
  });

  it("does not call issues.get when subject type is pr", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:opus"]));

    await resolveModel(octokit, "pr", 1, "owner", "repo", "sonnet");

    expect(mockIssueGet).not.toHaveBeenCalled();
  });

  it("does not call pulls.get when subject type is issue", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["model:opus"]));

    await resolveModel(octokit, "issue", 1, "owner", "repo", "sonnet");

    expect(mockPullGet).not.toHaveBeenCalled();
  });
});
