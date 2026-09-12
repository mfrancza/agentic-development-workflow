import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guidance = readFileSync(
  new URL("../../../docs/model-guidance.md", import.meta.url),
  "utf8",
);
const terraform = readFileSync(
  new URL("../../../terraform/modules/labels/main.tf", import.meta.url),
  "utf8",
);
const criteria = JSON.parse(
  readFileSync(
    new URL("../../../agents/grooming/label-criteria.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const provisionedLabels = new Set(
  Array.from(terraform.matchAll(/"(model:[^"]+)"\s*=\s*\{/g), (match) => match[1]),
);
const pricingSection = guidance
  .split("### Pricing reference and normalized task benchmark\n")[1]
  .split("### Billing mechanisms")[0];
const pricingRows = pricingSection
  .split("\n")
  .filter((line) => line.startsWith("| `model:"))
  .map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return {
      label: cells[0].replaceAll("`", ""),
      cells,
      rates: cells.slice(1).map((cell) => Number(cell.replace("$", ""))),
    };
  });
const matrixRows = guidance
  .split("## Task-Class Matrix\n")[1]
  .split("## Evidence\n")[0]
  .split("\n")
  .filter((line) => line.startsWith("| ") && line.includes("`model:"));

describe("model guidance consistency", () => {
  it("prices the grooming tiers and provisioned OpenAI/xAI models without duplicates", () => {
    const expectedLabels = [...provisionedLabels].filter(
      (label) => label.startsWith("model:gpt-") || label.startsWith("model:grok-"),
    );
    expectedLabels.push(...Object.keys(criteria).filter((label) => label.startsWith("model:")));

    expect(pricingRows.map((row) => row.label).sort()).toEqual(expectedLabels.sort());
  });

  it.each(pricingRows)("recomputes the uncached token budget for $label", ({ cells, rates }) => {
    expect(cells).toHaveLength(5);
    expect(rates.every(Number.isFinite)).toBe(true);
    const [input, cachedInput, output, total] = rates;
    expect(cachedInput).toBeGreaterThanOrEqual(0);
    expect(cachedInput).toBeLessThanOrEqual(input);
    expect(total).toBeCloseTo((20_000 * input + 5_000 * output) / 1_000_000, 4);
  });

  it("uses only provisioned labels and grooming tiers in the task matrix", () => {
    expect(matrixRows.length).toBeGreaterThan(0);
    for (const row of matrixRows) {
      const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
      const tier = cells[1].replaceAll("`", "");
      expect(criteria).toHaveProperty(tier);
      for (const match of row.matchAll(/`(model:[^`]+)`/g)) {
        expect(provisionedLabels.has(match[1]), match[1]).toBe(true);
      }
    }
  });
});
