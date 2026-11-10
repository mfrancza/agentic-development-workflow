import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function prompt(name: string): string {
  return readFileSync(
    new URL(`../../../docker/scripts/prompts/${name}.md`, import.meta.url),
    "utf8",
  );
}

describe("action-specific model publication prompts", () => {
  it.each(["respond-to-checks", "respond-to-review"])(
    "%s requires local commits and entrypoint publication",
    (name) => {
      const text = prompt(name);
      expect(text).toMatch(/(?:commit\w*[^.\n]*locally|local commits)/i);
      expect(text).toMatch(/(?:test|checks|linters)/i);
      expect(text).toMatch(/entrypoint\s+publish\w*[^.\n]*(?:after|exit)/i);
      expect(text).toMatch(/do not push\s+or\s+force-push/i);
      expect(text).toMatch(/publish[^.\n]*(?:another tool|API)/i);
      expect(text).toMatch(/(?:disable|bypass)[^.\n]*guard/i);
      expect(text).not.toMatch(/(?:verify|test)[^.\n]*before pushing/i);
    },
  );

  it("requires truthful review replies and preserves authentication", () => {
    const text = prompt("respond-to-review");
    expect(text).toMatch(/(?:real SHA|commit[^.\n]*SHA)/i);
    expect(text).toMatch(/without claiming[^.\n]*(?:pushed|remotely)/i);
    expect(text).toMatch(/post a reply on every comment thread/i);
    expect(text).toMatch(/authenticate maintainer decisions/i);
    expect(text).toMatch(/gh api --paginate --slurp/g);
  });

  it("retains implement's model-owned push and draft PR", () => {
    const text = prompt("implement");
    expect(text).toMatch(/implement[^.\n]*you own publication/i);
    expect(text).toMatch(/push the branch[^.\n]*draft/i);
    expect(text).toMatch(/gh pr create --draft/);
    expect(text).toMatch(/entrypoint[^.\n]*marker[^.\n]*ready-for-review/i);
    expect(text).not.toMatch(/do not push/i);
  });
});
