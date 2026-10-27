import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowsDir = new URL("../../../.github/workflows/", import.meta.url);

function workflow(name: string): string {
  return readFileSync(new URL(name, workflowsDir), "utf8");
}

function workflowCallContract(content: string): string {
  const start = content.indexOf("on:\n  workflow_call:");
  const end = content.indexOf("\npermissions:", start);
  return content.slice(start, end < 0 ? undefined : end);
}

const contracts = [
  "agent-groom-reusable.yml",
  "agent-implement-reusable.yml",
  "agent-design-reusable.yml",
  "agent-review-reusable.yml",
  "agent-review-worker-reusable.yml",
];

describe("agent reusable workflow-call contracts", () => {
  it("derives repository and default-model context internally", () => {
    for (const name of contracts) {
      const content = workflow(name);
      const contract = workflowCallContract(content);
      expect(contract, `${name} must not accept a repository input`).not.toMatch(
        /^ {6}repo:/m,
      );
      expect(contract, `${name} must not accept a default-model input`).not.toMatch(
        /^ {6}default-model:/m,
      );
    }
  });

  it("keeps helpers-ref explicit and required", () => {
    for (const name of contracts) {
      expect(workflow(name), `${name} must require helpers-ref`).toMatch(
        /helpers-ref:\n(?:.*\n){0,8}\s+required:\s+true/,
      );
    }
  });

  it("keeps lifecycle gates inside reusable workflows", () => {
    for (const name of [
      "agent-groom-reusable.yml",
      "agent-implement-reusable.yml",
      "agent-design-reusable.yml",
      "agent-review-reusable.yml",
    ]) {
      const content = workflow(name);
      expect(content, `${name} must query current lifecycle state internally`).toMatch(
        /name: Check (issue|pull request) lifecycle state/,
      );
      expect(content, `${name} must publish a gate decision`).toContain(
        "proceed: ${{ steps.",
      );
      expect(content, `${name} must not accept a stale event lifecycle state`).not.toMatch(
        /^ {6}(issue-state|pr-state):/m,
      );
    }
  });

  it("acquires per-subject concurrency only after the reusable gate", () => {
    const expected = [
      ["agent-groom-reusable.yml", "groom"],
      ["agent-implement-reusable.yml", "implement"],
      ["agent-design-reusable.yml", "design"],
      ["agent-review-reusable.yml", "review"],
    ] as const;
    for (const [name, job] of expected) {
      const content = workflow(name);
      const jobStart = content.indexOf(`  ${job}:`);
      expect(jobStart, `${name} has ${job} job`).toBeGreaterThanOrEqual(0);
      const nextJob = content.slice(jobStart + 3).search(/\n  [A-Za-z0-9_-]+:/);
      const jobBlock = content.slice(
        jobStart,
        nextJob < 0 ? undefined : jobStart + 3 + nextJob,
      );
      expect(jobBlock, `${name} gates ${job} before concurrency`).toMatch(
        /if:.*needs\.(gate|design-gate)\.outputs\.proceed == 'true'[\s\S]*concurrency:/,
      );
    }
  });

  it("adapts the pinned review-worker contract internally", () => {
    const review = workflow("agent-review-reusable.yml");
    expect(review).toContain(
      "agent-review-worker-reusable.yml@v0.2.0",
    );
    expect(review).toMatch(
      /uses: mfrancza\/agentic-development-workflow\/\.github\/workflows\/agent-review-worker-reusable\.yml@v0\.2\.0[\s\S]*?repo: \$\{\{ github\.repository \}\}[\s\S]*?default-model: \$\{\{ vars\.DEFAULT_MODEL \}\}/,
    );
  });
});

describe("in-repository caller stubs", () => {
  it("keeps caller guards limited to event routing and caller-boundary trust", () => {
    const groom = workflow("agent-groom.yml");
    const implement = workflow("agent-implement.yml");
    const design = workflow("agent-design.yml");
    const review = workflow("agent-review.yml");

    expect(groom).toMatch(/if: >\n\s+github\.event\.label\.name == 'agent:groom'/);
    expect(implement).toMatch(/if: >\n\s+github\.event\.label\.name == 'agent:developer'/);
    expect(design).toMatch(/if: >\n\s+github\.event\.label\.name == 'agent:design'/);
    expect(review).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("forward only queue predicates and values the reusable cannot derive", () => {
    const callers = [
      "agent-groom.yml",
      "agent-implement.yml",
      "agent-design.yml",
      "agent-review.yml",
    ];
    for (const name of callers) {
      const content = workflow(name);
      expect(content, `${name} forwards no repository input`).not.toMatch(
        /^\s+repo: \$\{\{ github\.repository \}\}$/m,
      );
      expect(content, `${name} forwards no default model`).not.toMatch(
        /^\s+default-model:/m,
      );
      expect(content, `${name} forwards no lifecycle snapshot`).not.toMatch(
        /^\s+(issue-state|pr-state):/m,
      );
    }
  });
});
