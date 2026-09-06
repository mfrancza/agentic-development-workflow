import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// vi.mock calls are hoisted before imports, so mocks are in place when the
// module under test is loaded (including the module-level run() invocation).
vi.mock("@actions/core", () => ({
  getInput: vi.fn().mockReturnValue(""),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn(),
}));

// Mock node:fs so tests do not touch the real filesystem.
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { existsSync, readFileSync } from "node:fs";
import {
  run,
  truncatePlan,
  formatComment,
  findExistingComment,
  upsertPlanComment,
  MAX_PLAN_BYTES,
  TRUNCATION_SUFFIX,
} from "../src/terraform-plan-comment.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal comment shape returned by the issues.listComments mock. */
interface MockComment {
  id: number;
  user: { login: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Octokit for upsert tests. */
function makeMockOctokit(existingComments: MockComment[] = []) {
  return {
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi
          .fn()
          .mockResolvedValue({ data: { id: 1001 } }),
        updateComment: vi
          .fn()
          .mockResolvedValue({ data: { id: 2002 } }),
      },
    },
    paginate: vi.fn().mockResolvedValue(existingComments),
  };
}

/** Cast a partial mock to the Octokit type used by github.getOctokit. */
function asOctokit(
  mock: ReturnType<typeof makeMockOctokit>,
): ReturnType<typeof github.getOctokit> {
  return mock as unknown as ReturnType<typeof github.getOctokit>;
}

/** Set up core.getInput to return values from a lookup table. */
function mockInputs(inputs: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation(
    (name: string) => inputs[name] ?? "",
  );
}

/**
 * Cast an auto-mocked fs function to a Vitest Mock so we can call
 * mockReturnValue without TypeScript complaining about readFileSync's
 * complex overload union return type.
 */
function asMock(fn: unknown): Mock {
  return fn as Mock;
}

// ---------------------------------------------------------------------------
// truncatePlan (pure function)
// ---------------------------------------------------------------------------

describe("truncatePlan", () => {
  it("returns the plan text unchanged when it is within the byte limit", () => {
    const short = "No changes. Infrastructure is up-to-date.";
    expect(truncatePlan(short)).toBe(short);
  });

  it("truncates and appends TRUNCATION_SUFFIX when plan exceeds the limit", () => {
    // Build a string that is one byte over the limit.
    const overLimit = "x".repeat(MAX_PLAN_BYTES + 1);
    const result = truncatePlan(overLimit);
    expect(result.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      MAX_PLAN_BYTES + Buffer.byteLength(TRUNCATION_SUFFIX, "utf8"),
    );
    // The plan portion must fit within the limit.
    const planPortion = result.slice(0, result.length - TRUNCATION_SUFFIX.length);
    expect(Buffer.byteLength(planPortion, "utf8")).toBeLessThanOrEqual(
      MAX_PLAN_BYTES,
    );
  });

  it("does not truncate a plan that is exactly at the byte limit", () => {
    const exact = "x".repeat(MAX_PLAN_BYTES);
    const result = truncatePlan(exact);
    expect(result).toBe(exact);
    expect(result.endsWith(TRUNCATION_SUFFIX)).toBe(false);
  });

  it("respects a custom maxBytes parameter", () => {
    const text = "abcdefghij";
    const result = truncatePlan(text, 5);
    expect(result).toBe("abcde" + TRUNCATION_SUFFIX);
  });
});

// ---------------------------------------------------------------------------
// formatComment (pure function)
// ---------------------------------------------------------------------------

describe("formatComment", () => {
  it("wraps plan text in a Markdown code fence with the expected header", () => {
    const planText = "Plan: 0 to add, 1 to change, 0 to destroy.";
    const comment = formatComment(planText);
    expect(comment).toContain("## Terraform Plan");
    expect(comment).toContain("```");
    expect(comment).toContain(planText);
  });

  it("truncates an oversized plan before wrapping", () => {
    const overLimit = "z".repeat(MAX_PLAN_BYTES + 1);
    const comment = formatComment(overLimit);
    expect(comment).toContain(TRUNCATION_SUFFIX);
    expect(comment).toContain("## Terraform Plan");
  });
});

// ---------------------------------------------------------------------------
// findExistingComment
// ---------------------------------------------------------------------------

describe("findExistingComment", () => {
  it("returns the comment ID when a matching bot comment is found", async () => {
    const mock = makeMockOctokit([
      { id: 77, user: { login: "some-human" } },
      { id: 88, user: { login: "terraform-ci[bot]" } },
    ]);
    const id = await findExistingComment(
      asOctokit(mock),
      "myorg",
      "myrepo",
      10,
      "terraform-ci[bot]",
    );
    expect(id).toBe(88);
  });

  it("returns undefined when no comment matches the bot login", async () => {
    const mock = makeMockOctokit([
      { id: 55, user: { login: "alice" } },
    ]);
    const id = await findExistingComment(
      asOctokit(mock),
      "myorg",
      "myrepo",
      10,
      "terraform-ci[bot]",
    );
    expect(id).toBeUndefined();
  });

  it("returns undefined for an empty comment list", async () => {
    const mock = makeMockOctokit([]);
    const id = await findExistingComment(
      asOctokit(mock),
      "myorg",
      "myrepo",
      10,
      "terraform-ci[bot]",
    );
    expect(id).toBeUndefined();
  });

  it("handles comments where user is null", async () => {
    const mock = makeMockOctokit([{ id: 33, user: null }]);
    const id = await findExistingComment(
      asOctokit(mock),
      "myorg",
      "myrepo",
      10,
      "terraform-ci[bot]",
    );
    expect(id).toBeUndefined();
  });

  it("passes the correct parameters to paginate", async () => {
    const mock = makeMockOctokit([]);
    await findExistingComment(
      asOctokit(mock),
      "myorg",
      "myrepo",
      42,
      "terraform-ci[bot]",
    );
    expect(mock.paginate).toHaveBeenCalledWith(
      mock.rest.issues.listComments,
      expect.objectContaining({
        owner: "myorg",
        repo: "myrepo",
        issue_number: 42,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// upsertPlanComment
// ---------------------------------------------------------------------------

describe("upsertPlanComment", () => {
  it("creates a new comment when no existing bot comment is found", async () => {
    const mock = makeMockOctokit([]); // paginate returns []
    const result = await upsertPlanComment(
      asOctokit(mock),
      "myorg",
      "myrepo",
      7,
      "terraform-ci[bot]",
      "body text",
    );
    expect(result.created).toBe(true);
    expect(result.commentId).toBe(1001);
    expect(mock.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "myorg",
        repo: "myrepo",
        issue_number: 7,
        body: "body text",
      }),
    );
    expect(mock.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("updates the existing comment when one is found", async () => {
    const mock = makeMockOctokit([
      { id: 500, user: { login: "terraform-ci[bot]" } },
    ]);
    const result = await upsertPlanComment(
      asOctokit(mock),
      "myorg",
      "myrepo",
      7,
      "terraform-ci[bot]",
      "updated body",
    );
    expect(result.created).toBe(false);
    expect(result.commentId).toBe(2002);
    expect(mock.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "myorg",
        repo: "myrepo",
        comment_id: 500,
        body: "updated body",
      }),
    );
    expect(mock.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// run() — end-to-end entry point
// ---------------------------------------------------------------------------

describe("terraform-plan-comment run()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new comment when no existing bot comment exists", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      pr_number: "12",
      plan_file: "/tmp/plan.txt",
      bot_login: "terraform-ci[bot]",
    });

    vi.mocked(existsSync).mockReturnValue(true);
    asMock(readFileSync).mockReturnValue(
      "Plan: 1 to add, 0 to change, 0 to destroy.",
    );

    const mock = makeMockOctokit([]); // no existing comments
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await run();

    expect(mock.rest.issues.createComment).toHaveBeenCalledOnce();
    expect(mock.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("comment_id", "1001");
  });

  it("updates an existing bot comment on subsequent runs", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      pr_number: "12",
      plan_file: "/tmp/plan.txt",
      bot_login: "terraform-ci[bot]",
    });

    vi.mocked(existsSync).mockReturnValue(true);
    asMock(readFileSync).mockReturnValue(
      "No changes. Infrastructure is up-to-date.",
    );

    const mock = makeMockOctokit([
      { id: 300, user: { login: "terraform-ci[bot]" } },
    ]);
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await run();

    expect(mock.rest.issues.updateComment).toHaveBeenCalledOnce();
    expect(mock.rest.issues.createComment).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("comment_id", "2002");
  });

  it("truncates an oversized plan before posting the comment", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      pr_number: "5",
      plan_file: "/tmp/huge-plan.txt",
      bot_login: "terraform-ci[bot]",
    });

    // Provide a plan body larger than the 60 KB limit.
    const hugePlan = "x".repeat(MAX_PLAN_BYTES + 500);
    vi.mocked(existsSync).mockReturnValue(true);
    asMock(readFileSync).mockReturnValue(hugePlan);

    const mock = makeMockOctokit([]);
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await run();

    expect(mock.rest.issues.createComment).toHaveBeenCalledOnce();
    const [callArgs] = vi.mocked(mock.rest.issues.createComment).mock.calls;
    const body: string = (callArgs[0] as { body: string }).body;
    expect(body).toContain(TRUNCATION_SUFFIX);
  });

  it("throws when the plan file does not exist", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      pr_number: "3",
      plan_file: "/nonexistent/plan.txt",
      bot_login: "terraform-ci[bot]",
    });

    vi.mocked(existsSync).mockReturnValue(false);

    const mock = makeMockOctokit([]);
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await expect(run()).rejects.toThrow("Plan file not found");
  });

  it("throws when pr-number is not a valid integer", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      pr_number: "not-a-number",
      plan_file: "/tmp/plan.txt",
      bot_login: "terraform-ci[bot]",
    });

    await expect(run()).rejects.toThrow("Invalid pr-number");
  });

  it("throws when the repo format is invalid", async () => {
    mockInputs({
      token: "gh-token",
      repo: "noslash",
      pr_number: "1",
      plan_file: "/tmp/plan.txt",
      bot_login: "terraform-ci[bot]",
    });

    await expect(run()).rejects.toThrow("Invalid repo format");
  });
});
