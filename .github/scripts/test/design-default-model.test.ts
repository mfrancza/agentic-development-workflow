import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Focused validation for the DESIGN_DEFAULT_MODEL → DEFAULT_MODEL fallback
 * wiring introduced in the agent-design caller stub.
 *
 * Two behaviors under test:
 *
 *   Configured  — When DESIGN_DEFAULT_MODEL is non-empty, the `||` short-
 *                 circuits and the design workflow uses DESIGN_DEFAULT_MODEL.
 *   Legacy fallback — When DESIGN_DEFAULT_MODEL is empty (the default), the
 *                 `||` falls through and the design workflow uses DEFAULT_MODEL,
 *                 preserving behavior for repos that have not set the variable.
 *
 * Both behaviors depend on the caller stub expressing the model input as
 * `vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL`.  These static tests
 * confirm that expression is present and that the prior bare-DEFAULT_MODEL
 * form is absent from the default-model input line.
 */

const repoRoot = new URL("../../../", import.meta.url);
const workflowsDir = new URL(".github/workflows/", repoRoot);
const terraformDir = new URL("terraform/", repoRoot);

const designCallerContent = readFileSync(
  new URL("agent-design.yml", workflowsDir),
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

describe("agent-design.yml — DESIGN_DEFAULT_MODEL fallback wiring", () => {
  it("configured: uses vars.DESIGN_DEFAULT_MODEL preferred over vars.DEFAULT_MODEL", () => {
    // When DESIGN_DEFAULT_MODEL is non-empty the `||` short-circuits and the
    // design workflow uses the design-specific value.  The expression must be
    // present verbatim in the caller stub.
    expect(designCallerContent).toContain(
      "vars.DESIGN_DEFAULT_MODEL || vars.DEFAULT_MODEL",
    );
  });

  it("legacy fallback: does not pass bare vars.DEFAULT_MODEL as the default-model value", () => {
    // The pre-feature form `default-model: ${{ vars.DEFAULT_MODEL }}` must be
    // replaced by the fallback expression above.  If the bare form is still
    // present, the design stage cannot be overridden independently of other
    // agent types.
    expect(designCallerContent).not.toContain(
      "default-model: ${{ vars.DEFAULT_MODEL }}",
    );
  });
});

// ---------------------------------------------------------------------------
// Terraform variable tests
// ---------------------------------------------------------------------------

describe("terraform/variables.tf — design_default_model backward compatibility", () => {
  it("declares design_default_model with an empty string default", () => {
    // The empty default preserves existing behavior: repos that do not set
    // design_default_model fall through to DEFAULT_MODEL unchanged.
    expect(rootVariablesContent).toContain('variable "design_default_model"');
    expect(rootVariablesContent).toMatch(
      /variable "design_default_model"[\s\S]*?default\s*=\s*""/,
    );
  });
});

describe("terraform/modules/agent-vars/variables.tf — design_default_model", () => {
  it("declares design_default_model with an empty string default", () => {
    expect(agentVarsVariablesContent).toContain(
      'variable "design_default_model"',
    );
    expect(agentVarsVariablesContent).toMatch(
      /variable "design_default_model"[\s\S]*?default\s*=\s*""/,
    );
  });
});

describe("terraform/modules/agent-vars/main.tf — DESIGN_DEFAULT_MODEL Actions variable", () => {
  it("creates the DESIGN_DEFAULT_MODEL Actions variable", () => {
    expect(agentVarsMainContent).toContain('"DESIGN_DEFAULT_MODEL"');
    expect(agentVarsMainContent).toContain(
      'resource "github_actions_variable" "design_default_model"',
    );
  });
});
