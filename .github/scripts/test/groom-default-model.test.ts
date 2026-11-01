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
 * Additionally, the groom reusable must pass the same resolved anchor into
 * the agent container as GROOM_VENDOR_ANCHOR_MODEL so the groom prompt can
 * read the vendor-anchor model without re-deriving it from AGENT_MODEL.
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

describe("agent-groom-reusable.yml — GROOM_VENDOR_ANCHOR_MODEL container env var", () => {
  it("passes GROOM_VENDOR_ANCHOR_MODEL into the grooming agent container", () => {
    // The resolved anchor expression must be forwarded to the container so the
    // groom prompt can read the vendor-anchor model without re-deriving it from
    // AGENT_MODEL.
    expect(groomReusableContent).toContain("GROOM_VENDOR_ANCHOR_MODEL");
  });

  it("GROOM_VENDOR_ANCHOR_MODEL uses the same fallback expression as default-model", () => {
    // Both the resolve-model input and the container env var must read the same
    // expression so they always agree on the anchor model.
    const matches = groomReusableContent.match(
      /vars\.GROOM_DEFAULT_MODEL \|\| vars\.DEFAULT_MODEL/g,
    );
    expect(matches).not.toBeNull();
    // At minimum two occurrences: one for the resolve-model default-model input
    // and one for GROOM_VENDOR_ANCHOR_MODEL.
    expect(matches!.length).toBeGreaterThanOrEqual(2);
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
// Prompt consumption tests — groom.md reads GROOM_VENDOR_ANCHOR_MODEL so the
// label provider agrees with the configured grooming default.
// ---------------------------------------------------------------------------

describe("docker/scripts/prompts/groom.md — GROOM_VENDOR_ANCHOR_MODEL prompt consumption", () => {
  it("groom.md references GROOM_VENDOR_ANCHOR_MODEL for fallback vendor selection", () => {
    // The prompt must read the anchor variable so the grooming agent uses the
    // configured provider (Anthropic, OpenAI, or xAI) when choosing a model
    // label, rather than always defaulting to Anthropic regardless of what
    // GROOM_DEFAULT_MODEL is set to.
    expect(groomPromptContent).toContain("GROOM_VENDOR_ANCHOR_MODEL");
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

describe("docker/scripts/entrypoint.sh — GROOM_VENDOR_ANCHOR_MODEL injected into prompt context", () => {
  it("action_groom injects GROOM_VENDOR_ANCHOR_MODEL into the prompt text", () => {
    // The entrypoint must expand the variable into the prompt string so the
    // agent receives the resolved anchor value even if shell env var access
    // is unavailable — consistent with how ADMIN_ASSIGNEES is injected.
    expect(entrypointContent).toContain("GROOM_VENDOR_ANCHOR_MODEL:");
  });
});

// ---------------------------------------------------------------------------
// docs/model-guidance.md alignment tests — the guidance document must agree
// with the groom.md anchor-resolution rules so the agent receives consistent
// instructions from both sources it reads during grooming.
// ---------------------------------------------------------------------------

describe("docs/model-guidance.md — anchor-based fallback alignment with groom.md", () => {
  it("describes GROOM_VENDOR_ANCHOR_MODEL as the fallback mechanism in Provider selection", () => {
    // The guidance document must mention GROOM_VENDOR_ANCHOR_MODEL in its
    // "Provider selection during grooming" section.  Before PR #788 this step
    // read "retain Anthropic as the fallback" — a static rule that conflicts
    // with the configurable anchor introduced by GROOM_DEFAULT_MODEL.
    const providerSection = modelGuidanceContent
      .split("### Provider selection during grooming")[1]
      .split("### Anthropic tier aliases")[0];
    expect(providerSection).toContain("GROOM_VENDOR_ANCHOR_MODEL");
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
