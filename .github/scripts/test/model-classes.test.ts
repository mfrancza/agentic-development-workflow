import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  getClass,
  getCanonicalPick,
  listModels,
  validateModelClassData,
} from "../src/lib/model-classes.js";

// ---------------------------------------------------------------------------
// Load raw data files for structural assertions.
// ---------------------------------------------------------------------------

const rawJson = JSON.parse(
  readFileSync(
    new URL("../data/model-classes.json", import.meta.url),
    "utf8",
  ),
) as {
  classes: Record<string, Record<string, string[]>>;
  modelToClass: Record<string, string>;
};

const guidance = readFileSync(
  new URL("../../../docs/model-guidance.md", import.meta.url),
  "utf8",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All (class, vendor, model) triples from the classes forward table. */
function allClassEntries(): { className: string; vendor: string; model: string }[] {
  const entries: { className: string; vendor: string; model: string }[] = [];
  for (const [className, vendors] of Object.entries(rawJson.classes)) {
    for (const [vendor, models] of Object.entries(vendors)) {
      for (const model of models) {
        entries.push({ className, vendor, model });
      }
    }
  }
  return entries;
}

/** Finds models that appear under more than one class in the forward table. */
function dualClassModels(): Map<string, string[]> {
  const modelClasses = new Map<string, Set<string>>();
  for (const { className, model } of allClassEntries()) {
    if (!modelClasses.has(model)) modelClasses.set(model, new Set());
    modelClasses.get(model)!.add(className);
  }
  const dual = new Map<string, string[]>();
  for (const [model, classes] of modelClasses) {
    if (classes.size > 1) dual.set(model, [...classes]);
  }
  return dual;
}

/**
 * Parses the "Cross-Vendor Class Table" section from model-guidance.md and
 * returns a map of className → { vendor → cell text }.
 *
 * Expected table format (header row: Class | Anthropic | OpenAI | xAI):
 *   | `haiku`  | ... | ... | ... |
 *   | `sonnet` | ... | ... | ... |
 *   | `opus`   | ... | ... | ... |
 */
function parseCrossVendorTable(): Map<string, Record<string, string>> {
  const sectionMarker = "## Cross-Vendor Class Table";
  const sectionStart = guidance.indexOf(sectionMarker);
  if (sectionStart === -1) {
    throw new Error(
      `docs/model-guidance.md is missing the "${sectionMarker}" section`,
    );
  }

  // Extract section up to the next ## heading.
  const afterSection = guidance.slice(sectionStart + sectionMarker.length);
  const nextSectionMatch = afterSection.match(/\n## /);
  const sectionText = nextSectionMatch
    ? afterSection.slice(0, nextSectionMatch.index)
    : afterSection;

  const tableRows = sectionText
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| Class"));

  const result = new Map<string, Record<string, string>>();
  for (const row of tableRows) {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    // Class name is in backticks, e.g. `haiku`
    const className = cells[0].replace(/`/g, "").trim();
    if (!className) continue;
    result.set(className, {
      anthropic: cells[1],
      openai: cells[2],
      xai: cells[3],
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Check 1: Every canonical pick (classes[class][vendor][0]) is in modelToClass
// and maps to the matching class.
// ---------------------------------------------------------------------------

describe("model-classes: canonical picks are mapped consistently (check 1)", () => {
  for (const [className, vendors] of Object.entries(rawJson.classes)) {
    for (const [vendor, models] of Object.entries(vendors)) {
      if (models.length === 0) continue;
      const canonical = models[0];
      it(`classes.${className}.${vendor}[0] "${canonical}" is in modelToClass as "${className}"`, () => {
        expect(
          Object.hasOwn(rawJson.modelToClass, canonical),
          `modelToClass is missing key "${canonical}"`,
        ).toBe(true);
        expect(rawJson.modelToClass[canonical]).toBe(className);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Check 2: modelToClass is a superset of every entry in classes.
// ---------------------------------------------------------------------------

describe("model-classes: modelToClass covers every model in classes (check 2)", () => {
  for (const { className, vendor, model } of allClassEntries()) {
    it(`classes.${className}.${vendor} entry "${model}" has a modelToClass key`, () => {
      expect(
        Object.hasOwn(rawJson.modelToClass, model),
        `modelToClass is missing key "${model}" (appears in classes.${className}.${vendor})`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Check 3: Dual-class entries are intentional — modelToClass maps them to one
// of the classes they appear under, not a third unrelated class.
// ---------------------------------------------------------------------------

describe("model-classes: dual-class entries are intentional (check 3)", () => {
  const dual = dualClassModels();

  if (dual.size === 0) {
    it("no dual-class models exist (check is a no-op against the current JSON)", () => {
      expect(dual.size).toBe(0);
    });
  }

  for (const [model, classes] of dual) {
    it(`dual-class model "${model}" is resolved to one of its listed classes in modelToClass`, () => {
      const resolvedClass = rawJson.modelToClass[model];
      expect(
        classes.includes(resolvedClass),
        `modelToClass["${model}"] = "${resolvedClass}" is not among its classes: ${classes.join(", ")}`,
      ).toBe(true);
    });

    it(`dual-class model "${model}" is named in the Cross-Vendor Class Table section of docs/model-guidance.md`, () => {
      const sectionMarker = "## Cross-Vendor Class Table";
      const sectionStart = guidance.indexOf(sectionMarker);
      expect(
        sectionStart,
        `docs/model-guidance.md is missing the "${sectionMarker}" section`,
      ).toBeGreaterThan(-1);
      const section = guidance.slice(sectionStart);
      expect(
        section,
        `docs/model-guidance.md Cross-Vendor Class Table section does not mention dual-class model "${model}"`,
      ).toContain(model);
    });
  }
});

// ---------------------------------------------------------------------------
// Check 4: Canonical picks in the JSON agree with the class table in the doc.
// ---------------------------------------------------------------------------

describe("model-classes: canonical picks appear in the Cross-Vendor Class Table doc section (check 4)", () => {
  const vendorOrder: string[] = ["anthropic", "openai", "xai"];
  let docTable: Map<string, Record<string, string>>;

  try {
    docTable = parseCrossVendorTable();
  } catch (err) {
    it("Cross-Vendor Class Table section is present and parseable", () => {
      throw err;
    });
    // Return early so subsequent tests in this block are not registered.
    // (Vitest executes the describe body synchronously at collection time, so
    // we cannot truly early-return here — the loop below is empty if the table
    // parse threw, keeping test collection safe.)
    docTable = new Map();
  }

  for (const [className, vendors] of Object.entries(rawJson.classes)) {
    for (const vendor of vendorOrder) {
      const models = vendors[vendor];
      if (!models || models.length === 0) continue;
      const canonical = models[0];

      it(`doc table row "${className}" / "${vendor}" cell contains canonical pick "${canonical}"`, () => {
        const rowCells = docTable.get(className);
        expect(
          rowCells,
          `docs/model-guidance.md Cross-Vendor Class Table is missing a row for class "${className}"`,
        ).toBeDefined();

        const cellText = rowCells![vendor];
        expect(
          cellText,
          `docs/model-guidance.md Cross-Vendor Class Table row "${className}" is missing the "${vendor}" cell`,
        ).toBeDefined();

        expect(
          cellText,
          `docs/model-guidance.md Cross-Vendor Class Table row "${className}" / "${vendor}" cell ` +
            `does not contain canonical pick "${canonical}"`,
        ).toContain(canonical);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Accessor round-trip tests.
// ---------------------------------------------------------------------------

describe("model-classes: getClass accessor", () => {
  it("returns the class for a known model", () => {
    expect(getClass("sonnet")).toBe("sonnet");
    expect(getClass("gpt-5.6-sol")).toBe("opus");
    expect(getClass("grok-build-0.1")).toBe("haiku");
  });

  it("returns undefined for an unknown model", () => {
    expect(getClass("unknown-model-xyz")).toBeUndefined();
  });
});

describe("model-classes: getCanonicalPick accessor", () => {
  it("returns the first model for a known (class, vendor) pair", () => {
    expect(getCanonicalPick("haiku", "anthropic")).toBe("haiku");
    expect(getCanonicalPick("sonnet", "openai")).toBe("gpt-5.6-terra");
    expect(getCanonicalPick("opus", "xai")).toBe("grok-4.20-0309-reasoning");
  });

  it("returns undefined for an unknown class", () => {
    expect(getCanonicalPick("mega", "anthropic")).toBeUndefined();
  });

  it("returns undefined for an unknown vendor", () => {
    expect(getCanonicalPick("sonnet", "google")).toBeUndefined();
  });
});

describe("model-classes: listModels accessor", () => {
  it("returns all models for a known (class, vendor) pair, canonical first", () => {
    const haikiAnthropicModels = listModels("haiku", "anthropic");
    expect(haikiAnthropicModels[0]).toBe("haiku");
    expect(haikiAnthropicModels).toContain("claude-haiku-4-5");
  });

  it("returns an empty array for an unknown class", () => {
    expect(listModels("mega", "anthropic")).toEqual([]);
  });

  it("returns an empty array for an unknown vendor", () => {
    expect(listModels("sonnet", "google")).toEqual([]);
  });

  it("canonical pick from getCanonicalPick matches listModels[0]", () => {
    for (const [className, vendors] of Object.entries(rawJson.classes)) {
      for (const vendor of Object.keys(vendors)) {
        const canonical = getCanonicalPick(className, vendor);
        const list = listModels(className, vendor);
        expect(canonical).toBe(list[0]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Import-time validation: malformed data must be rejected with a useful error.
// These tests exercise validateModelClassData() directly so that malformed
// fixtures never need to touch the filesystem.
// ---------------------------------------------------------------------------

describe("model-classes: import-time validation rejects malformed data", () => {
  it("rejects a non-object root (null)", () => {
    expect(() => validateModelClassData(null)).toThrow(
      "root must be an object",
    );
  });

  it("rejects a non-object root (string)", () => {
    expect(() => validateModelClassData("not an object")).toThrow(
      "root must be an object",
    );
  });

  it("rejects a missing 'classes' property", () => {
    expect(() => validateModelClassData({ modelToClass: {} })).toThrow(
      "'classes' must be an object",
    );
  });

  it("rejects a null 'classes' property", () => {
    expect(() =>
      validateModelClassData({ classes: null, modelToClass: {} }),
    ).toThrow("'classes' must be an object");
  });

  it("rejects a missing 'modelToClass' property", () => {
    expect(() => validateModelClassData({ classes: {} })).toThrow(
      "'modelToClass' must be an object",
    );
  });

  it("rejects a null 'modelToClass' property", () => {
    expect(() =>
      validateModelClassData({ classes: {}, modelToClass: null }),
    ).toThrow("'modelToClass' must be an object");
  });

  it("rejects an unrecognized class key (e.g. 'mega')", () => {
    expect(() =>
      validateModelClassData({
        classes: { mega: { anthropic: [] } },
        modelToClass: {},
      }),
    ).toThrow('classes key "mega" is not a valid ClassName');
  });

  // Regression for: classes.sonnet = null imports successfully but later
  // throws inside the accessor instead of at import time.
  it("rejects a null vendor map (classes.sonnet = null)", () => {
    expect(() =>
      validateModelClassData({
        classes: { sonnet: null },
        modelToClass: {},
      }),
    ).toThrow("classes.sonnet must be a non-null object");
  });

  it("rejects an unrecognized vendor key (e.g. 'google')", () => {
    expect(() =>
      validateModelClassData({
        classes: { sonnet: { google: ["gemini-pro"] } },
        modelToClass: {},
      }),
    ).toThrow('classes.sonnet key "google" is not a valid VendorName');
  });

  // Regression for: classes.sonnet.openai = "gpt-5.6-terra" (string instead
  // of array) imports successfully and getCanonicalPick returns "g" (first
  // char of the string) instead of a real model ID.
  it("rejects a vendor entry that is a string instead of an array", () => {
    expect(() =>
      validateModelClassData({
        classes: { sonnet: { openai: "gpt-5.6-terra" } },
        modelToClass: { "gpt-5.6-terra": "sonnet" },
      }),
    ).toThrow("classes.sonnet.openai must be an array");
  });

  it("rejects a vendor array containing a non-string element", () => {
    expect(() =>
      validateModelClassData({
        classes: { haiku: { anthropic: [42] } },
        modelToClass: {},
      }),
    ).toThrow("classes.haiku.anthropic[0] must be a string");
  });

  // Regression for: modelToClass["gpt-6-astra"] = "opuz" escapes validation
  // and is treated as a valid ClassName by typed accessors.
  it("rejects a modelToClass value that is not a valid ClassName", () => {
    expect(() =>
      validateModelClassData({
        classes: {},
        modelToClass: { "gpt-6-astra": "opuz" },
      }),
    ).toThrow('modelToClass["gpt-6-astra"] = "opuz" is not a valid ClassName');
  });

  it("accepts a well-formed minimal document", () => {
    expect(() =>
      validateModelClassData({
        classes: {
          sonnet: { anthropic: ["sonnet"] },
        },
        modelToClass: { sonnet: "sonnet" },
      }),
    ).not.toThrow();
  });
});
