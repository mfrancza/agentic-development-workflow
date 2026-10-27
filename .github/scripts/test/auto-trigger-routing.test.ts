import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = new URL("../../../.github/workflows/", import.meta.url);
const caller = readFileSync(new URL("agent-auto-trigger.yml", workflows), "utf8");
const reusable = readFileSync(
  new URL("agent-auto-trigger-reusable.yml", workflows),
  "utf8",
);

describe("agent-auto-trigger routing contract", () => {
  it("has one caller job which forwards the original event to the reusable", () => {
    expect(caller.match(/uses: .*agent-auto-trigger-reusable\.yml/g)).toHaveLength(1);
    expect(caller).toContain("event-name: ${{ github.event_name }}");
    expect(caller).toContain("event-action: ${{ github.event.action }}");
    expect(caller).toContain("issue-labels: ${{ toJSON(github.event.issue.labels.*.name || fromJSON('[]')) }}");
    expect(caller).toContain("developer-bot-login: mfrancza-developer-agent[bot]");
    expect(caller).not.toContain("transition:");
  });

  it("keeps every transition predicate and flag inside the reusable route", () => {
    expect(reusable).toContain("route:");
    for (const transition of [
      "auto-groom",
      "auto-design",
      "auto-developer-do",
      "auto-developer-undraft",
      "auto-review",
      "auto-developer-unblock",
    ]) {
      expect(reusable).toContain(`'${transition}'`);
      expect(reusable).toContain(
        `needs.route.outputs.transition == '${transition}'`,
      );
    }

    expect(reusable).toContain("fromJSON(vars.AUTO_TRIGGER_AGENTS).groom == true");
    expect(reusable).toContain("fromJSON(vars.AUTO_TRIGGER_AGENTS).design == true");
    expect(reusable).toContain("fromJSON(vars.AUTO_TRIGGER_AGENTS).developer == true");
    expect(reusable).toContain("fromJSON(vars.AUTO_TRIGGER_AGENTS).review == true");
    expect(reusable).toContain("!contains(fromJSON(inputs.issue-labels), 'draft')");
    expect(reusable).toContain("inputs.pr-head-repository == github.repository");
    expect(reusable).toContain("inputs.pr-author-login == inputs.developer-bot-login");
  });

  it("preserves the auto-review allowlist exception and other transition authorization", () => {
    expect(reusable).toContain(
      "skip-gate: ${{ needs.route.outputs.transition == 'auto-review' }}",
    );
    expect(reusable).toContain("needs: [route, authorize]");
  });
});
