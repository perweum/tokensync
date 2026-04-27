/**
 * Converts raw Figma Variable data (sent from the plugin sandbox) into
 * flat resolved string maps per collection/mode — ready to diff against GitHub tokens.
 *
 * Runs in the React UI iframe, not in the Figma sandbox.
 */

import type {
  FigmaVariable,
  FigmaVariableCollection,
  FigmaVariableValue,
} from "../../shared/messages";
import { fromFigmaVarName } from "../../shared/token-format";

export interface FigmaFlatMap {
  collectionName: string;
  modeName: string;
  /** dot-notation path → resolved string value */
  values: Record<string, string>;
}

/**
 * Produces one FigmaFlatMap per collection × mode.
 * Aliases are resolved recursively to raw values.
 */
export function buildFigmaFlatMaps(
  collections: FigmaVariableCollection[],
  variables: FigmaVariable[],
): FigmaFlatMap[] {
  const varById = new Map(variables.map((v) => [v.id, v]));

  return collections.flatMap((collection) =>
    collection.modes.map((mode) => ({
      collectionName: collection.name,
      modeName: mode.name,
      values: buildModeMap(collection, mode.modeId, varById),
    })),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModeMap(
  collection: FigmaVariableCollection,
  modeId: string,
  varById: Map<string, FigmaVariable>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const varId of collection.variableIds) {
    const variable = varById.get(varId);
    if (!variable) continue;

    const raw = variable.valuesByMode[modeId];
    if (raw === undefined) continue;

    const resolved = resolveValue(raw, modeId, varById);
    if (resolved === null) continue;

    const path = fromFigmaVarName(variable.name);
    result[path] = resolved;
  }

  return result;
}

function resolveValue(
  value: FigmaVariableValue,
  modeId: string,
  varById: Map<string, FigmaVariable>,
  depth = 0,
): string | null {
  if (depth > 10) return null; // guard against circular aliases

  // Variable alias → follow the chain
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "VARIABLE_ALIAS"
  ) {
    const target = varById.get(value.id);
    if (!target) return null;
    // Cross-collection aliases (e.g. Semantic → Primitives) have a different modeId.
    // Fall back to the first available mode value when the current modeId is not found.
    const targetValue = target.valuesByMode[modeId] ?? Object.values(target.valuesByMode)[0];
    if (targetValue === undefined) return null;
    return resolveValue(targetValue, modeId, varById, depth + 1);
  }

  // RGBA color
  if (typeof value === "object" && value !== null && "r" in value) {
    return rgbaToHex(value as { r: number; g: number; b: number; a: number });
  }

  // Number (dimension stored as raw px)
  if (typeof value === "number") {
    return `${value}px`;
  }

  // String
  if (typeof value === "string") {
    return value;
  }

  return null;
}

function rgbaToHex({ r, g, b, a }: { r: number; g: number; b: number; a: number }): string {
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  const base = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  if (Math.round(a * 255) === 255) return base;
  return `${base}${toHex(a)}`;
}
