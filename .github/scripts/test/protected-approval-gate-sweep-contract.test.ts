import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../workflows/protected-approval-gate-sweep-reusable.yml", import.meta.url),
  "utf8",
);

function job(name: string): string {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`Missing job ${name}`);
  return match[1];
}

function condition(block: string): string {
  const match = block.match(/^    if: >\n((?:      .*\n)+)/m);
  if (!match) throw new Error("Missing folded job condition");
  return match[1].trim().replace(/\s+/g, " ");
}

const discovery = job("find-open-prs");
const rerun = job("rerun");
const discoveryCondition = condition(discovery);
const rerunCondition = condition(rerun);
const mappingMatch = discoveryCondition.match(/fromJSON\('([^']+)'\)/);
if (!mappingMatch) throw new Error("Missing literal cron mapping");
const mapping = JSON.parse(mappingMatch[1]) as Record<string, string>;

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function documentedCaller(name: string): string {
  const docs = readRepoFile("docs/adopting.md");
  const marker = `name: protected-approval-gate-${name}\n`;
  const start = docs.indexOf(marker);
  if (start < 0) throw new Error(`Missing documented ${name} caller`);
  const end = docs.indexOf("\n```", start);
  if (end < 0) throw new Error(`Missing end of ${name} caller`);
  return docs.slice(start, end);
}

function terraformCadences(path: string): number[] {
  const file = readRepoFile(path);
  const variable = file.match(/variable "enable_protected_approval_gate_reconcile_minutes" \{([\s\S]*?)\n\}/);
  const values = variable?.[1].match(/contains\(\[([^\]]+)\],\s*var\.enable_protected_approval_gate_reconcile_minutes\)/);
  if (!values) throw new Error(`Missing cadence validation in ${path}`);
  return values[1].split(",").map((value) => Number(value.trim()));
}

function admitted(eventName: string, gate: string, schedule: string, interval: string): boolean {
  const expression = discoveryCondition.replaceAll("inputs.interval-minutes", "inputs.intervalMinutes");
  const evaluate = new Function("github", "vars", "inputs", "fromJSON", `return (${expression});`);
  return evaluate(
    { event_name: eventName, event: { schedule } },
    { ENABLE_PROTECTED_APPROVAL_GATE: gate },
    { intervalMinutes: interval },
    JSON.parse,
  ) as boolean;
}

function reruns(result: string, prs: string): boolean {
  const expression = rerunCondition.replaceAll("needs.find-open-prs", "needs.discovery");
  const evaluate = new Function("needs", `return (${expression});`);
  return evaluate({ discovery: { result, outputs: { prs } } }) as boolean;
}

describe("protected approval gate sweep contract", () => {
  it("places the complete selection predicate on the discovery job", () => {
    expect(discoveryCondition.replace(mappingMatch[1], "MAPPING")).toBe(
      "github.event_name != 'schedule' || " +
      "(vars.ENABLE_PROTECTED_APPROVAL_GATE == 'true' && " +
      "github.event.schedule != '' && " +
      "github.event.schedule == fromJSON('MAPPING')[inputs.interval-minutes || '10'])",
    );
    expect(discovery.indexOf("    if:")).toBeLessThan(discovery.indexOf("    runs-on:"));
    expect(mapping).toEqual({
      "5": "*/5 * * * *",
      "10": "*/10 * * * *",
      "15": "*/15 * * * *",
      "20": "*/20 * * * *",
      "30": "*/30 * * * *",
      "60": "0 * * * *",
    });
  });

  it("keeps the documented caller and both Terraform cadence sets in sync", () => {
    const caller = documentedCaller("reconcile");
    const scheduleBlock = caller.match(/^  schedule:\n((?:    - cron: '[^']+'\n)+)/m);
    if (!scheduleBlock) throw new Error("Missing documented schedule block");
    const schedules = [...scheduleBlock[1].matchAll(/^    - cron: '([^']+)'$/gm)].map((match) => match[1]);
    expect(schedules).toEqual(Object.values(mapping));
    for (const path of ["terraform/variables.tf", "terraform/modules/agent-vars/variables.tf"]) {
      expect(terraformCadences(path)).toEqual(Object.keys(mapping).map(Number));
    }
    expect(caller).toMatch(/^  workflow_dispatch:$/m);
    expect(caller).toContain("interval-minutes: ${{ vars.ENABLE_PROTECTED_APPROVAL_GATE_RECONCILE_MINUTES }}");
    expect(caller).toContain("group: protected-approval-gate-reconcile-${{ github.event.schedule || 'manual' }}");
    expect(caller).toMatch(/^  cancel-in-progress: false$/m);
    expect(caller).not.toMatch(/^\s+if:/m);
    expect(new Set([...schedules, "manual"]).size).toBe(schedules.length + 1);
  });

  it("preserves manual backfill without an interval input", () => {
    for (const caller of [documentedCaller("backfill"), readRepoFile(".github/workflows/protected-approval-gate-backfill.yml")]) {
      expect(caller).toMatch(/^  workflow_dispatch:$/m);
      expect(caller).not.toMatch(/^  schedule:|interval-minutes:/m);
      expect(caller).toContain("protected-approval-gate-sweep-reusable.yml");
      expect(caller).toContain("repo: ${{ github.repository }}");
    }
  });

  it("admits only the selected cron when the gate is enabled", () => {
    for (const [interval, selected] of Object.entries(mapping)) {
      for (const schedule of Object.values(mapping)) {
        expect(admitted("schedule", "true", schedule, interval)).toBe(schedule === selected);
        expect(admitted("schedule", "false", schedule, interval)).toBe(false);
        expect(admitted("schedule", "", schedule, interval)).toBe(false);
      }
      expect(admitted("schedule", "true", "", interval)).toBe(false);
    }
    for (const schedule of Object.values(mapping)) {
      expect(admitted("schedule", "true", schedule, "")).toBe(schedule === mapping["10"]);
    }
  });

  it("fails closed for unsupported settings and missing or unexpected schedules", () => {
    for (const interval of ["0", "-5", "5.0", " 5", "5 ", "05", "7", "11", "61", "invalid", " "]) {
      for (const schedule of [...Object.values(mapping), "", "unexpected"]) {
        expect(admitted("schedule", "true", schedule, interval)).toBe(false);
      }
    }
    expect(admitted("schedule", "true", "unexpected", "10")).toBe(false);
    expect(admitted("schedule", "true", "", "")).toBe(false);
  });

  it("bypasses scheduling conditions for manual and other non-scheduled events", () => {
    for (const event of ["workflow_dispatch", "push"]) {
      for (const gate of ["", "false", "true"]) {
        for (const interval of ["", "10", "invalid"]) {
          expect(admitted(event, gate, "", interval)).toBe(true);
        }
      }
    }
  });

  it("removes the runner-backed interval guard without altering discovery", () => {
    expect(workflow.split("\njobs:\n")[1].match(/^  [\w-]+:$/gm)).toEqual([
      "  find-open-prs:",
      "  rerun:",
    ]);
    expect(discovery).not.toMatch(/id: interval|steps\.interval|^      run:/m);
    expect(workflow).not.toMatch(/status=success|GITHUB_WORKFLOW_REF|GITHUB_RUN_ID|outputs\.run/);
    expect(discovery).toContain("prs: ${{ steps.prs.outputs.value }}");
    expect(discovery).toContain('gh pr list --repo "$REPO" --state open --limit 1000 --json number');
    expect(discovery).not.toMatch(/^        if:/m);
  });

  it("gates matrix expansion on successful, nonempty discovery", () => {
    expect(rerun).toMatch(/^    needs: find-open-prs$/m);
    expect(rerunCondition).toBe(
      "needs.find-open-prs.result == 'success' && " +
      "needs.find-open-prs.outputs.prs != '' && " +
      "needs.find-open-prs.outputs.prs != '[]'",
    );
    expect(rerun).not.toContain("always()");
    expect(rerun).toContain("pr: ${{ fromJSON(needs.find-open-prs.outputs.prs) }}");
    expect(rerun).toContain("fail-fast: false");
    for (const result of ["skipped", "failure", "cancelled"]) {
      for (const prs of ["", "[]", '[{"number":1}]']) {
        expect(reruns(result, prs)).toBe(false);
      }
    }
    expect(reruns("success", "")).toBe(false);
    expect(reruns("success", "[]")).toBe(false);
    expect(reruns("success", '[{"number":1}]')).toBe(true);
  });
});
