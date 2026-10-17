import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The recognized capability class names. */
export type ClassName = "haiku" | "sonnet" | "opus";

/** The recognized vendor names. */
export type VendorName = "anthropic" | "openai" | "xai";

/**
 * The forward class table: maps each class → vendor → ordered model IDs.
 * The first entry per vendor is the canonical pick for that (class, vendor).
 */
export type ClassTable = Record<ClassName, Record<VendorName, string[]>>;

/** Shape of the model-classes.json data file. */
interface ModelClassData {
  classes: ClassTable;
  modelToClass: Record<string, ClassName>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_CLASS_NAMES = new Set<string>(["haiku", "sonnet", "opus"]);
const VALID_VENDOR_NAMES = new Set<string>(["anthropic", "openai", "xai"]);

function isClassName(value: unknown): value is ClassName {
  return typeof value === "string" && VALID_CLASS_NAMES.has(value);
}

/**
 * Validates a parsed JSON value against the full ModelClassData schema and
 * returns a typed ModelClassData on success, or throws a descriptive Error.
 *
 * Validation covers:
 *  - root is a non-null object
 *  - `classes` is a non-null object whose keys are valid ClassNames, whose
 *    values are non-null objects whose keys are valid VendorNames, and whose
 *    leaf values are arrays of strings
 *  - `modelToClass` is a non-null object whose values are valid ClassNames
 *
 * Exported so that tests can exercise it with arbitrary (malformed) input
 * without touching the filesystem.
 */
export function validateModelClassData(raw: unknown): ModelClassData {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("model-classes.json: root must be an object");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj["classes"] !== "object" || obj["classes"] === null) {
    throw new Error("model-classes.json: 'classes' must be an object");
  }

  if (typeof obj["modelToClass"] !== "object" || obj["modelToClass"] === null) {
    throw new Error("model-classes.json: 'modelToClass' must be an object");
  }

  // Validate nested structure of `classes`.
  const classesObj = obj["classes"] as Record<string, unknown>;
  for (const [className, vendorMap] of Object.entries(classesObj)) {
    if (!VALID_CLASS_NAMES.has(className)) {
      throw new Error(
        `model-classes.json: classes key "${className}" is not a valid ClassName` +
          ` (expected one of: ${[...VALID_CLASS_NAMES].join(", ")})`,
      );
    }
    if (typeof vendorMap !== "object" || vendorMap === null) {
      throw new Error(
        `model-classes.json: classes.${className} must be a non-null object`,
      );
    }
    const vendorObj = vendorMap as Record<string, unknown>;
    for (const [vendorName, models] of Object.entries(vendorObj)) {
      if (!VALID_VENDOR_NAMES.has(vendorName)) {
        throw new Error(
          `model-classes.json: classes.${className} key "${vendorName}" is not a valid VendorName` +
            ` (expected one of: ${[...VALID_VENDOR_NAMES].join(", ")})`,
        );
      }
      if (!Array.isArray(models)) {
        throw new Error(
          `model-classes.json: classes.${className}.${vendorName} must be an array`,
        );
      }
      for (let i = 0; i < (models as unknown[]).length; i++) {
        if (typeof (models as unknown[])[i] !== "string") {
          throw new Error(
            `model-classes.json: classes.${className}.${vendorName}[${i}] must be a string`,
          );
        }
      }
    }
  }

  // Validate every value in `modelToClass` is a valid ClassName.
  const modelToClassObj = obj["modelToClass"] as Record<string, unknown>;
  for (const [modelId, className] of Object.entries(modelToClassObj)) {
    if (!isClassName(className)) {
      throw new Error(
        `model-classes.json: modelToClass["${modelId}"] = "${String(className)}" is not a valid ClassName` +
          ` (expected one of: ${[...VALID_CLASS_NAMES].join(", ")})`,
      );
    }
  }

  return raw as ModelClassData;
}

// ---------------------------------------------------------------------------
// Load and validate at import time
// ---------------------------------------------------------------------------

function loadData(): ModelClassData {
  const raw = JSON.parse(
    readFileSync(
      new URL("../../data/model-classes.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;

  return validateModelClassData(raw);
}

const data: ModelClassData = loadData();

/**
 * The loaded cross-vendor class table, ready for use by the pairing resolver.
 * This is the `classes` portion of model-classes.json; export it so callers
 * can pass it directly to `selectReviewerModel` without duplicating the load.
 */
export const classTable: ClassTable = data.classes;

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/**
 * Returns the capability class of the given model ID, or `undefined` when the
 * model ID is not recognized.
 *
 * Callers MUST use this function — not a reverse iteration over `classes` —
 * to resolve an author-model → class, so that any future dual-class entries
 * follow the resolution recorded in `modelToClass`.
 *
 * @param modelId  The model ID to look up (e.g. "sonnet", "gpt-5.6-terra").
 * @returns        The capability class, or `undefined`.
 */
export function getClass(modelId: string): ClassName | undefined {
  if (!Object.hasOwn(data.modelToClass, modelId)) return undefined;
  return data.modelToClass[modelId];
}

/**
 * Returns the canonical model ID for the given class and vendor, or `undefined`
 * when no entry exists for that combination.
 *
 * The canonical model is the first entry in `classes[className][vendor]` and
 * is the pairing resolver's default pick for a `(class, vendor)` pair.
 *
 * @param className  The capability class (haiku / sonnet / opus).
 * @param vendor     The vendor name (anthropic / openai / xai).
 * @returns          The canonical model ID, or `undefined`.
 */
export function getCanonicalPick(
  className: string,
  vendor: string,
): string | undefined {
  if (!Object.hasOwn(data.classes, className)) return undefined;
  const vendorMap = data.classes[className as ClassName];
  if (!Object.hasOwn(vendorMap, vendor)) return undefined;
  const models = vendorMap[vendor as VendorName];
  if (models.length === 0) return undefined;
  return models[0];
}

/**
 * Returns the ordered list of model IDs for the given class and vendor.
 *
 * The first entry is the canonical pick; subsequent entries are recognized
 * alternatives in the same class. Returns an empty array when no entry exists
 * for the given `(className, vendor)` pair.
 *
 * @param className  The capability class (haiku / sonnet / opus).
 * @param vendor     The vendor name (anthropic / openai / xai).
 * @returns          Ordered model IDs (canonical first), or `[]`.
 */
export function listModels(
  className: string,
  vendor: string,
): readonly string[] {
  if (!Object.hasOwn(data.classes, className)) return [];
  const vendorMap = data.classes[className as ClassName];
  if (!Object.hasOwn(vendorMap, vendor)) return [];
  return vendorMap[vendor as VendorName];
}
