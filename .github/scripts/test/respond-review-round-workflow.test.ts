import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = new URL("../../../.github/workflows/", import.meta.url);
const caller = readFileSync(new URL("agent-respond-review.yml", workflows), "utf8");
const reusable = readFileSync(new URL("agent-respond-review-reusable.yml", workflows), "utf8");
const work = reusable.slice(reusable.indexOf("\n  respond-review:"));

function step(name: string): string {
  const start = work.indexOf(`      - name: ${name}\n`);
  expect(start, `Missing step ${name}`).toBeGreaterThanOrEqual(0);
  const next = work.indexOf("\n      - name:", start + 1);
  return work.slice(start, next < 0 ? undefined : next);
}

describe("respond-review round-limit workflow contract", () => {
  it("keeps caller authorization and passes caller configuration", () => {
    expect(caller).toContain("github.event.pull_request.user.login == 'mfrancza-developer-agent[bot]'");
    expect(caller).toContain("github.event.review.user.login != github.event.pull_request.user.login");
    expect(caller).toContain("max-review-rounds: ${{ vars.MAX_REVIEW_ROUNDS }}");
    expect(caller).toContain("admin-assignees: ${{ vars.ADMIN_ASSIGNEES }}");
    expect(reusable).toContain("if: needs.feedback-gate.outputs.proceed == 'true'");
    expect(reusable).toContain("principal: ${{ inputs.review-author }}");
    expect(reusable).toContain("additional-trusted-logins: '[\"mfrancza-reviewer-agent[bot]\",\"Copilot\",\"copilot-pull-request-reviewer[bot]\",\"github-copilot[bot]\"]'");
    expect(reusable).not.toMatch(/(?:allowlist|principal|additional-trusted-logins):.*inputs\.reviewer-logins/);
  });

  it("provides optional string inputs without overriding adopter defaults", () => {
    const inputs = reusable.slice(reusable.indexOf("    inputs:"), reusable.indexOf("    secrets:"));
    for (const name of ["max-review-rounds", "reviewer-logins", "escalation-assignee", "admin-assignees"]) {
      expect(inputs).toMatch(new RegExp(`      ${name}:\\n(?:.*\\n)*?        type: string\\n        required: false\\n        default: ''`));
      expect(step("Check review-round limit")).toContain(`${name}: \${{ inputs.${name} }}`);
    }
    expect(step("Check review-round limit")).not.toContain("vars.MAX_REVIEW_ROUNDS");
  });

  it("enforces the gate under the existing lock after trusted checkout and token minting", () => {
    expect(work).toContain("needs: [feedback-gate, authorize]");
    expect(work).toContain("group: agent-branch-pr-${{ inputs.pr-number }}\n      cancel-in-progress: false");
    const ordered = ["Resolve helpers-ref to commit SHA", "Check out upstream helper actions", "Verify helper checkout HEAD matches resolved SHA", "Check review freshness", "Mint installation token for developer-agent", "Detect team references for escalation assignees", "Mint installation token for escalation assignee resolver", "Check review-round limit", "Resolve linked issue from PR body", "Resolve Claude model from issue labels", "Prepare agent log directory", "Run agent", "Upload agent logs"];
    const positions = ordered.map((name) => work.indexOf(step(name)));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(step("Check out upstream helper actions")).toContain("ref: ${{ steps.resolve-ref.outputs.sha }}");
    expect(step("Check out upstream helper actions")).toContain("persist-credentials: false");
    expect(step("Verify helper checkout HEAD matches resolved SHA")).toContain("git -C _agentic-workflow rev-parse HEAD");
    expect(step("Check review-round limit")).toContain("uses: ./_agentic-workflow/.github/actions/check-review-round-limit");
  });

  it("uses a fresh optional resolver and passes trusted identifiers and token", () => {
    expect(step("Detect team references for escalation assignees")).toContain("assignees: ${{ inputs.admin-assignees }}");
    const resolver = step("Mint installation token for escalation assignee resolver");
    expect(resolver).toContain("steps.detect-team-refs.outputs.assignees_has_team == 'true'");
    expect(resolver).toContain("continue-on-error: true");
    expect(resolver).toContain("secrets.ALLOWLIST_RESOLVER_APP_ID");
    expect(resolver).toContain("secrets.ALLOWLIST_RESOLVER_APP_PRIVATE_KEY");
    const gate = step("Check review-round limit");
    for (const binding of ["token: ${{ steps.setup.outputs.token }}", "resolver-token: ${{ steps.assignee-resolver.outputs.token }}", "repo-owner: ${{ github.repository_owner }}", "repo-name: ${{ inputs.repo-name }}", "pr-number: ${{ inputs.pr-number }}", "review-id: ${{ inputs.review-id }}"]) {
      expect(gate).toContain(binding);
    }
  });

  it("fails closed for all preparation while retaining artifacts", () => {
    for (const name of ["Resolve linked issue from PR body", "Resolve Claude model from issue labels", "Prepare agent log directory", "Run agent"]) {
      expect(step(name)).toContain("steps.review-round-limit.outputs.proceed == 'true'");
    }
    for (const name of ["Mint installation token for developer-agent", "Detect team references for escalation assignees", "Mint installation token for escalation assignee resolver", "Check review-round limit", "Resolve linked issue from PR body", "Resolve Claude model from issue labels", "Prepare agent log directory", "Run agent"]) {
      expect(step(name)).toContain("steps.review-freshness.outputs.proceed == 'true'");
    }
    const freshness = step("Check review freshness");
    for (const binding of ["token: ${{ github.token }}", "review-author: ${{ inputs.review-author }}", "review-commit-id: ${{ inputs.review-commit-id }}", "pr-number: ${{ inputs.pr-number }}", "review-id: ${{ inputs.review-id }}"]) expect(freshness).toContain(binding);
    expect(freshness).toContain("uses: ./_agentic-workflow/.github/actions/check-review-freshness");
    expect(freshness).toContain("repo-owner: ${{ github.repository_owner }}");
    expect(freshness).toContain("repo-name: ${{ inputs.repo-name }}");
    const feedback = reusable.slice(reusable.indexOf("      - name: Check for reviewer feedback"), reusable.indexOf("\n  authorize:"));
    expect(feedback).not.toContain("head-sha:");
    expect(feedback).not.toContain("review-commit-id:");
    expect(caller).not.toContain("head-sha:");
    expect(caller).toContain("review-commit-id: ${{ github.event.review.commit_id }}");
    expect(step("Upload agent logs")).toContain("if: always()");
    expect(step("Check review-round limit")).not.toContain("continue-on-error");
    expect(reusable).not.toMatch(/(?:contents|issues|pull-requests):\s*write/);
  });
});
