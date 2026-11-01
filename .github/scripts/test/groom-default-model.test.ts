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

const groomReusableContent = readFileSync(
  new URL("agent-groom-reusable.yml", workflowsDir),
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
