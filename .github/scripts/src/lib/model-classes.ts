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
// Load and validate at import time
// ---------------------------------------------------------------------------

function loadData(): ModelClassData {
  const raw = JSON.parse(
    readFileSync(
      new URL("../../data/model-classes.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;

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

  return raw as ModelClassData;
}

const data: ModelClassData = loadData();

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
