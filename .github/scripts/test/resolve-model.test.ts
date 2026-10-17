import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveModel } from "../src/lib/resolve-model.js";

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

// ---------------------------------------------------------------------------
// Two-tier resolution (agentType provided)
// ---------------------------------------------------------------------------

describe("resolveModel — two-tier resolution with agentType", () => {
  beforeEach(() => {
    mockIssueGet.mockReset();
    mockPullGet.mockReset();
  });

  it("returns the per-agent model when a model:<agentType>:* label is present", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:developer:haiku", "bug"]),
    );

    const result = await resolveModel(
      octokit,
      "issue",
      42,
      "owner",
      "repo",
      "sonnet",
      "developer",
    );

    expect(result).toBe("haiku");
  });

  it("per-agent label takes precedence over a generic model:* label", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:developer:opus", "model:haiku"]),
    );

    const result = await resolveModel(
      octokit,
      "issue",
      10,
      "owner",
      "repo",
      "sonnet",
      "developer",
    );

    // per-agent tier wins even though a generic label is also present
    expect(result).toBe("opus");
  });

  it("falls back to generic model:* label when no per-agent label is present", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:haiku", "enhancement"]),
    );

    const result = await resolveModel(
      octokit,
      "issue",
      7,
      "owner",
      "repo",
      "sonnet",
      "developer",
    );

    expect(result).toBe("haiku");
  });

  it("falls back to defaultModel when neither per-agent nor generic label is present", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["bug", "enhancement"]));

    const result = await resolveModel(
      octokit,
      "issue",
      5,
      "owner",
      "repo",
      "sonnet",
      "developer",
    );

    expect(result).toBe("sonnet");
  });

  it("throws on multiple per-agent labels (tier-1 fail-loud)", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:developer:haiku", "model:developer:opus"]),
    );

    await expect(
      resolveModel(octokit, "issue", 42, "owner", "repo", "sonnet", "developer"),
    ).rejects.toThrow(/model:developer:\* labels/);
  });

  it("throws on multiple generic labels when no per-agent label is present (tier-2 fail-loud)", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:haiku", "model:sonnet"]),
    );

    await expect(
      resolveModel(octokit, "issue", 42, "owner", "repo", "sonnet", "developer"),
    ).rejects.toThrow(/Multiple model:\* labels/);
  });

  it("does not treat a per-agent label for another agent type as a generic label", async () => {
    // model:groom:haiku has two colons — must NOT match the generic tier
    mockIssueGet.mockResolvedValue(issueResponse(["model:groom:haiku"]));

    const result = await resolveModel(
      octokit,
      "issue",
      3,
      "owner",
      "repo",
      "sonnet",
      "developer", // different agent type
    );

    // per-agent prefix doesn't match, and model:groom:haiku fails ^model:[^:]+$,
    // so falls back to default
    expect(result).toBe("sonnet");
  });

  it("strips the per-agent prefix correctly (model:<agentType>: removed)", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:groom:claude-sonnet-4-5"]),
    );

    const result = await resolveModel(
      octokit,
      "issue",
      1,
      "owner",
      "repo",
      "default",
      "groom",
    );

    expect(result).toBe("claude-sonnet-4-5");
  });

  it("error message for tier-1 includes per-agent prefix and issue number", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:design:haiku", "model:design:opus"]),
    );

    await expect(
      resolveModel(octokit, "issue", 99, "owner", "repo", "sonnet", "design"),
    ).rejects.toThrow(/issue #99/);
  });

  it("error message for tier-2 includes issue number and label names", async () => {
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:haiku", "model:opus"]),
    );

    await expect(
      resolveModel(octokit, "issue", 77, "owner", "repo", "sonnet", "design"),
    ).rejects.toThrow(/issue #77/);
  });

  it("a per-agent label for a different agent does not count toward the generic tier", async () => {
    // model:groom:haiku is a per-agent label for groom, not a generic label.
    // For agent type "developer", tier 1 misses; tier 2 also misses because
    // model:groom:haiku has two colons; result is the default.
    mockIssueGet.mockResolvedValue(
      issueResponse(["model:groom:haiku", "model:opus"]),
    );

    const result = await resolveModel(
      octokit,
      "issue",
      20,
      "owner",
      "repo",
      "sonnet",
      "developer",
    );

    // tier 1: no model:developer:* → miss
    // tier 2: only model:opus qualifies (model:groom:haiku excluded by regex)
    expect(result).toBe("opus");
  });
});

// ---------------------------------------------------------------------------
// Pairing tier (agentType === "review", pairingOptions provided)
// ---------------------------------------------------------------------------

// The pairing tier in resolveModel uses the classTable imported at module level
// from model-classes.ts.  These tests rely on the real loaded classTable and
// use model names that exist in the real model-classes.json.

describe("resolveModel — pairing tier (agent-type: review)", () => {
  beforeEach(() => {
    mockIssueGet.mockReset();
    mockPullGet.mockReset();
  });

  it("pairing tier fires only for agent-type: review, not for other agent types", async () => {
    // agent-type: developer with pairingOptions — pairing tier must NOT fire.
    mockIssueGet.mockResolvedValue(issueResponse([]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "issue",
      42,
      "owner",
      "repo",
      "haiku", // default
      "developer", // not review
      {
        pairingConfig: {
          enabled: true,
          policy: "different-vendor-same-class",
          preferred_vendors: ["openai", "xai", "anthropic"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "sonnet",
        availableProviders: ["anthropic", "openai", "xai"],
      },
      (msg) => warnings.push(msg),
    );

    // Pairing tier must not fire for developer; falls through to haiku default.
    expect(result).toBe("haiku");
    // No pairing-related warnings for a non-review agent type.
    expect(warnings).toHaveLength(0);
  });

  it("pairing tier is disabled by default (no pairingOptions passed)", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      10,
      "owner",
      "repo",
      "haiku",
      "review",
      undefined, // no pairingOptions
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("haiku");
    expect(warnings).toHaveLength(0);
  });

  it("label tiers still win when both labels and pairing inputs are present", async () => {
    // model:review:opus label present → tier 1 wins before pairing tier.
    mockPullGet.mockResolvedValue(prResponse(["model:review:opus"]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      5,
      "owner",
      "repo",
      "haiku",
      "review",
      {
        pairingConfig: {
          enabled: true,
          policy: "different-vendor-same-class",
          preferred_vendors: ["openai", "xai", "anthropic"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "sonnet",
        availableProviders: ["anthropic", "openai", "xai"],
      },
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("opus"); // label tier won
    expect(warnings).toHaveLength(0); // pairing tier not reached
  });

  it("generic model:* label wins over pairing tier", async () => {
    mockPullGet.mockResolvedValue(prResponse(["model:haiku"]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      3,
      "owner",
      "repo",
      "sonnet",
      "review",
      {
        pairingConfig: {
          enabled: true,
          policy: "different-vendor-same-class",
          preferred_vendors: ["openai"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "sonnet",
        availableProviders: ["anthropic", "openai"],
      },
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("haiku"); // generic label wins
    expect(warnings).toHaveLength(0);
  });

  it("pairing tier resolves a cross-vendor model when labels are absent", async () => {
    // No labels; pairing tier fires; authoring model is "sonnet" (anthropic);
    // expects gpt-5.6-terra (openai sonnet canonical).
    mockPullGet.mockResolvedValue(prResponse([]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      7,
      "owner",
      "repo",
      "haiku",
      "review",
      {
        pairingConfig: {
          enabled: true,
          policy: "different-vendor-same-class",
          preferred_vendors: ["openai", "xai", "anthropic"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "sonnet",
        availableProviders: ["anthropic", "openai", "xai"],
      },
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("gpt-5.6-terra");
    expect(warnings).toHaveLength(0);
  });

  it("pairing tier falls through to default and warns when authoring-model marker is absent", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      8,
      "owner",
      "repo",
      "haiku",
      "review",
      {
        pairingConfig: {
          enabled: true,
          policy: "different-vendor-same-class",
          preferred_vendors: ["openai"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "", // marker absent
        availableProviders: ["anthropic", "openai"],
      },
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("haiku"); // fell through to default
    expect(warnings.some((w) => w.includes("authoring model marker is absent"))).toBe(true);
  });

  it("pairing tier falls through to default when pairing-policy JSON is not set (pairingOptions undefined)", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveModel(
      octokit,
      "pr",
      9,
      "owner",
      "repo",
      "haiku",
      "review",
      undefined, // pairingOptions not passed
    );

    expect(result).toBe("haiku");
  });

  it("pairing tier emits warning when it falls back", async () => {
    // Only anthropic key; policy is different-vendor-same-class; no cross-vendor.
    mockPullGet.mockResolvedValue(prResponse([]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      11,
      "owner",
      "repo",
      "haiku",
      "review",
      {
        pairingConfig: {
          enabled: true,
          policy: "different-vendor-same-class",
          preferred_vendors: ["openai", "xai", "anthropic"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "sonnet",
        availableProviders: ["anthropic"], // only author vendor
      },
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("haiku");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('pairing tier with policy "off" does not fire and returns default', async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      12,
      "owner",
      "repo",
      "haiku",
      "review",
      {
        pairingConfig: {
          enabled: true,
          policy: "off",
          preferred_vendors: ["openai"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "sonnet",
        availableProviders: ["anthropic", "openai"],
      },
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("haiku");
    expect(warnings).toHaveLength(0);
  });

  it("pairing tier is skipped without warnings when enabled is absent (undefined)", async () => {
    // enabled: undefined must behave the same as enabled: false — tier skipped, no warnings.
    mockPullGet.mockResolvedValue(prResponse([]));

    const warnings: string[] = [];
    const result = await resolveModel(
      octokit,
      "pr",
      13,
      "owner",
      "repo",
      "haiku",
      "review",
      {
        pairingConfig: {
          // enabled is intentionally absent (undefined)
          policy: "different-vendor-same-class",
          preferred_vendors: ["openai", "xai", "anthropic"],
          fallback_chain: ["default-model"],
        },
        authoringModel: "sonnet",
        availableProviders: ["anthropic", "openai", "xai"],
      },
      (msg) => warnings.push(msg),
    );

    expect(result).toBe("haiku"); // fell through to default without running tier
    expect(warnings).toHaveLength(0); // no spurious warning about "returned no model"
  });
});
