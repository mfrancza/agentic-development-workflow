import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveModel } from "../src/lib/resolve-model.js";
import { resolveReviewerSet } from "../src/resolve-reviewer-set.js";

/**
 * End-to-end static validation for the Issue #669 model-preference policy.
 *
 * This file is the reproducible evidence artifact for Issue #672.  It
 * validates the complete policy after both implementation tasks (Issue #670
 * — design-default-model infrastructure, Issue #671 — repository
 * configuration) have landed, covering every assertion in the issue scope:
 *
 *   1. Repo-wide default is gpt-5.6-terra (terraform.tfvars → DEFAULT_MODEL).
 *   2. Design stage uses gpt-5.6-sol when no model label is present
 *      (DESIGN_DEFAULT_MODEL ≠ '' → agent-design.yml short-circuits to it).
 *   3. Per-design and generic labels still override that fallback
 *      (resolve-model waterfall: per-agent → generic → DESIGN_DEFAULT_MODEL →
 *      DEFAULT_MODEL).
 *   4. An unset/empty design default falls back to DEFAULT_MODEL
 *      (DESIGN_DEFAULT_MODEL == '' → `|| vars.DEFAULT_MODEL` fires).
 *   5. Reviewer resolver fans out sonnet and grok-4.6 (REVIEWER_MODELS Tier 2).
 *   6. sonnet routes to Anthropic — ANTHROPIC_API_KEY forwarded.
 *   7. grok-4.6 routes to xAI — XAI_API_KEY forwarded.
 *   8. gpt-5.6-terra is the repo-wide default, NOT a reviewer-set member.
 *
 * All tests are static (file reads + unit calls) so they run offline and are
 * fully reproducible without a live GitHub token or Terraform credentials.
 */

// ---------------------------------------------------------------------------
// File fixtures
// ---------------------------------------------------------------------------

const repoRoot = new URL("../../../", import.meta.url);

const tfvarsContent = readFileSync(
  new URL("terraform/terraform.tfvars", repoRoot),
  "utf8",
);

const agentDesignContent = readFileSync(
  new URL(".github/workflows/agent-design.yml", repoRoot),
  "utf8",
);

const agentDesignReusableContent = readFileSync(
  new URL(".github/workflows/agent-design-reusable.yml", repoRoot),
  "utf8",
);

const agentReviewContent = readFileSync(
  new URL(".github/workflows/agent-review.yml", repoRoot),
  "utf8",
);

const runAgentContent = readFileSync(
  new URL(".github/actions/run-agent/action.yml", repoRoot),
  "utf8",
);

const modelClassesContent = JSON.parse(
  readFileSync(
    new URL(".github/scripts/data/model-classes.json", repoRoot),
    "utf8",
  ),
) as {
  classes: Record<string, Record<string, string[]>>;
  modelToClass: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Mock Octokit — only the REST methods used by resolveReviewerSet.
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
}));

const mockPullGet = vi.fn();
const mockIssueGet = vi.fn();
const mockOctokit = {
  rest: {
    issues: { get: mockIssueGet },
    pulls: { get: mockPullGet },
  },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const octokit = mockOctokit as any;

function prResponse(labelNames: string[]) {
  return { data: { labels: labelNames.map((name) => ({ name })) } };
}

function issueResponse(labelNames: string[]) {
  return { data: { labels: labelNames.map((name) => ({ name })) } };
}

beforeEach(() => {
  mockIssueGet.mockReset();
  mockPullGet.mockReset();
});

// ---------------------------------------------------------------------------
// Assertion 1: repo-wide default is gpt-5.6-terra
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (1) repo-wide default is gpt-5.6-terra", () => {
  it("terraform.tfvars sets default_model to gpt-5.6-terra", () => {
    // The literal assignment line must be present; surrounding whitespace is
    // permitted so a reformatted file does not break the check.
    expect(tfvarsContent).toMatch(/default_model\s*=\s*"gpt-5\.6-terra"/);
  });

  it("gpt-5.6-terra is recognised in the model-classes data file", () => {
    // Must appear in modelToClass so the pairing resolver and provider-routing
    // logic can handle PRs authored by this model.
    expect(Object.keys(modelClassesContent.modelToClass)).toContain(
      "gpt-5.6-terra",
    );
  });

  it("gpt-5.6-terra is classified as sonnet class (OpenAI sonnet-tier)", () => {
    expect(modelClassesContent.modelToClass["gpt-5.6-terra"]).toBe("sonnet");
  });

  it("gpt-5.6-terra is listed as an OpenAI sonnet-class model", () => {
    expect(modelClassesContent.classes["sonnet"]["openai"]).toContain(
      "gpt-5.6-terra",
    );
  });

  it("agent-review.yml passes vars.DEFAULT_MODEL as the default-model input", () => {
    // The reviewer waterfall uses DEFAULT_MODEL as its final fallback.
    expect(agentReviewContent).toContain("default-model: ${{ vars.DEFAULT_MODEL }}");
  });
});

// ---------------------------------------------------------------------------
// Assertion 2: design stage uses gpt-5.6-sol when no model label is present
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (2) design stage uses gpt-5.6-sol by default", () => {
  it("terraform.tfvars sets design_default_model to gpt-5.6-sol", () => {
    expect(tfvarsContent).toMatch(/design_default_model\s*=\s*"gpt-5\.6-sol"/);
  });

  it("gpt-5.6-sol is recognised in the model-classes data file", () => {
    expect(Object.keys(modelClassesContent.modelToClass)).toContain(
      "gpt-5.6-sol",
    );
  });

  it("gpt-5.6-sol is classified as opus class (OpenAI opus-tier)", () => {
    expect(modelClassesContent.modelToClass["gpt-5.6-sol"]).toBe("opus");
  });

  it("agent-design.yml short-circuits to DESIGN_DEFAULT_MODEL when non-empty", () => {
    // The fallback expression `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL`
    // is present in the design caller stub; when DESIGN_DEFAULT_MODEL is set to
    // "gpt-5.6-sol" the `||` short-circuits and the design workflow uses
    // gpt-5.6-sol rather than DEFAULT_MODEL (gpt-5.6-terra).
    expect(agentDesignContent).toContain(
      "vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL",
    );
  });
});

// ---------------------------------------------------------------------------
// Assertion 3: per-design and generic labels override the design default
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (3) per-design and generic labels override DESIGN_DEFAULT_MODEL", () => {
  it("agent-design-reusable.yml resolves issue labels with agent-type: design", () => {
    expect(agentDesignReusableContent).toMatch(
      /subject-type: issue[\s\S]*?agent-type: design/,
    );
  });

  it("per-design label (model:design:sonnet) overrides gpt-5.6-sol", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["model:design:sonnet"]));

    const result = await resolveModel(
      octokit,
      "issue",
      1,
      "owner",
      "repo",
      "gpt-5.6-sol",
      "design",
    );

    expect(result).toBe("sonnet");
  });

  it("generic model:* label overrides gpt-5.6-sol", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["model:opus"]));

    const result = await resolveModel(
      octokit,
      "issue",
      2,
      "owner",
      "repo",
      "gpt-5.6-sol",
      "design",
    );

    expect(result).toBe("opus");
  });
});

// ---------------------------------------------------------------------------
// Assertion 4: unset/empty design default falls back to DEFAULT_MODEL
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (4) empty DESIGN_DEFAULT_MODEL falls back to DEFAULT_MODEL", () => {
  it("agent-design.yml uses || so empty DESIGN_DEFAULT_MODEL evaluates to DEFAULT_MODEL", () => {
    // The `||` operator in `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL`
    // evaluates the right side when the left side is empty ('').  This
    // preserves backward compatibility for repos that have not set
    // DESIGN_DEFAULT_MODEL.
    expect(agentDesignContent).toContain(
      "vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL",
    );
    // The pre-feature bare form must NOT be present on the default-model line
    // (confirmed also by the design-default-model.test.ts suite).
    expect(agentDesignContent).not.toContain(
      "default-model: ${{ vars.DEFAULT_MODEL }}",
    );
  });

  it("terraform variables.tf default for design_default_model is empty string", () => {
    const variablesTfContent = readFileSync(
      new URL("terraform/variables.tf", repoRoot),
      "utf8",
    );
    // An empty-string default means 'not set' — the `||` fires and falls
    // through to DEFAULT_MODEL ("gpt-5.6-terra") for any repo that omits the
    // variable.
    expect(variablesTfContent).toMatch(
      /variable "design_default_model"[\s\S]*?default\s*=\s*""/,
    );
  });

  it("agent-vars module propagates design_default_model as DESIGN_DEFAULT_MODEL Actions var", () => {
    const agentVarsMainTf = readFileSync(
      new URL("terraform/modules/agent-vars/main.tf", repoRoot),
      "utf8",
    );
    expect(agentVarsMainTf).toContain('"DESIGN_DEFAULT_MODEL"');
    expect(agentVarsMainTf).toContain(
      'resource "github_actions_variable" "design_default_model"',
    );
  });
});

// ---------------------------------------------------------------------------
// Assertion 5: reviewer resolver fans out sonnet and grok-4.6
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (5) reviewer resolver fans out sonnet and grok-4.6", () => {
  it("terraform.tfvars sets reviewer_models to [sonnet, grok-4.6]", () => {
    // The literal list must be present; bracket and quote forms may vary.
    expect(tfvarsContent).toMatch(
      /reviewer_models\s*=\s*\[\s*"sonnet"\s*,\s*"grok-4\.6"\s*\]/,
    );
  });

  it("agent-review.yml passes vars.REVIEWER_MODELS to the reviewer-models input", () => {
    expect(agentReviewContent).toContain(
      "reviewer-models: ${{ vars.REVIEWER_MODELS }}",
    );
  });

  it("resolve-reviewer-set returns both models when REVIEWER_MODELS=[sonnet,grok-4.6] and no labels", async () => {
    // Tier 2 fires because REVIEWER_MODELS is non-empty and no model:review:*
    // labels are present.  Both models are returned so the matrix job fans out.
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(
      octokit,
      10,
      "owner",
      "repo",
      ["sonnet", "grok-4.6"],
      "gpt-5.6-terra",
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ model: "sonnet" });
    expect(result[1]).toEqual({ model: "grok-4.6" });
  });

  it("each resolved entry has a model property (satisfies strategy.matrix.include shape)", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(
      octokit,
      11,
      "owner",
      "repo",
      ["sonnet", "grok-4.6"],
      "gpt-5.6-terra",
    );

    expect(result.every((e) => typeof e.model === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Assertion 6: sonnet routes to Anthropic (ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (6) sonnet routes to Anthropic", () => {
  it("run-agent action routes sonnet to ANTHROPIC_API_KEY", () => {
    // The routing case in run-agent/action.yml must include sonnet in the
    // Anthropic branch.  This is the exact string the test in
    // run-agent-provider-key.test.ts pins.
    expect(runAgentContent).toContain(
      "sonnet|opus|haiku|claude-*) _key_env=(-e ANTHROPIC_API_KEY)",
    );
  });

  it("sonnet is classified as an Anthropic model in model-classes.json", () => {
    // The class table confirms sonnet is an Anthropic sonnet-class model.
    expect(modelClassesContent.classes["sonnet"]["anthropic"]).toContain("sonnet");
  });

  it("sonnet class and vendor produce an Anthropic canonical pick", () => {
    // The canonical pick for (sonnet, anthropic) is "sonnet" itself.
    expect(modelClassesContent.classes["sonnet"]["anthropic"][0]).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// Assertion 7: grok-4.6 routes to xAI (XAI_API_KEY)
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (7) grok-4.6 routes to xAI", () => {
  it("run-agent action routes grok-* to XAI_API_KEY", () => {
    expect(runAgentContent).toContain(
      "grok-*)                     _key_env=(-e XAI_API_KEY)",
    );
  });

  it("grok-4.6 is classified as opus class in model-classes.json", () => {
    expect(modelClassesContent.modelToClass["grok-4.6"]).toBe("opus");
  });

  it("grok-4.6 is listed as an xAI opus-class model", () => {
    expect(modelClassesContent.classes["opus"]["xai"]).toContain("grok-4.6");
  });
});

// ---------------------------------------------------------------------------
// Assertion 8: gpt-5.6-terra is the repo-wide default, NOT a reviewer-set member
// ---------------------------------------------------------------------------

describe("Issue #669 policy — (8) gpt-5.6-terra is the repo-wide default, not a reviewer-set member", () => {
  it("terraform.tfvars reviewer_models list does not include gpt-5.6-terra", () => {
    // Extract the reviewer_models value from the file and confirm the terra
    // model is absent.  The list must contain only sonnet and grok-4.6.
    const match = tfvarsContent.match(
      /reviewer_models\s*=\s*(\[[^\]]*\])/,
    );
    expect(match, "reviewer_models assignment must be present").not.toBeNull();
    const listLiteral = match![1];
    expect(listLiteral).not.toContain("gpt-5.6-terra");
  });

  it("resolve-reviewer-set does not return gpt-5.6-terra in the fanned-out set", async () => {
    // With REVIEWER_MODELS=["sonnet","grok-4.6"] and no labels, Tier 2 fires
    // and the set is exactly [sonnet, grok-4.6].  gpt-5.6-terra appears only
    // as the default-model fallback, which is bypassed when Tier 2 matches.
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(
      octokit,
      20,
      "owner",
      "repo",
      ["sonnet", "grok-4.6"],
      "gpt-5.6-terra", // the repo-wide default — must NOT appear in result
    );

    const models = result.map((e) => e.model);
    expect(models).not.toContain("gpt-5.6-terra");
    expect(models).toEqual(["sonnet", "grok-4.6"]);
  });

  it("gpt-5.6-terra only appears in the result when REVIEWER_MODELS is empty and no label is present", async () => {
    // This test confirms the expected Tier 3 fallback behaviour: when both
    // Tier 1 and Tier 2 are inactive, gpt-5.6-terra (the DEFAULT_MODEL) is the
    // single-reviewer result, matching the repo-wide default role.
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(
      octokit,
      21,
      "owner",
      "repo",
      [],            // empty REVIEWER_MODELS → Tier 2 skipped
      "gpt-5.6-terra",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ model: "gpt-5.6-terra" });
  });
});
