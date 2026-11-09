import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveModel } from "../src/lib/resolve-model.js";
import { resolveReviewerSet } from "../src/resolve-reviewer-set.js";
import { selectReviewerModel, type PairingConfig } from "../src/lib/model-pair.js";
import { classTable, modelToClass } from "../src/lib/model-classes.js";

/**
 * End-to-end static validation for this repository's model-preference policy
 * as configured in terraform/terraform.tfvars:
 *
 *   1. Repo-wide DEFAULT_MODEL is set in terraform.tfvars.
 *   2. Design stage uses DESIGN_DEFAULT_MODEL when non-empty
 *      (DESIGN_DEFAULT_MODEL ≠ '' → agent-design.yml short-circuits to it).
 *   3. Per-design and generic labels still override that fallback
 *      (resolve-model waterfall: per-agent → generic → DESIGN_DEFAULT_MODEL →
 *      DEFAULT_MODEL).
 *   4. An unset/empty design default falls back to DEFAULT_MODEL
 *      (DESIGN_DEFAULT_MODEL == '' → `|| vars.DEFAULT_MODEL` fires).
 *   5. REVIEWER_MODELS is empty so the reviewer resolver reaches the pairing
 *      tier, and REVIEW_MODEL_PAIRING uses an explicit map that pairs each
 *      Anthropic authoring model with its same-class OpenAI equivalent.
 *   6. Anthropic models route to ANTHROPIC_API_KEY.
 *   7. OpenAI reviewer models route to OPENAI_API_KEY.
 *   8. The default authoring model is never selected as its own reviewer.
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

const agentDesignReusableContent = readFileSync(
  new URL(".github/workflows/agent-design-reusable.yml", repoRoot),
  "utf8",
);

const agentGroomReusableContent = readFileSync(
  new URL(".github/workflows/agent-groom-reusable.yml", repoRoot),
  "utf8",
);

const agentReviewContent = readFileSync(
  new URL(".github/workflows/agent-review.yml", repoRoot),
  "utf8",
);

const agentReviewWorkerContent = readFileSync(
  new URL(".github/workflows/agent-review-worker-reusable.yml", repoRoot),
  "utf8",
);

const runAgentContent = readFileSync(
  new URL(".github/actions/run-agent/action.yml", repoRoot),
  "utf8",
);

/**
 * Extract the `explicit_map = { ... }` entries from terraform.tfvars as a
 * plain object.  Only quoted `"key" = "value"` pairs are recognised, which is
 * the form `terraform fmt` produces for this map.
 */
function parseExplicitMap(content: string): Record<string, string> {
  const block = content.match(/explicit_map\s*=\s*\{([^}]*)\}/);
  if (!block) return {};
  const entries: Record<string, string> = {};
  for (const m of block[1].matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)) {
    entries[m[1]] = m[2];
  }
  return entries;
}

const explicitMap = parseExplicitMap(tfvarsContent);

const repoPairingConfig: PairingConfig = {
  enabled: true,
  policy: "explicit-map",
  preferred_vendors: ["openai", "xai", "anthropic"],
  explicit_map: explicitMap,
  fallback_chain: [
    "different-vendor-same-class",
    "same-vendor-different-model",
    "default-model",
  ],
};

const ALL_PROVIDERS = ["anthropic", "openai", "xai"];

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
// Assertion 1: DEFAULT_MODEL is wired to the review worker
// ---------------------------------------------------------------------------

describe("Model policy — (1) repo-wide DEFAULT_MODEL is wired to the review worker", () => {
  it("review worker resolves the final fallback from vars.DEFAULT_MODEL", () => {
    // The reviewer waterfall uses DEFAULT_MODEL as its final fallback.
    expect(agentReviewWorkerContent).toContain("default-model: ${{ vars.DEFAULT_MODEL }}");
  });
});

// ---------------------------------------------------------------------------
// Assertion 2: DESIGN_DEFAULT_MODEL is wired to the design stage
// ---------------------------------------------------------------------------

describe("Model policy — (2) design stage uses DESIGN_DEFAULT_MODEL when set", () => {
  it("agent-design reusable short-circuits to DESIGN_DEFAULT_MODEL when non-empty", () => {
    // The fallback expression `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL`
    // is present in the design reusable; when DESIGN_DEFAULT_MODEL is non-empty
    // the `||` short-circuits and the design workflow uses it rather than
    // falling through to DEFAULT_MODEL.
    expect(agentDesignReusableContent).toContain(
      "vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL",
    );
  });
});

// ---------------------------------------------------------------------------
// Assertion 3: per-design and generic labels override the design default
// ---------------------------------------------------------------------------

describe("Model policy — (3) per-design and generic labels override DESIGN_DEFAULT_MODEL", () => {
  it("agent-design-reusable.yml resolves issue labels with agent-type: design", () => {
    expect(agentDesignReusableContent).toMatch(
      /subject-type: issue[\s\S]*?agent-type: design/,
    );
  });

  it("per-design label (model:design:sonnet) overrides opus", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["model:design:sonnet"]));

    const result = await resolveModel(
      octokit,
      "issue",
      1,
      "owner",
      "repo",
      "opus",
      "design",
    );

    expect(result).toBe("sonnet");
  });

  it("generic model:* label overrides opus", async () => {
    mockIssueGet.mockResolvedValue(issueResponse(["model:haiku"]));

    const result = await resolveModel(
      octokit,
      "issue",
      2,
      "owner",
      "repo",
      "opus",
      "design",
    );

    expect(result).toBe("haiku");
  });
});

// ---------------------------------------------------------------------------
// Assertion 4: unset/empty design default falls back to DEFAULT_MODEL
// ---------------------------------------------------------------------------

describe("Model policy — (4) empty DESIGN_DEFAULT_MODEL falls back to DEFAULT_MODEL", () => {
  it("agent-design reusable uses || so empty DESIGN_DEFAULT_MODEL evaluates to DEFAULT_MODEL", () => {
    // The `||` operator in `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL`
    // evaluates the right side when the left side is empty ('').  This
    // preserves backward compatibility for repos that have not set
    // DESIGN_DEFAULT_MODEL.
    expect(agentDesignReusableContent).toContain(
      "vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL",
    );
    // The pre-feature bare form must NOT be present on the default-model line
    // (confirmed also by the design-default-model.test.ts suite).
    expect(agentDesignReusableContent).not.toContain(
      "default-model: ${{ vars.DEFAULT_MODEL }}",
    );
  });

  it("terraform variables.tf default for design_default_model is empty string", () => {
    const variablesTfContent = readFileSync(
      new URL("terraform/variables.tf", repoRoot),
      "utf8",
    );
    // An empty-string default means 'not set' — the `||` fires and falls
    // through to DEFAULT_MODEL for any repo that omits the variable.
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
// Assertion 5: reviewers are picked by explicit Anthropic → OpenAI pairing
// ---------------------------------------------------------------------------

describe("Model policy — (5) reviewers are paired Anthropic → OpenAI via explicit map", () => {
  it("terraform.tfvars sets reviewer_models to [] so the pairing tier is reachable", () => {
    // A non-empty REVIEWER_MODELS list is Tier 2 in resolve-reviewer-set and
    // would bypass pairing entirely.
    expect(tfvarsContent).toMatch(/reviewer_models\s*=\s*\[\s*\]/);
  });

  it("agent-review.yml passes vars.REVIEWER_MODELS to the reviewer-models input", () => {
    expect(agentReviewContent).toContain(
      "reviewer-models: ${{ vars.REVIEWER_MODELS }}",
    );
  });

  it("terraform.tfvars enables review_model_pairing with the explicit-map policy", () => {
    expect(tfvarsContent).toMatch(
      /review_model_pairing\s*=\s*\{[\s\S]*?enabled\s*=\s*true[\s\S]*?policy\s*=\s*"explicit-map"/,
    );
  });

  it("explicit_map pairs every Anthropic tier alias and pinned 5.5 ID with an OpenAI model", () => {
    expect(explicitMap).toEqual({
      haiku: "gpt-5.6-luna",
      sonnet: "gpt-5.6-terra",
      opus: "gpt-5.6-sol",
      "claude-haiku-5-5": "gpt-5.6-luna",
      "claude-sonnet-5-5": "gpt-5.6-terra",
      "claude-opus-5-5": "gpt-5.6-sol",
    });
  });

  it.each(["haiku", "sonnet", "opus"] as const)(
    "%s maps to the canonical OpenAI pick of the same class",
    (alias) => {
      expect(explicitMap[alias]).toBe(classTable[modelToClass[alias]].openai[0]);
    },
  );

  it("resolve-reviewer-set falls through to a single reviewer when REVIEWER_MODELS is empty", async () => {
    mockPullGet.mockResolvedValue(prResponse([]));

    const result = await resolveReviewerSet(
      octokit,
      10,
      "owner",
      "repo",
      [], // empty REVIEWER_MODELS → Tier 2 skipped
      "sonnet",
    );

    expect(result).toEqual([{ model: "sonnet" }]);
  });

  it.each([
    ["sonnet", "gpt-5.6-terra"],
    ["opus", "gpt-5.6-sol"],
    ["claude-haiku-5-5", "gpt-5.6-luna"],
  ])("pairing selects %s → %s as the primary pick", (author, reviewer) => {
    const result = selectReviewerModel(
      author,
      repoPairingConfig,
      ALL_PROVIDERS,
      classTable,
      "sonnet",
      modelToClass,
    );

    expect(result.model).toBe(reviewer);
    expect(result.source).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// Assertion 6: Anthropic models route to ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------

describe("Model policy — (6) Anthropic models route to Anthropic", () => {
  it("run-agent action routes sonnet/opus/haiku/claude-* to ANTHROPIC_API_KEY", () => {
    // This is the exact string the test in run-agent-provider-key.test.ts pins.
    expect(runAgentContent).toContain(
      "sonnet|opus|haiku|claude-*) _key_env=(-e ANTHROPIC_API_KEY)",
    );
  });

  it("sonnet class and vendor produce an Anthropic canonical pick", () => {
    expect(classTable.sonnet.anthropic[0]).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// Assertion 7: OpenAI reviewer models route to OPENAI_API_KEY
// ---------------------------------------------------------------------------

describe("Model policy — (7) OpenAI reviewer models route to OpenAI", () => {
  it("run-agent action routes gpt-* to OPENAI_API_KEY", () => {
    expect(runAgentContent).toContain(
      "gpt-*|o[0-9]*)              _key_env=(-e OPENAI_API_KEY)",
    );
  });

  it("every explicit_map reviewer is a gpt-* model", () => {
    for (const reviewer of Object.values(explicitMap)) {
      expect(reviewer).toMatch(/^gpt-/);
    }
  });
});

// ---------------------------------------------------------------------------
// Assertion 8: the default authoring model is never its own reviewer
// ---------------------------------------------------------------------------

describe("Model policy — (8) the default authoring model is not its own reviewer", () => {
  it("pairing for a sonnet-authored PR does not return sonnet", () => {
    const result = selectReviewerModel(
      "sonnet",
      repoPairingConfig,
      ALL_PROVIDERS,
      classTable,
      "sonnet",
      modelToClass,
    );

    expect(result.model).not.toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// Assertion 9: GROOM_DEFAULT_MODEL wins over DEFAULT_MODEL for the groomer's
// own model, while the vendor anchors stay on the downstream defaults
// ---------------------------------------------------------------------------

describe("Model policy — (9) GROOM_DEFAULT_MODEL precedence and downstream vendor anchors", () => {
  it("GROOM_DEFAULT_MODEL wins over DEFAULT_MODEL: agent-groom reusable short-circuits to GROOM_DEFAULT_MODEL when non-empty", () => {
    // The fallback expression `vars.GROOM_DEFAULT_MODEL || vars.DEFAULT_MODEL`
    // is present in the groom reusable; when GROOM_DEFAULT_MODEL is set the `||`
    // short-circuits and the groom workflow uses the groom-specific value rather
    // than DEFAULT_MODEL.
    expect(agentGroomReusableContent).toContain(
      "vars.GROOM_DEFAULT_MODEL || vars.DEFAULT_MODEL",
    );
  });

  it("GROOM_DEFAULT_MODEL falls back to DEFAULT_MODEL when empty: bare DEFAULT_MODEL form is absent", () => {
    // The pre-feature bare form `default-model: ${{ vars.DEFAULT_MODEL }}` must
    // be absent — an empty GROOM_DEFAULT_MODEL evaluates as falsy and the `||`
    // falls through to DEFAULT_MODEL transparently without any bare form.
    expect(agentGroomReusableContent).not.toContain(
      "default-model: ${{ vars.DEFAULT_MODEL }}",
    );
  });

  it("the vendor anchors are the downstream defaults, not the groomer's model", () => {
    // When GROOM_DEFAULT_MODEL differs from DEFAULT_MODEL, anchoring on the
    // groomer's own model would leave mechanical tasks unlabeled and run them
    // on DEFAULT_MODEL downstream (Issue #794).
    expect(agentGroomReusableContent).toContain(
      "GROOM_IMPL_ANCHOR_MODEL: ${{ vars.DEFAULT_MODEL }}",
    );
    expect(agentGroomReusableContent).toContain(
      "GROOM_DESIGN_ANCHOR_MODEL: ${{ vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL }}",
    );
    expect(agentGroomReusableContent.match(/vars\.GROOM_DEFAULT_MODEL/g)).toHaveLength(1);
  });
});
