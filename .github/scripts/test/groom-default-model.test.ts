import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Focused validation for the GROOM_DEFAULT_MODEL → DEFAULT_MODEL fallback
 * wiring introduced in the agent-groom reusable workflow.
 *
 * Two behaviors under test:
 *
 *   Configured  — When GROOM_DEFAULT_MODEL is non-empty, the `||` short-
 *                 circuits and the groom workflow uses GROOM_DEFAULT_MODEL.
 *   Legacy fallback — When GROOM_DEFAULT_MODEL is empty (the default), the
 *                 `||` falls through and the groom workflow uses DEFAULT_MODEL,
 *                 preserving behavior for repos that have not set the variable.
 *
 * Both behaviors depend on the reusable expressing the model input as
 * `vars.GROOM_DEFAULT_MODEL || vars.DEFAULT_MODEL`.  These static tests
 * confirm that expression is present and that the prior bare-DEFAULT_MODEL
 * form is absent from the default-model input line.
 *
 * Separately, the groom reusable passes the downstream defaults into the agent
 * container as the vendor anchors (GROOM_IMPL_ANCHOR_MODEL = DEFAULT_MODEL,
 * GROOM_DESIGN_ANCHOR_MODEL = DESIGN_DEFAULT_MODEL || DEFAULT_MODEL).
 * GROOM_DEFAULT_MODEL must never feed an anchor: a cheaper groomer would
 * otherwise leave mechanical tasks unlabeled (Issue #794).
 */

const repoRoot = new URL("../../../", import.meta.url);
const workflowsDir = new URL(".github/workflows/", repoRoot);
const terraformDir = new URL("terraform/", repoRoot);
const dockerDir = new URL("docker/scripts/", repoRoot);

const groomReusableContent = readFileSync(
  new URL("agent-groom-reusable.yml", workflowsDir),
  "utf8",
);

const groomPromptContent = readFileSync(
  new URL("prompts/groom.md", dockerDir),
  "utf8",
);

const entrypointContent = readFileSync(
  new URL("entrypoint.sh", dockerDir),
  "utf8",
);

const agentVarsMainContent = readFileSync(
  new URL("modules/agent-vars/main.tf", terraformDir),
  "utf8",
);

const rootVariablesContent = readFileSync(
  new URL("variables.tf", terraformDir),
  "utf8",
);

const agentVarsVariablesContent = readFileSync(
  new URL("modules/agent-vars/variables.tf", terraformDir),
  "utf8",
);

const modelGuidanceContent = readFileSync(
  new URL("docs/model-guidance.md", repoRoot),
  "utf8",
);

// ---------------------------------------------------------------------------
// Workflow wiring tests
// ---------------------------------------------------------------------------

describe("agent-groom-reusable.yml — GROOM_DEFAULT_MODEL fallback wiring", () => {
  it("configured: uses vars.GROOM_DEFAULT_MODEL preferred over vars.DEFAULT_MODEL", () => {
    // When GROOM_DEFAULT_MODEL is non-empty the `||` short-circuits and the
    // groom workflow uses the groom-specific value.  The expression must be
    // present verbatim in the reusable workflow.
    expect(groomReusableContent).toContain(
      "vars.GROOM_DEFAULT_MODEL || vars.DEFAULT_MODEL",
    );
  });

  it("legacy fallback: does not pass bare vars.DEFAULT_MODEL as the default-model value", () => {
    // The pre-feature form `default-model: ${{ vars.DEFAULT_MODEL }}` must be
    // replaced by the fallback expression above.  If the bare form is still
    // present, the groom stage cannot be overridden independently of other
    // agent types.
    expect(groomReusableContent).not.toContain(
      "default-model: ${{ vars.DEFAULT_MODEL }}",
    );
  });
});

describe("agent-groom-reusable.yml — vendor anchor container env vars", () => {
  it("anchors implementation tasks on DEFAULT_MODEL", () => {
    expect(groomReusableContent).toContain(
      "GROOM_IMPL_ANCHOR_MODEL: ${{ vars.DEFAULT_MODEL }}",
    );
  });

  it("anchors design tasks on DESIGN_DEFAULT_MODEL || DEFAULT_MODEL", () => {
    expect(groomReusableContent).toContain(
      "GROOM_DESIGN_ANCHOR_MODEL: ${{ vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL }}",
    );
  });

  it("uses GROOM_DEFAULT_MODEL only for the groomer's execution model, never as an anchor", () => {
    // Exactly one reference: the resolve-model default-model input.  A second
    // reference would mean an anchor is tied to the groomer's own model again.
    const matches = groomReusableContent.match(/vars\.GROOM_DEFAULT_MODEL/g);
    expect(matches).toHaveLength(1);
    expect(groomReusableContent).not.toContain("GROOM_VENDOR_ANCHOR_MODEL");
  });
});

describe("run-agent action — forwards the grooming vendor anchors", () => {
  it("passes both anchor env vars into the container when set", () => {
    const runAgentContent = readFileSync(
      new URL(".github/actions/run-agent/action.yml", repoRoot),
      "utf8",
    );
    expect(runAgentContent).toContain(
      '-e GROOM_IMPL_ANCHOR_MODEL="${GROOM_IMPL_ANCHOR_MODEL}"',
    );
    expect(runAgentContent).toContain(
      '-e GROOM_DESIGN_ANCHOR_MODEL="${GROOM_DESIGN_ANCHOR_MODEL}"',
    );
  });
});

// ---------------------------------------------------------------------------
// Terraform variable tests
// ---------------------------------------------------------------------------

describe("terraform/variables.tf — groom_default_model backward compatibility", () => {
  it("declares groom_default_model with an empty string default", () => {
    // The empty default preserves existing behavior: repos that do not set
    // groom_default_model fall through to DEFAULT_MODEL unchanged.
    expect(rootVariablesContent).toContain('variable "groom_default_model"');
    expect(rootVariablesContent).toMatch(
      /variable "groom_default_model"[\s\S]*?default\s*=\s*""/,
    );
  });
});

describe("terraform/modules/agent-vars/variables.tf — groom_default_model", () => {
  it("declares groom_default_model with an empty string default", () => {
    expect(agentVarsVariablesContent).toContain(
      'variable "groom_default_model"',
    );
    expect(agentVarsVariablesContent).toMatch(
      /variable "groom_default_model"[\s\S]*?default\s*=\s*""/,
    );
  });
});

describe("terraform/modules/agent-vars/main.tf — GROOM_DEFAULT_MODEL Actions variable", () => {
  it("creates the GROOM_DEFAULT_MODEL Actions variable", () => {
    expect(agentVarsMainContent).toContain('"GROOM_DEFAULT_MODEL"');
    expect(agentVarsMainContent).toContain(
      'resource "github_actions_variable" "groom_default_model"',
    );
  });

  it("uses count = 0 when groom_default_model is empty to avoid GitHub 422 rejection", () => {
    expect(agentVarsMainContent).toMatch(
      /resource "github_actions_variable" "groom_default_model"[\s\S]*?count\s*=\s*var\.groom_default_model\s*==\s*""\s*\?\s*0\s*:\s*1/,
    );
  });
});

// ---------------------------------------------------------------------------
// Prompt consumption tests — groom.md picks the anchor for the task family so
// the label decision follows the downstream defaults.
// ---------------------------------------------------------------------------

describe("docker/scripts/prompts/groom.md — vendor anchor prompt consumption", () => {
  it("groom.md selects GROOM_DESIGN_ANCHOR_MODEL or GROOM_IMPL_ANCHOR_MODEL by task family", () => {
    expect(groomPromptContent).toContain(
      "`GROOM_DESIGN_ANCHOR_MODEL` for design-family tasks, `GROOM_IMPL_ANCHOR_MODEL` for implementation-family tasks",
    );
  });

  it("groom.md tells the agent not to anchor on its own execution model", () => {
    expect(groomPromptContent).toContain(
      "Do **not** anchor on the model you are running on",
    );
  });

  it("groom.md records the task family in the grooming comment", () => {
    expect(groomPromptContent).toContain("**Task family**");
  });

  it("groom.md maps gpt-* prefix to OpenAI provider", () => {
    // When the anchor is an OpenAI model the prompt must direct the agent to
    // select an OpenAI label, not fall through to Anthropic.
    expect(groomPromptContent).toContain("gpt-*");
  });

  it("groom.md maps grok-* prefix to xAI provider", () => {
    // When the anchor is an xAI model the prompt must direct the agent to
    // select an xAI label, not fall through to Anthropic.
    expect(groomPromptContent).toContain("grok-*");
  });
});

describe("docker/scripts/entrypoint.sh — vendor anchors injected into prompt context", () => {
  it("action_groom injects both anchors into the prompt text", () => {
    // The entrypoint must expand the variables into the prompt string so the
    // agent receives the anchor values even if shell env var access is
    // unavailable — consistent with how ADMIN_ASSIGNEES is injected.
    expect(entrypointContent).toContain(
      "GROOM_IMPL_ANCHOR_MODEL: ${GROOM_IMPL_ANCHOR_MODEL:-}",
    );
    expect(entrypointContent).toContain(
      "GROOM_DESIGN_ANCHOR_MODEL: ${GROOM_DESIGN_ANCHOR_MODEL:-}",
    );
  });
});

// ---------------------------------------------------------------------------
// docs/model-guidance.md alignment tests — the guidance document must agree
// with the groom.md anchor-resolution rules so the agent receives consistent
// instructions from both sources it reads during grooming.
// ---------------------------------------------------------------------------

describe("docs/model-guidance.md — anchor-based fallback alignment with groom.md", () => {
  it("describes the per-family anchors in Provider selection", () => {
    // The guidance document must name both anchors in its "Provider selection
    // during grooming" section, and state that GROOM_DEFAULT_MODEL is not one.
    const providerSection = modelGuidanceContent
      .split("### Provider selection during grooming")[1]
      .split("### Anthropic tier aliases")[0];
    expect(providerSection).toContain("GROOM_IMPL_ANCHOR_MODEL");
    expect(providerSection).toContain("GROOM_DESIGN_ANCHOR_MODEL");
    expect(providerSection).toContain("`GROOM_DEFAULT_MODEL` is deliberately not an anchor");
    expect(providerSection).not.toContain("GROOM_VENDOR_ANCHOR_MODEL");
  });

  it("guidance documents the gpt-* → OpenAI anchor rule", () => {
    // Must match the routing rule in groom.md so the two sources agree.
    const providerSection = modelGuidanceContent
      .split("### Provider selection during grooming")[1]
      .split("### Anthropic tier aliases")[0];
    expect(providerSection).toMatch(/gpt-\*/);
  });

  it("guidance documents the grok-* → xAI anchor rule", () => {
    // Must match the routing rule in groom.md so the two sources agree.
    const providerSection = modelGuidanceContent
      .split("### Provider selection during grooming")[1]
      .split("### Anthropic tier aliases")[0];
    expect(providerSection).toMatch(/grok-\*/);
  });

  it("guidance documents Anthropic as the safe default when the anchor is empty or unrecognized", () => {
    // Even though the static "retain Anthropic" fallback was replaced, the
    // anchor-resolution path must still name Anthropic as the empty/unrecognized
    // safe default — preventing silent vendor drift on misconfiguration.
    const providerSection = modelGuidanceContent
      .split("### Provider selection during grooming")[1]
      .split("### Anthropic tier aliases")[0];
    expect(providerSection).toMatch(/Anthropic.*safe default|safe default.*Anthropic/is);
  });
});
