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
import { inferType } from "../../shared/figma-to-tokens";

export interface FigmaFlatMap {
  collectionName: string;
  modeName: string;
  /** dot-notation path → fully resolved string value (alias chains walked to the end) */
  values: Record<string, string>;
  /** dot-notation path → one-hop value: the literal itself, or "{target.dot.path}"
   * for an alias — never resolved past that one hop. Used for diffing: comparing
   * a token's own definition, not its effective value, so editing a primitive
   * doesn't make every token that references it look individually "changed." */
  rawValues: Record<string, string>;
}

/**
 * Produces one FigmaFlatMap per collection × mode.
 * `values` resolves aliases recursively to a final value; `rawValues` stops
 * at one hop, preserving which variable a token aliases.
 */
export function buildFigmaFlatMaps(
  collections: FigmaVariableCollection[],
  variables: FigmaVariable[],
): FigmaFlatMap[] {
  const varById = new Map(variables.map((v) => [v.id, v]));

  return collections.flatMap((collection) =>
    collection.modes.map((mode) => {
      const { values, rawValues } = buildModeMap(collection, mode.modeId, varById);
      return { collectionName: collection.name, modeName: mode.name, values, rawValues };
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModeMap(
  collection: FigmaVariableCollection,
  modeId: string,
  varById: Map<string, FigmaVariable>,
): { values: Record<string, string>; rawValues: Record<string, string> } {
  const values: Record<string, string> = {};
  const rawValues: Record<string, string> = {};

  for (const varId of collection.variableIds) {
    const variable = varById.get(varId);
    if (!variable) continue;

    const raw = variable.valuesByMode[modeId];
    if (raw === undefined) continue;

    const resolved = resolveValue(raw, variable, modeId, varById);
    if (resolved === null) continue;
    const rawStr = resolveOneHop(raw, variable, varById);
    if (rawStr === null) continue;

    const path = fromFigmaVarName(variable.name);
    values[path] = resolved;
    rawValues[path] = rawStr;
  }

  return { values, rawValues };
}

function resolveValue(
  value: FigmaVariableValue,
  variable: FigmaVariable,
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
    return resolveValue(targetValue, target, modeId, varById, depth + 1);
  }

  // RGBA color
  if (typeof value === "object" && value !== null && "r" in value) {
    return rgbaToHex(value as { r: number; g: number; b: number; a: number });
  }

  // Number — only a genuine "dimension" gets a "px" suffix, same rule
  // figma-to-tokens.ts's rawToTokenValue uses on the push side. Previously
  // every number got "px" unconditionally, so a plain number token (e.g.
  // opacity.low = 30, not a pixel dimension at all) permanently mismatched
  // GitHub's correctly bare-number value on every pull.
  if (typeof value === "number") {
    const type = inferType(variable.name, variable.resolvedType);
    return type === "dimension" ? `${value}px` : String(value);
  }

  // String
  if (typeof value === "string") {
    return value;
  }

  return null;
}

/**
 * Like resolveValue, but an alias stops after exactly one hop — the target's
 * own dot-path as a "{ref}" string, never resolved further. Mirrors what
 * GitHub's own rawTokens already preserve (see parseRepository/
 * figmaToCollections), so a token's own definition (literal, or which
 * variable it aliases) can be diffed directly against GitHub's, instead of
 * comparing fully-resolved values that make every consumer of a changed
 * primitive look individually "changed."
 */
function resolveOneHop(
  value: FigmaVariableValue,
  variable: FigmaVariable,
  varById: Map<string, FigmaVariable>,
): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "VARIABLE_ALIAS"
  ) {
    const target = varById.get(value.id);
    if (!target) return null;
    return `{${fromFigmaVarName(target.name)}}`;
  }

  if (typeof value === "object" && value !== null && "r" in value) {
    return rgbaToHex(value as { r: number; g: number; b: number; a: number });
  }

  if (typeof value === "number") {
    const type = inferType(variable.name, variable.resolvedType);
    return type === "dimension" ? `${value}px` : String(value);
  }

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
