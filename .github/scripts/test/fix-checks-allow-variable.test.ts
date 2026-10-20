import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../", import.meta.url);
const terraformDir = new URL("terraform/", repoRoot);

const rootVariablesContent = readFileSync(
  new URL("variables.tf", terraformDir),
  "utf8",
);
const rootMainContent = readFileSync(new URL("main.tf", terraformDir), "utf8");
const agentVarsVariablesContent = readFileSync(
  new URL("modules/agent-vars/variables.tf", terraformDir),
  "utf8",
);
const agentVarsMainContent = readFileSync(
  new URL("modules/agent-vars/main.tf", terraformDir),
  "utf8",
);

describe("FIX_CHECKS_ALLOW Terraform wiring", () => {
  it("defaults the root and module inputs to an empty list", () => {
    for (const content of [rootVariablesContent, agentVarsVariablesContent]) {
      expect(content).toMatch(
        /variable "fix_checks_allow"[\s\S]*?type\s*=\s*list\(string\)[\s\S]*?default\s*=\s*\[\]/,
      );
    }
  });

  it("passes the root input through and publishes JSON as FIX_CHECKS_ALLOW", () => {
    expect(rootMainContent).toMatch(
      /fix_checks_allow\s+=\s+var\.fix_checks_allow/,
    );
    expect(agentVarsMainContent).toContain(
      'resource "github_actions_variable" "fix_checks_allow"',
    );
    expect(agentVarsMainContent).toContain('variable_name = "FIX_CHECKS_ALLOW"');
    expect(agentVarsMainContent).toContain("value         = jsonencode(var.fix_checks_allow)");
  });
});
