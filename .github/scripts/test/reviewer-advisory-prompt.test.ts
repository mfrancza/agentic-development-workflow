import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const prompt = readFileSync(new URL("../../../docker/reviewer/prompts/review.md", import.meta.url), "utf8");
const section = (start: string, end: string) => prompt.split(start)[1].split(end)[0];

describe("reviewer advisory lifecycle contract", () => {
  it("posts anchored advisories atomically with the header and COMMENT verdict", () => {
    expect(prompt).toMatch(/single `POST \/repos\/\{repo\}\/pulls\/\{n\}\/reviews`/);
    expect(prompt).toMatch(/same atomic review `comments` array[^\n]*literal `Advisory:`/);
    expect(prompt).toMatch(/"event": "COMMENT"[\s\S]*?"commit_id": "\$\{REVIEW_HEAD_SHA\}"[\s\S]*?reviewer-model:[\s\S]*?"comments": \[\{"path"[^\n]*"body": "Advisory:/);
    expect(prompt).toMatch(/general or unanchorable advice may remain/i);
    expect(prompt).toMatch(/advisories alone never justify `REQUEST_CHANGES`/);
  });

  it("accepts only authenticated reasoned declines and suppresses repeats", () => {
    const resolution = section("**Reasoned advisory declines.**", "For each open review thread");
    expect(resolution).toMatch(/complete authenticated REST comment history/);
    expect(resolution).toMatch(/PR author from GitHub metadata as a bot[^\n]*reply's own author/);
    expect(resolution).toMatch(/reason for declining[^\n]*record the original thread ID[^\n]*diff is unchanged/);
    expect(resolution).toMatch(/bare refusal, unrelated reply, or agreement without implementation is not/);
    expect(resolution).toMatch(/Do not re-raise the same declined suggestion[^\n]*resolved history/);
    expect(resolution).toMatch(/Historical unprefixed threads retain the semantic fix rule/);
    expect(resolution).toMatch(/decline cannot waive effective requirements or security rules/);
  });

  it("replaces a newly demonstrated blocker and keeps blocking resolution semantic", () => {
    const resolution = section("**Reasoned advisory declines.**", "For each open review thread");
    expect(resolution).toMatch(/new blocking defect[^\n]*record the old advisory thread[^\n]*new blocking finding/);
    expect(resolution).toMatch(/Link the old thread and explain the new evidence/);
    expect(resolution).toMatch(/exception to the no-duplicate-open-thread rule/);
    expect(resolution).toMatch(/decline alone does not resolve a blocking thread[^\n]*semantic fix/);
    expect(prompt).toMatch(/\*\*`APPROVE` is mandatory on a clean pass/);
  });

  it("retains complete authenticated history and avoids repository-specific identities", () => {
    expect(prompt.match(/gh api --paginate --slurp/g)).toHaveLength(3);
    expect(prompt).toContain('gh api "repos/${GITHUB_REPO}/pulls/${GITHUB_PR_NUMBER}"');
    expect(prompt).toMatch(/failed or incomplete request/);
    expect(prompt).toMatch(/author_association[^\n]*user\.login[^\n]*user\.type/);
    expect(prompt).not.toMatch(/mfrancza/i);
  });
});
