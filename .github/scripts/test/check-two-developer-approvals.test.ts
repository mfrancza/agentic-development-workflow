import { beforeEach, describe, expect, it, vi } from "vitest";

const { listReviews, createCheck } = vi.hoisted(() => ({
  listReviews: vi.fn(),
  createCheck: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: vi.fn().mockReturnValue(""),
  error: vi.fn(),
  setFailed: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn().mockReturnValue({
    rest: {
      pulls: { listReviews },
      checks: { create: createCheck },
    },
  }),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { run } from "../src/check-two-developer-approvals.js";

function mockInputs(overrides: Record<string, string> = {}) {
  const inputs: Record<string, string> = {
    developer_bot_login: "developer[bot]",
    require_two_developer_approvals: "true",
    pr_number: "42",
    pr_author: "developer[bot]",
    head_sha: "head-sha",
    repo: "owner/repo",
    ...overrides,
  };
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? "");
}

function review(login: string, state: string) {
  return { user: { login }, state };
}

function conclusion() {
  return createCheck.mock.calls[0]?.[0]?.conclusion;
}

describe("check-two-developer-approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    listReviews.mockResolvedValue({ data: [] });
    createCheck.mockResolvedValue({});
    mockInputs();
  });

  it("passes a non-developer-author PR without listing reviews", async () => {
    mockInputs({ pr_author: "human" });

    await run();

    expect(conclusion()).toBe("success");
    expect(listReviews).not.toHaveBeenCalled();
  });

  it.each([
    ["zero approvals", [], "failure"],
    ["one non-self approval", [review("alice", "APPROVED")], "failure"],
    [
      "two non-self approvals",
      [review("alice", "APPROVED"), review("bob", "APPROVED")],
      "success",
    ],
    [
      "three non-self approvals",
      [
        review("alice", "APPROVED"),
        review("bob", "APPROVED"),
        review("carol", "APPROVED"),
      ],
      "success",
    ],
    ["one self-approval only", [review("developer[bot]", "APPROVED")], "failure"],
    [
      "one non-self approval plus one self-approval",
      [review("alice", "APPROVED"), review("developer[bot]", "APPROVED")],
      "failure",
    ],
    [
      "a dismissed latest review after an approval",
      [review("alice", "APPROVED"), review("alice", "DISMISSED")],
      "failure",
    ],
    [
      "a changes-requested latest review after an approval",
      [review("alice", "APPROVED"), review("alice", "CHANGES_REQUESTED")],
      "failure",
    ],
  ])("publishes %s as %s", async (_scenario, reviews, expectedConclusion) => {
    listReviews.mockResolvedValue({ data: reviews });

    await run();

    expect(conclusion()).toBe(expectedConclusion);
    expect(listReviews).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 42,
      per_page: 100,
      page: 1,
    });
  });

  it("passes without listing reviews when opt-in is off", async () => {
    mockInputs({ require_two_developer_approvals: "false" });

    await run();

    expect(conclusion()).toBe("success");
    expect(listReviews).not.toHaveBeenCalled();
  });

  it("fails visibly when opt-in is on but developer-bot-login is empty", async () => {
    mockInputs({ developer_bot_login: "" });

    await run();

    expect(conclusion()).toBe("failure");
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining("developer-bot-login")
    );
    expect(listReviews).not.toHaveBeenCalled();
  });

  it("publishes the required Checks API payload", async () => {
    await run();

    expect(vi.mocked(github.getOctokit)).toHaveBeenCalledWith("test-token");
    expect(createCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        name: "require-two-developer-approvals / check",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "failure",
        output: expect.objectContaining({ summary: expect.any(String) }),
      })
    );
  });
});
