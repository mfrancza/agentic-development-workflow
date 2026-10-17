import { describe, it, expect } from "vitest";
import {
  selectReviewerModel,
  type PairingConfig,
} from "../src/lib/model-pair.js";
import { type ClassTable } from "../src/lib/model-classes.js";

// ---------------------------------------------------------------------------
// Minimal class table used throughout the tests (no filesystem access needed)
// ---------------------------------------------------------------------------

const TEST_CLASS_TABLE: ClassTable = {
  haiku: {
    anthropic: ["haiku", "claude-haiku-4-5"],
    openai: ["gpt-5.6-luna"],
    xai: ["grok-build-0.1"],
  },
  sonnet: {
    anthropic: ["sonnet", "claude-sonnet-4-5"],
    openai: ["gpt-5.6-terra"],
    xai: ["grok-4.3", "grok-4.5"],
  },
  opus: {
    anthropic: ["opus"],
    openai: ["gpt-5.6-sol", "gpt-6-astra"],
    xai: ["grok-4.20-0309-reasoning", "grok-4.6"],
  },
};

const ALL_PROVIDERS = ["anthropic", "openai", "xai"] as const;
const DEFAULT = "sonnet";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(overrides: Partial<PairingConfig> = {}): PairingConfig {
  return {
    enabled: true,
    policy: "different-vendor-same-class",
    preferred_vendors: ["openai", "xai", "anthropic"],
    fallback_chain: ["default-model"],
    explicit_map: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// disabled / "off"
// ---------------------------------------------------------------------------

describe('selectReviewerModel — disabled / "off"', () => {
  it('returns { model: undefined, source: "off" } when enabled is false', () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({ enabled: false }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("off");
    expect(result.warnings).toHaveLength(0);
  });

  it('returns { model: undefined, source: "off" } when policy is "off"', () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({ enabled: true, policy: "off" }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBeUndefined();
    expect(result.source).toBe("off");
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// same-model policy
// ---------------------------------------------------------------------------

describe('selectReviewerModel — "same-model" policy', () => {
  it("returns the authoring model unchanged", () => {
    const result = selectReviewerModel(
      "opus",
      cfg({ policy: "same-model" }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("opus");
    expect(result.source).toBe("primary");
    expect(result.warnings).toHaveLength(0);
  });

  it("also works for an OpenAI authoring model", () => {
    const result = selectReviewerModel(
      "gpt-5.6-sol",
      cfg({ policy: "same-model" }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.source).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// different-vendor-same-class policy
// ---------------------------------------------------------------------------

describe('selectReviewerModel — "different-vendor-same-class" policy', () => {
  it("picks the canonical OpenAI model for an Anthropic-authored sonnet PR", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({ preferred_vendors: ["openai", "xai", "anthropic"] }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("gpt-5.6-terra");
    expect(result.source).toBe("primary");
    expect(result.warnings).toHaveLength(0);
  });

  it("honours preferred_vendors order: xAI before OpenAI", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({ preferred_vendors: ["xai", "openai", "anthropic"] }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("grok-4.3");
    expect(result.source).toBe("primary");
  });

  it("skips a vendor whose API key is unavailable", () => {
    // Only anthropic and xai keys available; policy prefers openai first.
    const result = selectReviewerModel(
      "sonnet",
      cfg({ preferred_vendors: ["openai", "xai", "anthropic"] }),
      ["anthropic", "xai"], // openai key absent
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    // Should fall to xai (next in preferred_vendors), different vendor to anthropic.
    expect(result.model).toBe("grok-4.3");
    expect(result.source).toBe("primary");
  });

  it("falls through fallback chain when no cross-vendor entry exists", () => {
    // Class table with only one vendor for sonnet
    const singleVendorTable: ClassTable = {
      haiku: {
        anthropic: ["haiku"],
        openai: ["gpt-5.6-luna"],
        xai: ["grok-build-0.1"],
      },
      sonnet: {
        anthropic: ["sonnet"],
        openai: [],
        xai: [],
      },
      opus: {
        anthropic: ["opus"],
        openai: ["gpt-5.6-sol"],
        xai: ["grok-4.6"],
      },
    };
    const result = selectReviewerModel(
      "sonnet",
      cfg({ fallback_chain: ["default-model"] }),
      ALL_PROVIDERS,
      singleVendorTable,
      "haiku",
    );
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
    expect(result.warnings.some((w) => w.includes("different-vendor-same-class"))).toBe(true);
  });

  it("picks an xAI model for an OpenAI-authored opus PR", () => {
    const result = selectReviewerModel(
      "gpt-5.6-sol",
      cfg({ preferred_vendors: ["xai", "anthropic", "openai"] }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("grok-4.20-0309-reasoning");
    expect(result.source).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// same-vendor-same-class policy
// ---------------------------------------------------------------------------

describe('selectReviewerModel — "same-vendor-same-class" policy', () => {
  it("returns the canonical same-vendor model", () => {
    const result = selectReviewerModel(
      "claude-sonnet-4-5",
      cfg({ policy: "same-vendor-same-class" }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    // Canonical anthropic sonnet is "sonnet"
    expect(result.model).toBe("sonnet");
    expect(result.source).toBe("primary");
    expect(result.warnings).toHaveLength(0);
  });

  it("falls through when the author vendor key is missing", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({ policy: "same-vendor-same-class", fallback_chain: ["default-model"] }),
      ["openai", "xai"], // anthropic key absent
      TEST_CLASS_TABLE,
      "haiku",
    );
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
    expect(result.warnings.some((w) => w.includes("API key is not available"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// explicit-map policy
// ---------------------------------------------------------------------------

describe('selectReviewerModel — "explicit-map" policy', () => {
  it("returns the mapped reviewer model on a hit", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        policy: "explicit-map",
        explicit_map: { sonnet: "gpt-5.6-sol", opus: "grok-4.6" },
      }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.source).toBe("primary");
    expect(result.warnings).toHaveLength(0);
  });

  it("falls through to fallback chain on a miss", () => {
    const result = selectReviewerModel(
      "unknown-model",
      cfg({
        policy: "explicit-map",
        explicit_map: { sonnet: "gpt-5.6-sol" },
        fallback_chain: ["default-model"],
      }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      "haiku",
    );
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
    expect(result.warnings.some((w) => w.includes("explicit-map"))).toBe(true);
  });

  it("explicit-map miss with known model uses full fallback chain", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        policy: "explicit-map",
        explicit_map: {}, // no entry for sonnet
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["different-vendor-same-class", "default-model"],
      }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    // Falls back to different-vendor-same-class → gpt-5.6-terra
    expect(result.model).toBe("gpt-5.6-terra");
    expect(result.source).toBe("fallback:different-vendor-same-class");
  });
});

// ---------------------------------------------------------------------------
// Fallback chain entries
// ---------------------------------------------------------------------------

describe("selectReviewerModel — fallback chain entries", () => {
  it('"different-vendor-same-class" fallback picks cross-vendor model', () => {
    // Primary policy (same-vendor-same-class) misses because anthropic key absent.
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        policy: "same-vendor-same-class",
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["different-vendor-same-class", "default-model"],
      }),
      ["openai", "xai"], // anthropic absent
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("gpt-5.6-terra");
    expect(result.source).toBe("fallback:different-vendor-same-class");
    expect(result.warnings.some((w) => w.includes("different-vendor-same-class"))).toBe(true);
  });

  it('"same-vendor-different-model" fallback picks a different same-vendor model', () => {
    // Authoring model is "haiku"; only anthropic key available; no cross-vendor.
    const singleVendorTable: ClassTable = {
      haiku: {
        anthropic: ["haiku", "claude-haiku-4-5"],
        openai: [],
        xai: [],
      },
      sonnet: { anthropic: ["sonnet"], openai: [], xai: [] },
      opus: { anthropic: ["opus"], openai: [], xai: [] },
    };
    const result = selectReviewerModel(
      "haiku",
      cfg({
        policy: "different-vendor-same-class",
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["same-vendor-different-model", "default-model"],
      }),
      ["anthropic"],
      singleVendorTable,
      DEFAULT,
    );
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.source).toBe("fallback:same-vendor-different-model");
    expect(result.warnings.some((w) => w.includes("same-vendor-different-model"))).toBe(true);
  });

  it('"same-vendor-different-model" is skipped when no alternative model exists', () => {
    // Only one anthropic opus model; same-vendor-different-model must skip.
    const singleOpusTable: ClassTable = {
      haiku: { anthropic: ["haiku"], openai: ["gpt-5.6-luna"], xai: ["grok-build-0.1"] },
      sonnet: { anthropic: ["sonnet"], openai: ["gpt-5.6-terra"], xai: ["grok-4.3"] },
      opus: {
        anthropic: ["opus"], // only one entry
        openai: [],
        xai: [],
      },
    };
    const result = selectReviewerModel(
      "opus",
      cfg({
        policy: "different-vendor-same-class",
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["same-vendor-different-model", "default-model"],
      }),
      ["anthropic"],
      singleOpusTable,
      "haiku",
    );
    // same-vendor-different-model skipped; lands on default-model
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
  });

  it('"default-model" fallback is used as terminal', () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        policy: "different-vendor-same-class",
        fallback_chain: ["default-model"],
      }),
      ["anthropic"], // only anthropic; no cross-vendor pick
      // Table with only anthropic sonnet
      {
        haiku: { anthropic: ["haiku"], openai: [], xai: [] },
        sonnet: { anthropic: ["sonnet"], openai: [], xai: [] },
        opus: { anthropic: ["opus"], openai: [], xai: [] },
      } as ClassTable,
      "haiku",
    );
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
  });
});

// ---------------------------------------------------------------------------
// Missing preferred vendor API key
// ---------------------------------------------------------------------------

describe("selectReviewerModel — missing preferred vendor API key", () => {
  it("skips vendors without an available key", () => {
    // Prefer openai first, but no openai key; falls to xai.
    const result = selectReviewerModel(
      "sonnet",
      cfg({ preferred_vendors: ["openai", "xai", "anthropic"] }),
      ["anthropic", "xai"],
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.model).toBe("grok-4.3");
    expect(result.source).toBe("primary");
  });

  it("falls through to default when no cross-vendor key is available at all", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["default-model"],
      }),
      ["anthropic"], // only author vendor
      {
        haiku: { anthropic: ["haiku"], openai: ["gpt-5.6-luna"], xai: ["grok-build-0.1"] },
        sonnet: { anthropic: ["sonnet"], openai: ["gpt-5.6-terra"], xai: ["grok-4.3"] },
        opus: { anthropic: ["opus"], openai: ["gpt-5.6-sol"], xai: ["grok-4.6"] },
      } as ClassTable,
      "haiku",
    );
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Class with only one vendor entry
// ---------------------------------------------------------------------------

describe("selectReviewerModel — class with only one vendor entry", () => {
  it("falls back when the class has entries only for the author vendor", () => {
    const tableOnlyAnthropicSonnet: ClassTable = {
      haiku: { anthropic: ["haiku"], openai: ["gpt-5.6-luna"], xai: ["grok-build-0.1"] },
      sonnet: {
        anthropic: ["sonnet"],
        openai: [],
        xai: [],
      },
      opus: { anthropic: ["opus"], openai: ["gpt-5.6-sol"], xai: ["grok-4.6"] },
    };
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["same-vendor-different-model", "default-model"],
      }),
      ALL_PROVIDERS,
      tableOnlyAnthropicSonnet,
      "haiku",
    );
    // No cross-vendor → tries same-vendor-different-model (none) → default
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
  });
});

// ---------------------------------------------------------------------------
// Warnings surface as expected
// ---------------------------------------------------------------------------

describe("selectReviewerModel — warnings", () => {
  it("emits a warning when the primary pick fails", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["default-model"],
      }),
      ["anthropic"],
      {
        haiku: { anthropic: ["haiku"], openai: [], xai: [] },
        sonnet: { anthropic: ["sonnet"], openai: [], xai: [] },
        opus: { anthropic: ["opus"], openai: [], xai: [] },
      } as ClassTable,
      "haiku",
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    // Should mention the failed policy
    expect(result.warnings.some((w) => w.includes("different-vendor-same-class"))).toBe(true);
  });

  it('emits no warnings for a clean "same-model" pick', () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({ policy: "same-model" }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("emits no warnings for a clean primary pick", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg(),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      DEFAULT,
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("emits an ERROR-level warning when DEFAULT_MODEL equals authoring model", () => {
    const result = selectReviewerModel(
      "sonnet",
      cfg({
        preferred_vendors: ["openai", "xai", "anthropic"],
        fallback_chain: ["default-model"],
      }),
      ["anthropic"],
      {
        haiku: { anthropic: ["haiku"], openai: [], xai: [] },
        sonnet: { anthropic: ["sonnet"], openai: [], xai: [] },
        opus: { anthropic: ["opus"], openai: [], xai: [] },
      } as ClassTable,
      "sonnet", // DEFAULT_MODEL == authoringModel
    );
    // Result still has a model (soft failure).
    expect(result.model).toBe("sonnet");
    const errorWarning = result.warnings.find((w) => w.startsWith("ERROR:"));
    expect(errorWarning).toBeDefined();
    expect(errorWarning).toContain("DEFAULT_MODEL equals authoring model");
    expect(errorWarning).toContain("blind spots");
  });
});

// ---------------------------------------------------------------------------
// Unknown authoring model
// ---------------------------------------------------------------------------

describe("selectReviewerModel — unknown authoring model", () => {
  it("falls through to default when the authoring model vendor cannot be inferred", () => {
    const result = selectReviewerModel(
      "some-unknown-model-xyz",
      cfg({ fallback_chain: ["default-model"] }),
      ALL_PROVIDERS,
      TEST_CLASS_TABLE,
      "haiku",
    );
    expect(result.model).toBe("haiku");
    expect(result.source).toBe("fallback:default-model");
    expect(result.warnings.some((w) => w.includes("cannot infer vendor"))).toBe(true);
  });
});
