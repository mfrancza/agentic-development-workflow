import { beforeEach, describe, expect, it, vi } from "vitest";
import { findFailingAgentPrs } from "../src/find-failing-agent-prs.js";
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
const AUTHOR = "agent[bot]";

function pull(number: number, sha: string, options: { author?: string; labels?: string[] } = {}) {
  return {
    number,
    head: { sha },
    user: { login: options.author ?? AUTHOR },
    labels: (options.labels ?? []).map((name) => ({ name })),
  };
}

function makeOctokit(overrides: {
  list?: ReturnType<typeof vi.fn>;
  listForRef?: ReturnType<typeof vi.fn>;
} = {}): Octokit {
  return {
    rest: {
      pulls: { list: overrides.list ?? vi.fn() },
      checks: { listForRef: overrides.listForRef ?? vi.fn() },
    },
  } as unknown as Octokit;
}

describe("findFailingAgentPrs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed when the allowlist is absent, empty, or malformed", async () => {
    for (const allowlist of ["", "{", "[]", '["CI", 1]']) {
      const list = vi.fn();
      await expect(
        findFailingAgentPrs(makeOctokit({ list }), OWNER, REPO, AUTHOR, allowlist)
      ).resolves.toEqual([]);
      expect(list).not.toHaveBeenCalled();
    }
  });

  it("selects only PRs with an allowed actionable check", async () => {
    const list = vi.fn().mockResolvedValue({
      data: [pull(11, "good"), pull(12, "wrong-check")],
    });
    const listForRef = vi
      .fn()
      .mockResolvedValueOnce({ data: { check_runs: [{ name: "CI", conclusion: "failure" }] } })
      .mockResolvedValueOnce({ data: { check_runs: [{ name: "Other", conclusion: "failure" }] } });

    await expect(
      findFailingAgentPrs(makeOctokit({ list, listForRef }), OWNER, REPO, AUTHOR, '["CI"]')
    ).resolves.toEqual([{ number: 11, head_sha: "good" }]);
  });

  it("excludes human-required PRs without reading their checks", async () => {
    const list = vi.fn().mockResolvedValue({
      data: [pull(11, "escalated", { labels: ["human-required"] })],
    });
    const listForRef = vi.fn();

    await expect(
      findFailingAgentPrs(makeOctokit({ list, listForRef }), OWNER, REPO, AUTHOR, '["CI"]')
    ).resolves.toEqual([]);
    expect(listForRef).not.toHaveBeenCalled();
  });

  it("reads all check-run pages before rejecting a PR", async () => {
    const list = vi.fn().mockResolvedValue({ data: [pull(11, "paged")] });
    const firstPage = Array.from({ length: 100 }, () => ({ name: "Other", conclusion: "failure" }));
    const listForRef = vi
      .fn()
      .mockResolvedValueOnce({ data: { check_runs: firstPage } })
      .mockResolvedValueOnce({ data: { check_runs: [{ name: "CI", conclusion: "timed_out" }] } });

    await expect(
      findFailingAgentPrs(makeOctokit({ list, listForRef }), OWNER, REPO, AUTHOR, '["CI"]')
    ).resolves.toEqual([{ number: 11, head_sha: "paged" }]);
    expect(listForRef).toHaveBeenCalledTimes(2);
  });
});
