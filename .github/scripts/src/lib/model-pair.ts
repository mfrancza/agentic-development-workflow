import { type ClassTable } from "./model-classes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The supported pairing policy values.
 * - "different-vendor-same-class" — pick a same-class model from a different vendor.
 * - "same-vendor-same-class"      — pick the canonical same-vendor same-class model.
 * - "same-model"                  — return the authoring model itself (the only policy
 *                                   that may return the same model as the author).
 * - "explicit-map"                — look up the reviewer model in `explicitMap`.
 * - "off"                         — pairing is disabled; returns no pick.
 */
export type PairingPolicy =
  | "different-vendor-same-class"
  | "same-vendor-same-class"
  | "same-model"
  | "explicit-map"
  | "off";

/**
 * A supported fallback-chain entry name.
 */
export type FallbackEntry =
  | "different-vendor-same-class"
  | "same-vendor-different-model"
  | "default-model";

/**
 * The source label carried by a resolved pick — mirrors the fallback-chain
 * entry names from the design (Decision 6).  "primary" means the configured
 * policy succeeded on its first pick.
 */
export type PickSource =
  | "primary"
  | "fallback:different-vendor-same-class"
  | "fallback:same-vendor-different-model"
  | "fallback:default-model";

/**
 * The full pairing policy configuration object (mirrors the Terraform
 * `review_model_pairing` variable shape that is JSON-encoded into the
 * `REVIEW_MODEL_PAIRING` Actions variable).
 */
export interface PairingConfig {
  /** When false (or absent), the pairing tier is disabled. */
  enabled?: boolean;
  /** Primary pairing policy. */
  policy: PairingPolicy;
  /**
   * Tie-breaking order for "different-vendor-same-class".  Also drives the
   * vendor sequence for "same-vendor-different-model" fallback.
   */
  preferred_vendors?: string[];
  /**
   * Explicit author → reviewer map.  Consulted only when policy == "explicit-map".
   */
  explicit_map?: Record<string, string>;
  /**
   * Ordered fallback chain walked when the primary policy pick is not
   * satisfiable.
   */
  fallback_chain?: FallbackEntry[];
}

/**
 * Result returned by `selectReviewerModel`.  When `model` is undefined the
 * pairing tier produced no pick and the caller should fall through.
 */
export interface PairingResult {
  /** The resolved reviewer model ID. */
  model: string | undefined;
  /** How the model was resolved. */
  source: PickSource | "off" | "none";
  /** Warning strings to be emitted by the caller via core.warning(). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Vendor inference
// ---------------------------------------------------------------------------

/** Returns the vendor name for a given model ID, or undefined when unknown. */
function inferVendor(modelId: string): "anthropic" | "openai" | "xai" | undefined {
  if (
    modelId === "sonnet" ||
    modelId === "opus" ||
    modelId === "haiku" ||
    modelId.startsWith("claude-")
  ) {
    return "anthropic";
  }
  if (modelId.startsWith("gpt-") || modelId === "o3") {
    return "openai";
  }
  if (modelId.startsWith("grok-")) {
    return "xai";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Picks the canonical same-class model from a different vendor than the author,
 * honouring `preferredVendors` order.  Returns the model ID and vendor, or
 * undefined when no candidate is available.
 */
function pickDifferentVendorSameClass(
  authorVendor: string,
  className: string,
  availableProviders: readonly string[],
  preferredVendors: readonly string[],
  classTable: ClassTable,
): { model: string; vendor: string } | undefined {
  const classEntry = classTable[className as keyof ClassTable];
  if (!classEntry) return undefined;

  // Build the vendor try-order: preferred_vendors order, then remaining
  // available vendors, all filtered to exclude the author vendor.
  const tried = new Set<string>();
  const tryOrder: string[] = [];

  for (const v of preferredVendors) {
    if (v !== authorVendor && !tried.has(v)) {
      tried.add(v);
      tryOrder.push(v);
    }
  }
  // Also include any available provider not in preferredVendors.
  for (const v of availableProviders) {
    if (v !== authorVendor && !tried.has(v)) {
      tried.add(v);
      tryOrder.push(v);
    }
  }

  for (const vendor of tryOrder) {
    if (!availableProviders.includes(vendor)) continue;
    const models = classEntry[vendor as keyof typeof classEntry];
    if (models && models.length > 0) {
      return { model: models[0], vendor };
    }
  }
  return undefined;
}

/**
 * Picks a different model from the same vendor and same class as the author.
 * Never returns the author model itself.  Returns undefined when no alternative
 * exists.
 */
function pickSameVendorDifferentModel(
  authorModel: string,
  authorVendor: string,
  className: string,
  classTable: ClassTable,
): string | undefined {
  const classEntry = classTable[className as keyof ClassTable];
  if (!classEntry) return undefined;

  const models = classEntry[authorVendor as keyof typeof classEntry];
  if (!models) return undefined;

  for (const m of models) {
    if (m !== authorModel) return m;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Primary policy pickers
// ---------------------------------------------------------------------------

function applyDifferentVendorSameClass(
  _authorModel: string,
  authorVendor: string,
  className: string,
  availableProviders: readonly string[],
  preferredVendors: readonly string[],
  classTable: ClassTable,
  warnings: string[],
): string | undefined {
  const pick = pickDifferentVendorSameClass(
    authorVendor,
    className,
    availableProviders,
    preferredVendors,
    classTable,
  );
  if (!pick) {
    warnings.push(
      `Pairing policy "different-vendor-same-class": no cross-vendor ${className}-class model available ` +
        `(author vendor: ${authorVendor}, available providers: ${availableProviders.join(", ") || "none"}).`,
    );
    return undefined;
  }
  if (pick.vendor === authorVendor) {
    // Shouldn't happen but guard anyway.
    warnings.push(
      `Pairing policy "different-vendor-same-class": only author vendor (${authorVendor}) has a ${className}-class entry; ` +
        `could not select a different-vendor model.`,
    );
    return undefined;
  }
  return pick.model;
}

function applySameVendorSameClass(
  _authorModel: string,
  authorVendor: string,
  className: string,
  availableProviders: readonly string[],
  classTable: ClassTable,
  warnings: string[],
): string | undefined {
  if (!availableProviders.includes(authorVendor)) {
    warnings.push(
      `Pairing policy "same-vendor-same-class": author vendor "${authorVendor}" API key is not available.`,
    );
    return undefined;
  }

  const classEntry = classTable[className as keyof ClassTable];
  if (!classEntry) {
    warnings.push(
      `Pairing policy "same-vendor-same-class": class "${className}" not found in class table.`,
    );
    return undefined;
  }

  const models = classEntry[authorVendor as keyof typeof classEntry];
  if (!models || models.length === 0) {
    warnings.push(
      `Pairing policy "same-vendor-same-class": no ${className}-class model for vendor "${authorVendor}".`,
    );
    return undefined;
  }

  return models[0];
}

// ---------------------------------------------------------------------------
// Fallback chain walker
// ---------------------------------------------------------------------------

function walkFallbackChain(
  authorModel: string,
  authorVendor: string,
  className: string,
  availableProviders: readonly string[],
  preferredVendors: readonly string[],
  classTable: ClassTable,
  fallbackChain: readonly FallbackEntry[],
  warnings: string[],
  defaultModel: string,
): { model: string; source: PickSource } {
  for (const entry of fallbackChain) {
    if (entry === "different-vendor-same-class") {
      const pick = pickDifferentVendorSameClass(
        authorVendor,
        className,
        availableProviders,
        preferredVendors,
        classTable,
      );
      if (pick) {
        warnings.push(
          `Pairing fallback "different-vendor-same-class" used: selected "${pick.model}" (${pick.vendor}).`,
        );
        return { model: pick.model, source: "fallback:different-vendor-same-class" };
      }
      warnings.push(
        `Pairing fallback "different-vendor-same-class": no cross-vendor ${className}-class model available; continuing chain.`,
      );
    } else if (entry === "same-vendor-different-model") {
      const pick = pickSameVendorDifferentModel(
        authorModel,
        authorVendor,
        className,
        classTable,
      );
      if (pick && availableProviders.includes(authorVendor)) {
        warnings.push(
          `Pairing fallback "same-vendor-different-model" used: selected "${pick}" (${authorVendor}).`,
        );
        return { model: pick, source: "fallback:same-vendor-different-model" };
      }
      if (!availableProviders.includes(authorVendor)) {
        warnings.push(
          `Pairing fallback "same-vendor-different-model": author vendor "${authorVendor}" API key is not available; continuing chain.`,
        );
      } else {
        warnings.push(
          `Pairing fallback "same-vendor-different-model": no alternative ${className}-class model for vendor "${authorVendor}"; continuing chain.`,
        );
      }
    } else if (entry === "default-model") {
      warnings.push(
        `Pairing fallback "default-model" used: falling through to DEFAULT_MODEL "${defaultModel}".`,
      );
      return { model: defaultModel, source: "fallback:default-model" };
    }
  }

  // Implicit terminal fallback.
  warnings.push(
    `Pairing: exhausted fallback chain; falling through to DEFAULT_MODEL "${defaultModel}".`,
  );
  return { model: defaultModel, source: "fallback:default-model" };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Pure function that selects a reviewer model based on the authoring model,
 * the configured pairing policy, the available providers, and the class table.
 *
 * When `policy === "off"` or `config.enabled === false`, returns
 * `{ model: undefined, source: "off", warnings: [] }`.
 *
 * The caller is responsible for:
 *  - Emitting each `warnings` entry via `core.warning()`.
 *  - Falling through to `DEFAULT_MODEL` when `model` is `undefined`.
 *
 * @param authoringModel      The model ID that authored the PR.
 * @param config              The full `REVIEW_MODEL_PAIRING` config object.
 * @param availableProviders  Providers whose API key is set (anthropic/openai/xai).
 * @param classTable          The cross-vendor class table from model-classes.json.
 * @param defaultModel        The repo-level DEFAULT_MODEL (used by the
 *                            "default-model" fallback and same-model detection).
 */
export function selectReviewerModel(
  authoringModel: string,
  config: PairingConfig,
  availableProviders: readonly string[],
  classTable: ClassTable,
  defaultModel: string,
): PairingResult {
  const warnings: string[] = [];

  // --- Disabled / off ---
  if (!config.enabled || config.policy === "off") {
    return { model: undefined, source: "off", warnings: [] };
  }

  const policy = config.policy;
  const preferredVendors: string[] = config.preferred_vendors ?? [
    "openai",
    "xai",
    "anthropic",
  ];
  const fallbackChain: FallbackEntry[] = config.fallback_chain ?? ["default-model"];
  const explicitMap: Record<string, string> = config.explicit_map ?? {};

  // --- same-model policy: always return the author (the only allowed case) ---
  if (policy === "same-model") {
    return { model: authoringModel, source: "primary", warnings: [] };
  }

  // --- explicit-map policy ---
  if (policy === "explicit-map") {
    if (Object.hasOwn(explicitMap, authoringModel)) {
      return {
        model: explicitMap[authoringModel],
        source: "primary",
        warnings: [],
      };
    }
    // Map miss: walk fallback chain.
    warnings.push(
      `Pairing policy "explicit-map": no entry for authoring model "${authoringModel}"; walking fallback chain.`,
    );

    // We need author vendor and class for fallbacks, but they may be unknown.
    const authorVendor = inferVendor(authoringModel);
    if (!authorVendor) {
      warnings.push(
        `Pairing: cannot infer vendor for authoring model "${authoringModel}"; falling through to DEFAULT_MODEL.`,
      );
      const fallback = walkFallbackChain(
        authoringModel,
        "unknown",
        "unknown",
        availableProviders,
        preferredVendors,
        classTable,
        ["default-model"],
        warnings,
        defaultModel,
      );
      maybeErrorOnSameModel(authoringModel, fallback.model, defaultModel, warnings);
      return { model: fallback.model, source: fallback.source, warnings };
    }

    // Look up class for fallbacks that need it.
    const className = getClassFromTable(authoringModel, classTable);
    if (!className) {
      warnings.push(
        `Pairing: authoring model "${authoringModel}" not found in class table; falling through to DEFAULT_MODEL.`,
      );
      const fallback = walkFallbackChain(
        authoringModel,
        authorVendor,
        "unknown",
        availableProviders,
        preferredVendors,
        classTable,
        ["default-model"],
        warnings,
        defaultModel,
      );
      maybeErrorOnSameModel(authoringModel, fallback.model, defaultModel, warnings);
      return { model: fallback.model, source: fallback.source, warnings };
    }

    const fallback = walkFallbackChain(
      authoringModel,
      authorVendor,
      className,
      availableProviders,
      preferredVendors,
      classTable,
      fallbackChain,
      warnings,
      defaultModel,
    );
    maybeErrorOnSameModel(authoringModel, fallback.model, defaultModel, warnings);
    return { model: fallback.model, source: fallback.source, warnings };
  }

  // --- policies that need vendor + class ---
  const authorVendor = inferVendor(authoringModel);
  if (!authorVendor) {
    warnings.push(
      `Pairing: cannot infer vendor for authoring model "${authoringModel}"; falling through to DEFAULT_MODEL.`,
    );
    const fallback = walkFallbackChain(
      authoringModel,
      "unknown",
      "unknown",
      availableProviders,
      preferredVendors,
      classTable,
      ["default-model"],
      warnings,
      defaultModel,
    );
    maybeErrorOnSameModel(authoringModel, fallback.model, defaultModel, warnings);
    return { model: fallback.model, source: fallback.source, warnings };
  }

  const className = getClassFromTable(authoringModel, classTable);
  if (!className) {
    warnings.push(
      `Pairing: authoring model "${authoringModel}" is not in the class table; falling through to DEFAULT_MODEL.`,
    );
    const fallback = walkFallbackChain(
      authoringModel,
      authorVendor,
      "unknown",
      availableProviders,
      preferredVendors,
      classTable,
      ["default-model"],
      warnings,
      defaultModel,
    );
    maybeErrorOnSameModel(authoringModel, fallback.model, defaultModel, warnings);
    return { model: fallback.model, source: fallback.source, warnings };
  }

  // --- different-vendor-same-class ---
  if (policy === "different-vendor-same-class") {
    const primary = applyDifferentVendorSameClass(
      authoringModel,
      authorVendor,
      className,
      availableProviders,
      preferredVendors,
      classTable,
      warnings,
    );
    if (primary) {
      return { model: primary, source: "primary", warnings };
    }
    // Primary failed → walk fallback chain.
    const fallback = walkFallbackChain(
      authoringModel,
      authorVendor,
      className,
      availableProviders,
      preferredVendors,
      classTable,
      fallbackChain,
      warnings,
      defaultModel,
    );
    maybeErrorOnSameModel(authoringModel, fallback.model, defaultModel, warnings);
    return { model: fallback.model, source: fallback.source, warnings };
  }

  // --- same-vendor-same-class ---
  if (policy === "same-vendor-same-class") {
    const primary = applySameVendorSameClass(
      authoringModel,
      authorVendor,
      className,
      availableProviders,
      classTable,
      warnings,
    );
    if (primary) {
      return { model: primary, source: "primary", warnings };
    }
    const fallback = walkFallbackChain(
      authoringModel,
      authorVendor,
      className,
      availableProviders,
      preferredVendors,
      classTable,
      fallbackChain,
      warnings,
      defaultModel,
    );
    maybeErrorOnSameModel(authoringModel, fallback.model, defaultModel, warnings);
    return { model: fallback.model, source: fallback.source, warnings };
  }

  // Should never reach here for a valid policy value.
  warnings.push(
    `Pairing: unrecognized policy "${policy as string}"; falling through to DEFAULT_MODEL.`,
  );
  return { model: defaultModel, source: "fallback:default-model", warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Looks up the class for a model by scanning modelToClass in the classTable.
 * This avoids importing model-classes.ts directly so the function remains pure
 * and testable without filesystem access.
 *
 * The classTable passed by the caller comes from the loader; we derive
 * modelToClass from it by scanning.
 *
 * NOTE: This performs a forward-table scan.  For correct dual-class resolution
 * the caller should pass in a classTable whose first entry per (class, vendor)
 * is the canonical pick — the resolution prefers the first-encountered class,
 * which matches the `modelToClass` convention.
 */
function getClassFromTable(
  modelId: string,
  classTable: ClassTable,
): string | undefined {
  for (const [className, vendorMap] of Object.entries(classTable)) {
    for (const models of Object.values(vendorMap)) {
      if ((models as string[]).includes(modelId)) return className;
    }
  }
  return undefined;
}

/**
 * If the fallback landed on DEFAULT_MODEL and that equals the authoring model,
 * emits a loud `ERROR_MARKER` warning to the warnings array.  The caller will
 * turn this into `core.error()` in the resolve-model entry point.
 *
 * The design (Decision 5) requires `core.error()` — not just `core.warning()` —
 * in this case.  We signal it by prefixing the message with "ERROR:" so the
 * caller can distinguish.
 */
function maybeErrorOnSameModel(
  authoringModel: string,
  resolvedModel: string,
  defaultModel: string,
  warnings: string[],
): void {
  if (resolvedModel === authoringModel && resolvedModel === defaultModel) {
    warnings.push(
      `ERROR: DEFAULT_MODEL equals authoring model; reviewer will share the author's blind spots` +
        ` (authoring model: "${authoringModel}", DEFAULT_MODEL: "${defaultModel}").`,
    );
  }
}
