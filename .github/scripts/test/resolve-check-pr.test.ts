import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseAllowedChecks,
  resolveCheckPr,
} from "../src/resolve-check-pr.js";
import type { getOctokit } from "../src/lib/octokit.js";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

type Octokit = ReturnType<typeof getOctokit>;

const OWNER = "acme";
const REPO = "widgets";
const SHA = "a1b2c3d4";

function makeOctokit(overrides: {
  listPullRequestsAssociatedWithCommit?: ReturnType<typeof vi.fn>;
  listForRef?: ReturnType<typeof vi.fn>;
} = {}): Octokit {
  return {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit:
          overrides.listPullRequestsAssociatedWithCommit ??
          vi.fn().mockResolvedValue({
            data: [{ number: 42, state: "open", head: { sha: SHA } }],
          }),
      },
      checks: { listForRef: overrides.listForRef ?? vi.fn() },
    },
  } as unknown as Octokit;
}

function checks(name = "Lint", conclusion = "failure") {
  return { data: { check_runs: [{ name, conclusion }] } };
}

describe("parseAllowedChecks", () => {
  it("accepts only a non-empty JSON array of strings", () => {
    expect(parseAllowedChecks('["Lint"]')).toEqual(["Lint"]);
    expect(parseAllowedChecks("")).toBeUndefined();
    expect(parseAllowedChecks("not json")).toBeUndefined();
    expect(parseAllowedChecks("[]")).toBeUndefined();
    expect(parseAllowedChecks('["Lint", 1]')).toBeUndefined();
  });
});

describe("resolveCheckPr", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the first open PR whose head matches the supplied SHA", async () => {
    const lookup = vi.fn().mockResolvedValue({
      data: [
        { number: 2, state: "closed", head: { sha: SHA } },
        { number: 3, state: "open", head: { sha: "other" } },
        { number: 4, state: "open", head: { sha: SHA } },
      ],
    });
    const result = await resolveCheckPr(
      makeOctokit({
        listPullRequestsAssociatedWithCommit: lookup,
        listForRef: vi.fn().mockResolvedValue(checks()),
      }),
      OWNER,
      REPO,
      SHA,
      '["Lint"]'
    );

    expect(result).toEqual({ proceed: true, prNumber: 4, headSha: SHA });
    expect(lookup).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, commit_sha: SHA });
  });

  it("skips when the SHA lookup finds no open matching PR", async () => {
    const listForRef = vi.fn();
    const result = await resolveCheckPr(
      makeOctokit({
        listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
          data: [{ number: 8, state: "closed", head: { sha: SHA } }],
        }),
        listForRef,
      }),
      OWNER,
      REPO,
      SHA,
      '["Lint"]'
    );

    expect(result).toEqual({ proceed: false });
    expect(listForRef).not.toHaveBeenCalled();
  });

  it("fails closed for empty, malformed, and unlisted allowlists", async () => {
    for (const allowedChecks of ["", "{", "[]", '["Other"]']) {
      const listForRef = vi.fn().mockResolvedValue(checks());
      const result = await resolveCheckPr(
        makeOctokit({ listForRef }),
        OWNER,
        REPO,
        SHA,
        allowedChecks
      );

      expect(result.proceed).toBe(false);
      if (allowedChecks !== '["Other"]') expect(listForRef).not.toHaveBeenCalled();
    }
  });

  it.each(["failure", "timed_out", "action_required"])(
    "proceeds for an allowed %s check",
    async (conclusion) => {
      const result = await resolveCheckPr(
        makeOctokit({ listForRef: vi.fn().mockResolvedValue(checks("Lint", conclusion)) }),
        OWNER,
        REPO,
        SHA,
        '["Lint"]'
      );

      expect(result).toEqual({ proceed: true, prNumber: 42, headSha: SHA });
    }
  );

  it("reconciles workflow_run failures with current check-run state", async () => {
    const result = await resolveCheckPr(
      makeOctokit({
        listForRef: vi.fn().mockResolvedValue(checks("Lint", "success")),
      }),
      OWNER,
      REPO,
      SHA,
      '["Lint"]'
    );

    expect(result).toEqual({ proceed: false, prNumber: 42, headSha: SHA });
  });

  it("skips when the trigger has no usable head SHA", async () => {
    const lookup = vi.fn();
    await expect(
      resolveCheckPr(makeOctokit({ listPullRequestsAssociatedWithCommit: lookup }), OWNER, REPO, "", '["Lint"]')
    ).resolves.toEqual({ proceed: false });
    expect(lookup).not.toHaveBeenCalled();
  });
});
