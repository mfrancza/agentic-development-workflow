import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock calls are hoisted before imports, so mocks are in place when the
// module under test is loaded (including the module-level run() invocation).
vi.mock("@actions/core", () => ({
  getInput: vi.fn().mockReturnValue(""),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn().mockReturnValue({
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
      },
    },
  }),
}));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { run, hasLabel } from "../src/check-draft-label.js";

/** Label payload accepted by the mock issues.get endpoint. */
type LabelPayload = string | { name: string };

/** Build a minimal mock Octokit that returns the given label payloads. */
function makeMockOctokit(labels: LabelPayload[]) {
  return {
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({ data: { labels } }),
      },
    },
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

describe("hasLabel", () => {
  it("returns true when a string label matches the target", () => {
    expect(hasLabel(["draft", "agent:developer"], "draft")).toBe(true);
  });

  it("returns true when an object label's name matches the target", () => {
    expect(hasLabel([{ name: "draft" }, { name: "agent:developer" }], "draft")).toBe(true);
  });

  it("returns false when no label matches the target", () => {
    expect(hasLabel([{ name: "agent:developer" }, { name: "model:opus" }], "draft")).toBe(false);
  });

  it("returns false on an empty label list", () => {
    expect(hasLabel([], "draft")).toBe(false);
  });

  it("returns false when an object label has a null name", () => {
    expect(hasLabel([{ name: null }], "draft")).toBe(false);
  });
});

describe("check-draft-label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets skip=true when the issue has the draft label", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      "issue-number": "7",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(
        makeMockOctokit([{ name: "draft" }, { name: "agent:developer" }])
      )
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "true");
    expect(core.setOutput).not.toHaveBeenCalledWith("skip", "false");
  });

  it("sets skip=false when the issue has no labels", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      "issue-number": "8",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([]))
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "false");
  });

  it("sets skip=false when the issue has other labels but not draft", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      "issue-number": "9",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(
        makeMockOctokit([{ name: "agent:developer" }, { name: "model:opus" }])
      )
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "false");
  });

  it("handles string-typed labels in addition to label objects", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      "issue-number": "10",
    });
    // The GitHub REST API returns label objects, but the type union allows plain
    // strings.  Verify the guard handles both forms.
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(
        makeMockOctokit(["draft", { name: "agent:developer" }])
      )
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("skip", "true");
  });

  it("passes the correct issue number and repo to the API", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      "issue-number": "42",
    });
    const mock = makeMockOctokit([]);
    vi.mocked(github.getOctokit).mockReturnValue(asOctokit(mock));

    await run();

    expect(mock.rest.issues.get).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      issue_number: 42,
    });
  });

  it("throws when issue-number is not a valid integer", async () => {
    mockInputs({
      token: "gh-token",
      repo: "myorg/myrepo",
      "issue-number": "not-a-number",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([]))
    );

    await expect(run()).rejects.toThrow("Invalid issue-number");
  });

  it("throws when the repo format is invalid", async () => {
    mockInputs({
      token: "gh-token",
      repo: "noslash",
      "issue-number": "1",
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      asOctokit(makeMockOctokit([]))
    );

    await expect(run()).rejects.toThrow("Invalid repo format");
  });
});
