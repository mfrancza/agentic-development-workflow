import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import { resolveReviewerSet } from "../src/resolve-reviewer-set.js";

// Suppress @actions/core logging so test output stays clean.
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Minimal mock Octokit — only the REST methods used by resolveReviewerSet
// (and by resolveModel which is called in the Tier 3 fallback).
// ---------------------------------------------------------------------------

const mockPullGet = vi.fn();

const mockOctokit = {
  rest: {
    pulls: { get: mockPullGet },
  },
};

// Cast to `any` so we don't have to satisfy every Octokit method.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const octokit = mockOctokit as any;

// Helper that builds a mock API response with the given label names.
function prResponse(labelNames: string[]) {
  return {
    data: { labels: labelNames.map((name) => ({ name })) },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockPullGet.mockReset();
});

// ---------------------------------------------------------------------------
// Tier 1: per-PR model:review:* label override
// ---------------------------------------------------------------------------

describe("resolveReviewerSet — Tier 1: per-PR model:review:* labels", () => {
  it("returns a single-entry set when one model:review:* label is present", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:review:haiku", "agent:review"]));

    const result = await resolveReviewerSet(octokit, 42, "owner", "repo", [], "sonnet");

    expect(result).toEqual([{ model: "haiku" }]);
  });

  it("returns a multi-entry set when multiple model:review:* labels are present", async () => {
    mockPullGet.mockResolvedValue(
      prResponse(["model:review:opus", "model:review:gpt-5", "agent:review"]),
    );

    const result = await resolveReviewerSet(octokit, 42, "owner", "repo", [], "sonnet");

    expect(result).toEqual([{ model: "opus" }, { model: "gpt-5" }]);
    expect(result).toHaveLength(2);
  });

  it("strips the model:review: prefix from every label", async () => {
    mockPullGet.mockResolvedValue(
      prResponse(["model:review:claude-sonnet-4-5-20250929"]),
    );

    const result = await resolveReviewerSet(octokit, 1, "owner", "repo", [], "sonnet");

    expect(result).toEqual([{ model: "claude-sonnet-4-5-20250929" }]);
  });

  it("Tier 1 takes precedence over a non-empty reviewerModels list", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:review:haiku"]));

    const result = await resolveReviewerSet(
      octokit,
      10,
      "owner",
      "repo",
      ["opus", "gpt-5"],
      "sonnet",
    );

    // Only the per-PR label, not the repo-wide list.
    expect(result).toEqual([{ model: "haiku" }]);
    expect(result).toHaveLength(1);
  });

  it("Tier 1 takes precedence over a generic model:* label on the PR", async () => {
    mockPullGet.mockResolvedValue(
      prResponse(["model:review:haiku", "model:opus"]),
    );

    const result = await resolveReviewerSet(octokit, 5, "owner", "repo", [], "sonnet");

    expect(result).toEqual([{ model: "haiku" }]);
    expect(result).toHaveLength(1);
  });

  it("passes the PR number and repo to the API call", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:review:sonnet"]));

    await resolveReviewerSet(octokit, 99, "myowner", "myrepo", [], "default");

    expect(mockPullGet).toHaveBeenCalledWith({
      owner: "myowner",
      repo: "myrepo",
      pull_number: 99,
    });
  });

  it("makes exactly one API call when Tier 1 matches", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:review:opus"]));

    await resolveReviewerSet(octokit, 7, "owner", "repo", [], "sonnet");

    expect(mockPullGet).toHaveBeenCalledTimes(1);
  });

  it("handles three model:review:* labels (returns all three)", async () => {
    mockPullGet.mockResolvedValue(
      prResponse([
        "model:review:opus",
        "model:review:gpt-5",
        "model:review:grok-4.6",
      ]),
    );

    const result = await resolveReviewerSet(octokit, 3, "owner", "repo", [], "sonnet");

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ model: "opus" });
    expect(result[1]).toEqual({ model: "gpt-5" });
    expect(result[2]).toEqual({ model: "grok-4.6" });
  });
});

// ---------------------------------------------------------------------------
// Tier 2: repo-wide REVIEWER_MODELS variable
// ---------------------------------------------------------------------------

describe("resolveReviewerSet — Tier 2: reviewerModels variable", () => {
  it("returns the reviewer models list when non-empty and no model:review:* labels present", async () => {
    mockPullGet.mockResolvedValue(prResponse(["agent:review"]));

    const result = await resolveReviewerSet(
      octokit,
      42,
      "owner",
      "repo",
      ["sonnet", "gpt-5"],
      "haiku",
    );

    expect(result).toEqual([{ model: "sonnet" }, { model: "gpt-5" }]);
  });

  it("maps each model string to a { model } object", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(
      octokit,
      1,
      "owner",
      "repo",
      ["opus", "grok-4.6"],
      "sonnet",
    );

    expect(result[0]).toHaveProperty("model", "opus");
    expect(result[1]).toHaveProperty("model", "grok-4.6");
  });

  it("Tier 2 takes precedence over a generic model:* label on the PR", async () => {
    // No model:review:* labels, has a generic label — but REVIEWER_MODELS wins.
    mockPullGet.mockResolvedValue(prResponse(["model:haiku"]));

    const result = await resolveReviewerSet(
      octokit,
      5,
      "owner",
      "repo",
      ["opus"],
      "sonnet",
    );

    expect(result).toEqual([{ model: "opus" }]);
  });

  it("makes exactly one API call when Tier 2 matches", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    await resolveReviewerSet(octokit, 10, "owner", "repo", ["sonnet"], "haiku");

    expect(mockPullGet).toHaveBeenCalledTimes(1);
  });

  it("returns a single-entry set when reviewerModels has exactly one entry", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(
      octokit,
      1,
      "owner",
      "repo",
      ["haiku"],
      "sonnet",
    );

    expect(result).toEqual([{ model: "haiku" }]);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 3: single-reviewer fallback via existing two-tier waterfall
// ---------------------------------------------------------------------------

describe("resolveReviewerSet — Tier 3: single-reviewer fallback", () => {
  it("returns a single-entry set using the generic model:* label when no override is present", async () => {
    // The initial fetch (Tier 1 check) and the resolveModel call (Tier 3)
    // both call pulls.get — mockResolvedValue covers both.
    mockPullGet.mockResolvedValue(prResponse(["model:opus", "agent:review"]));

    const result = await resolveReviewerSet(octokit, 42, "owner", "repo", [], "sonnet");

    expect(result).toEqual([{ model: "opus" }]);
    expect(result).toHaveLength(1);
  });

  it("falls back to defaultModel when no model:* label is present", async () => {
    mockPullGet.mockResolvedValue(prResponse(["agent:review", "bug"]));

    const result = await resolveReviewerSet(octokit, 7, "owner", "repo", [], "haiku");

    expect(result).toEqual([{ model: "haiku" }]);
  });

  it("falls back to defaultModel when label list is empty", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(octokit, 5, "owner", "repo", [], "sonnet");

    expect(result).toEqual([{ model: "sonnet" }]);
  });

  it("makes two API calls in the Tier 3 path (initial fetch + resolveModel)", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    await resolveReviewerSet(octokit, 1, "owner", "repo", [], "sonnet");

    // One call from resolveReviewerSet, one from resolveModel.
    expect(mockPullGet).toHaveBeenCalledTimes(2);
  });

  it("throws when multiple generic model:* labels are present in the fallback", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:opus", "model:sonnet"]));

    await expect(
      resolveReviewerSet(octokit, 33, "owner", "repo", [], "haiku"),
    ).rejects.toThrow(/Multiple model:\* labels/);
  });

  it("excludes per-agent labels for other types from the generic tier in the fallback", async () => {
    // model:groom:haiku is a per-agent label (two colons); not generic.
    // model:developer:opus is similar.
    mockPullGet.mockResolvedValue(
      prResponse(["model:groom:haiku", "model:developer:opus"]),
    );

    const result = await resolveReviewerSet(octokit, 5, "owner", "repo", [], "sonnet");

    // Neither per-agent label matches generic tier — falls back to default.
    expect(result).toEqual([{ model: "sonnet" }]);
  });

  it("always returns exactly one entry in the Tier 3 path", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:haiku"]));

    const result = await resolveReviewerSet(octokit, 9, "owner", "repo", [], "sonnet");

    expect(result).toHaveLength(1);
  });

  it("strips the model: prefix from the generic label in the fallback", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:claude-sonnet-4-5"]));

    const result = await resolveReviewerSet(octokit, 2, "owner", "repo", [], "haiku");

    expect(result).toEqual([{ model: "claude-sonnet-4-5" }]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("resolveReviewerSet — edge cases", () => {
  it("handles label objects where name is null (treats as empty string, falls through)", async () => {
    mockPullGet.mockResolvedValue({
      data: { labels: [{ name: null }, { name: "bug" }] },
    });

    // null name → empty string → doesn't match model:review:* → Tier 1 misses
    // No reviewerModels → Tier 2 misses
    // resolveModel finds no model:* labels → falls back to default
    const result = await resolveReviewerSet(octokit, 3, "owner", "repo", [], "default-model");

    expect(result).toEqual([{ model: "default-model" }]);
  });

  it("handles bare string labels (rare but legal Octokit shape)", async () => {
    mockPullGet.mockResolvedValue({
      data: { labels: ["model:review:sonnet", "bug"] },
    });

    const result = await resolveReviewerSet(octokit, 10, "owner", "repo", [], "haiku");

    expect(result).toEqual([{ model: "sonnet" }]);
  });

  it("treats an empty reviewerModels array as 'unset' and falls through to Tier 3", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(octokit, 1, "owner", "repo", [], "opus");

    // Tier 2 skipped because reviewerModels is empty → Tier 3 fallback.
    expect(result).toEqual([{ model: "opus" }]);
  });

  it("does not treat a model:review:* label from Tier 1 as a generic label in Tier 3", async () => {
    // If Tier 1 had matched we'd never reach Tier 3, so test the case where
    // there are no model:review:* labels — confirming Tier 3 ignores them.
    mockPullGet.mockResolvedValue(prResponse(["model:sonnet"]));

    const result = await resolveReviewerSet(octokit, 20, "owner", "repo", [], "haiku");

    expect(result).toEqual([{ model: "sonnet" }]);
  });

  it("returns an array of objects with a model property in all tiers", async () => {
    // Tier 1
    mockPullGet.mockResolvedValue(prResponse(["model:review:opus"]));
    const tier1 = await resolveReviewerSet(octokit, 1, "owner", "repo", [], "sonnet");
    expect(tier1.every((e) => typeof e.model === "string")).toBe(true);

    mockPullGet.mockReset();

    // Tier 2
    mockPullGet.mockResolvedValue(prResponse([]));
    const tier2 = await resolveReviewerSet(octokit, 2, "owner", "repo", ["haiku", "gpt-5"], "sonnet");
    expect(tier2.every((e) => typeof e.model === "string")).toBe(true);

    mockPullGet.mockReset();

    // Tier 3
    mockPullGet.mockResolvedValue(prResponse([]));
    const tier3 = await resolveReviewerSet(octokit, 3, "owner", "repo", [], "sonnet");
    expect(tier3.every((e) => typeof e.model === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pairing tier: error severity routing (Decision 5)
// ---------------------------------------------------------------------------

describe("resolveReviewerSet — pairing tier error severity routing", () => {
  beforeEach(() => {
    vi.mocked(core.error).mockClear();
    vi.mocked(core.warning).mockClear();
  });

  it("calls core.error() (not core.warning()) when DEFAULT_MODEL equals the authoring model after fallback", async () => {
    // Scenario: policy=different-vendor-same-class, only anthropic available,
    // authoringModel=sonnet, defaultModel=sonnet.
    // The pairing tier cannot find a cross-vendor reviewer and falls through to
    // DEFAULT_MODEL ("sonnet"), which equals the authoring model.
    // Decision 5 requires core.error() for this case — not just core.warning().
    mockPullGet.mockResolvedValue(prResponse([]));

    const pairingOptions = {
      pairingConfig: {
        policy: "different-vendor-same-class" as const,
        enabled: true as const,
      },
      authoringModel: "sonnet",
      availableProviders: ["anthropic"],
    };

    const result = await resolveReviewerSet(
      octokit,
      42,
      "owner",
      "repo",
      [],
      "sonnet",
      pairingOptions,
    );

    // The resolver must fall through to DEFAULT_MODEL ("sonnet").
    expect(result).toEqual([{ model: "sonnet" }]);

    // core.error() must have been called for the ERROR:-prefixed diagnostic
    // ("DEFAULT_MODEL equals authoring model; reviewer will share the author's
    // blind spots").  This is the Decision 5 requirement.
    expect(vi.mocked(core.error)).toHaveBeenCalledWith(
      expect.stringContaining("DEFAULT_MODEL equals authoring model"),
    );

    // The raw ERROR:-prefixed string must NOT have been passed to core.warning().
    const warningArgs = vi.mocked(core.warning).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(warningArgs.every((msg) => !msg.startsWith("ERROR:"))).toBe(true);
  });
});
