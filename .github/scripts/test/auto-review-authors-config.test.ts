import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../terraform/", import.meta.url);
const readTerraform = (path: string) =>
  readFileSync(new URL(path, root), "utf8");

describe("auto-review author configuration", () => {
  it("passes the root input to the agent-vars module", () => {
    const main = readTerraform("main.tf");
    const module = main.match(/module "agent_vars"\s*\{([^}]*)\}/s)?.[1];
    expect(module).toMatch(/\bauto_review_authors\s*=\s*var\.auto_review_authors\b/);
  });

  it("enrolls exactly the prescribed repository authors", () => {
    const values = readTerraform("terraform.tfvars");
    const list = values.match(/^\s*auto_review_authors\s*=\s*\[([\s\S]*?)^\s*\]/m)?.[1];
    expect(list).toBeDefined();
    expect(JSON.parse(`[${list!.replace(/,\s*$/, "")}]`)).toEqual([
      "mfrancza-developer-agent[bot]",
      "mfrancza-s-claude-code[bot]",
    ]);
  });
});
