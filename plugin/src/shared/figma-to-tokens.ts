/**
 * Converts Figma Variable data into:
 *   1. ResolvedCollection[] for diffing (same shape as parseRepository output)
 *   2. TokenFile[] for writing to GitHub
 */

import type {
  FigmaVariable,
  FigmaVariableCollection,
  FigmaVariableValue,
  TokenValue,
} from "./messages";
import type { ResolvedCollection } from "./token-merger";
import { fromFigmaVarName, resolveAllReferences } from "./token-format";

export interface TokenFile {
  repoPath: string; // e.g. "tokens/primitives/color.json"
  content: string; // formatted JSON
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FigmaToCollectionsResult {
  collections: ResolvedCollection[];
  /** Figma collection names that matched none of the four configured layers — excluded above, never silently written. */
  unknownCollectionNames: string[];
}

/**
 * Produce ResolvedCollection[] from Figma data — used for diffing against GitHub.
 *
 * Collections whose name doesn't match any of the four configured layers (primitives/
 * global/themes/semantic) are excluded and reported separately, rather than appearing
 * in the diff only to be silently skipped later by figmaToTokenFiles — see
 * DECISIONS.md "Priority 2 — Publish blockers".
 *
 * `tokens` is genuinely resolved here (aliases walked to their final value), mirroring
 * how parseRepository resolves the GitHub side — semantic against the default theme +
 * global, themes and global against primitives. `rawTokens` keeps every {ref} exactly
 * as Figma stored it, for writing token files and for the CSS transformer's light/dark
 * var() cascade. Before this, `tokens` and `rawTokens` were literally the same object —
 * fine for the one alias shape the CSS transformer special-cases ({light.X}/{dark.X}),
 * silently wrong for anything else (a theme referencing a primitive, a semantic token
 * whose alias is nested under an extra path segment like {color.light.X}) — those
 * unresolved {ref} strings were leaking straight into generated CSS as invalid values.
 */
export function figmaToCollections(
  collections: FigmaVariableCollection[],
  variables: FigmaVariable[],
  figmaCollectionNames: { primitives: string; global: string; themes: string; semantic: string },
): FigmaToCollectionsResult {
  const varById = new Map(variables.map((v) => [v.id, v]));
  const unknownCollectionNames: string[] = [];

  // Pass 1: gather every recognized collection's raw (ref-preserving) flat token map
  // per mode, grouped by role. Needed in full before anything can be resolved, since
  // e.g. a theme's refs point at primitives and a semantic token's refs point at the
  // theme layer. Primitives/Global are merged to a single "Value" entity — consistent
  // with parseRepository, which makes the same assumption on the GitHub side. A
  // primitives/global collection with genuinely different per-mode values (e.g. a
  // breakpoint-driven "Size" collection) isn't handled correctly by this yet — same
  // open problem as the multi-collection-per-role config, see DECISIONS.md.
  let primitivesRaw: Record<string, TokenValue> = {};
  let primitivesModeName: string | undefined;
  let globalRaw: Record<string, TokenValue> = {};
  let globalModeName: string | undefined;
  const themeModes: Array<{ modeName: string; raw: Record<string, TokenValue> }> = [];
  const semanticModes: Array<{ modeName: string; raw: Record<string, TokenValue> }> = [];

  for (const collection of collections) {
    const kind = collectionKind(collection.name, figmaCollectionNames);
    if (kind === "unknown") {
      unknownCollectionNames.push(collection.name);
      continue;
    }

    const collVars = variables.filter((v) => v.collectionId === collection.id);

    for (const mode of collection.modes) {
      const raw = buildFlatTokens(collVars, mode.modeId, varById);
      if (kind === "primitives") {
        primitivesRaw = { ...primitivesRaw, ...raw };
        primitivesModeName ??= mode.name; // first mode's real name — must match the raw
        // Figma data buildFilesFromDiffs later filters against, or a collection that
        // looks selected in the diff silently drops out of the PR (see DECISIONS.md).
      } else if (kind === "global") {
        globalRaw = { ...globalRaw, ...raw };
        globalModeName ??= mode.name;
      } else if (kind === "themes") themeModes.push({ modeName: mode.name, raw });
      else if (kind === "semantic") semanticModes.push({ modeName: mode.name, raw });
    }
  }

  // Pass 2: resolve. Each layer's context is exactly what it's allowed to reference.
  const result: ResolvedCollection[] = [];

  if (Object.keys(primitivesRaw).length > 0) {
    result.push({
      collectionName: figmaCollectionNames.primitives,
      modeName: primitivesModeName ?? "Value",
      tokens: resolveAllReferences(primitivesRaw),
      rawTokens: primitivesRaw,
      typographyStyles: [],
    });
  }

  if (Object.keys(globalRaw).length > 0) {
    const resolved = resolveAllReferences({ ...primitivesRaw, ...globalRaw });
    result.push({
      collectionName: figmaCollectionNames.global,
      modeName: globalModeName ?? "Value",
      tokens: filterByPaths(resolved, Object.keys(globalRaw)),
      rawTokens: globalRaw,
      typographyStyles: [],
    });
  }

  for (const { modeName, raw } of themeModes) {
    const resolved = resolveAllReferences({ ...primitivesRaw, ...raw });
    result.push({
      collectionName: figmaCollectionNames.themes,
      modeName,
      tokens: filterByPaths(resolved, Object.keys(raw)),
      rawTokens: raw,
      typographyStyles: [],
    });
  }

  // Semantic resolves against the default (first) theme mode specifically — the same
  // simplification parseRepository makes for display/diff purposes on the GitHub side.
  const defaultThemeRaw = themeModes[0]?.raw ?? {};
  for (const { modeName, raw } of semanticModes) {
    const resolved = resolveAllReferences({
      ...primitivesRaw,
      ...defaultThemeRaw,
      ...globalRaw,
      ...raw,
    });
    result.push({
      collectionName: figmaCollectionNames.semantic,
      modeName,
      tokens: filterByPaths(resolved, Object.keys(raw)),
      rawTokens: raw,
      // Typography styles read from Figma come from Text Styles (getLocalTextStylesAsync),
      // a separate API surface from Variables — not yet wired into the push diff.
      typographyStyles: [],
    });
  }

  return { collections: result, unknownCollectionNames };
}

/** Keep only the paths that appear in the allowlist. */
function filterByPaths(
  flat: Record<string, TokenValue>,
  paths: string[],
): Record<string, TokenValue> {
  const set = new Set(paths);
  return Object.fromEntries(Object.entries(flat).filter(([k]) => set.has(k)));
}

/**
 * Produce token JSON files suitable for committing to GitHub.
 */
export function figmaToTokenFiles(
  collections: FigmaVariableCollection[],
  variables: FigmaVariable[],
  tokensPath: string,
  figmaCollectionNames: { primitives: string; global: string; themes: string; semantic: string },
): TokenFile[] {
  const varById = new Map(variables.map((v) => [v.id, v]));
  const files: TokenFile[] = [];

  for (const collection of collections) {
    const collVars = variables.filter((v) => v.collectionId === collection.id);
    const kind = collectionKind(collection.name, figmaCollectionNames);

    if (kind === "primitives") {
      files.push(...buildPrimitiveFiles(collVars, collection.modes[0].modeId, varById, tokensPath));
    } else if (kind === "global") {
      files.push(...buildGlobalFiles(collVars, collection.modes[0].modeId, varById, tokensPath));
    } else if (kind === "themes") {
      for (const mode of collection.modes) {
        const file = buildThemeFile(collVars, mode, varById, tokensPath);
        if (file) files.push(file);
      }
    } else if (kind === "semantic") {
      for (const mode of collection.modes) {
        const file = buildSemanticFile(collVars, mode, varById, tokensPath);
        if (file) files.push(file);
      }
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Flat token map builder
// ---------------------------------------------------------------------------

function buildFlatTokens(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
): Record<string, TokenValue> {
  const result: Record<string, TokenValue> = {};

  for (const v of vars) {
    const raw = v.valuesByMode[modeId];
    if (raw === undefined) continue;

    const path = fromFigmaVarName(v.name);
    const $type = inferType(v.name, v.resolvedType);
    const $value = rawToTokenValue(raw, $type, varById);
    if ($value === null) continue;

    result[path] = {
      $type,
      $value,
      ...(v.description ? { $description: v.description } : {}),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

function buildPrimitiveFiles(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile[] {
  // Group by first path segment: color → color.json, geometry → geometry.json
  const groups = groupByFirstSegment(vars);
  return Object.entries(groups).map(([segment, segVars]) => ({
    repoPath: joinPath(tokensPath, "primitives", `${segment}.json`),
    content: buildJsonFile(segVars, modeId, varById),
  }));
}

function buildGlobalFiles(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile[] {
  const typoSegments = new Set([
    "text",
    "fontFamily",
    "fontWeight",
    "heading",
    "body",
    "label",
    "code",
  ]);
  const spacingSegments = new Set([
    "spacing",
    "radius",
    "borderWidth",
    "inline",
    "layout",
    "component",
  ]);

  const typoVars = vars.filter((v) => typoSegments.has(firstSegment(v.name)));
  const spacingVars = vars.filter((v) => spacingSegments.has(firstSegment(v.name)));
  const otherVars = vars.filter(
    (v) => !typoSegments.has(firstSegment(v.name)) && !spacingSegments.has(firstSegment(v.name)),
  );

  const files: TokenFile[] = [];
  if (typoVars.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "typography.json"),
      content: buildJsonFile(typoVars, modeId, varById),
    });
  if (spacingVars.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "spacing.json"),
      content: buildJsonFile(spacingVars, modeId, varById),
    });
  if (otherVars.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "other.json"),
      content: buildJsonFile(otherVars, modeId, varById),
    });

  return files;
}

/**
 * Write a Themes collection mode to semantic/themes/{name}.json.
 * The file contains the full light.* + dark.* token set for this theme variant.
 */
function buildThemeFile(
  vars: FigmaVariable[],
  mode: { modeId: string; name: string },
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile | null {
  if (vars.length === 0) return null;
  const themeName = sanitizeFileName(mode.name);
  return {
    repoPath: joinPath(tokensPath, "semantic/themes", `${themeName}.json`),
    content: buildJsonFile(vars, mode.modeId, varById),
  };
}

/**
 * Write a Semantic collection mode to semantic/{colorScheme}.json.
 * Light → semantic/light.json, Dark → semantic/dark.json.
 */
function buildSemanticFile(
  vars: FigmaVariable[],
  mode: { modeId: string; name: string },
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile | null {
  if (vars.length === 0) return null;

  const scheme = sanitizeFileName(mode.name);
  return {
    repoPath: joinPath(tokensPath, "semantic", `${scheme}.json`),
    content: buildJsonFile(vars, mode.modeId, varById),
  };
}

/**
 * Mode name → safe file name: lowercase, spaces and slashes collapsed to "-".
 * A slash in a mode name must not create a subdirectory the parser won't read back.
 */
function sanitizeFileName(modeName: string): string {
  return modeName.toLowerCase().replace(/[\s/]+/g, "-");
}

// ---------------------------------------------------------------------------
// JSON file builder (nested tree from flat variables)
// ---------------------------------------------------------------------------

function buildJsonFile(
  vars: FigmaVariable[],
  modeId: string,
  varById: Map<string, FigmaVariable>,
): string {
  const tree: Record<string, unknown> = {};

  for (const v of vars) {
    const raw = v.valuesByMode[modeId];
    if (raw === undefined) continue;

    const $type = inferType(v.name, v.resolvedType);
    const $value = rawToTokenValue(raw, $type, varById);
    if ($value === null) continue;

    const path = fromFigmaVarName(v.name);
    const entry: Record<string, any> = { $type, $value };
    if (v.description) {
      entry.$description = v.description;
    }
    setNested(tree, path.split("."), entry);
  }

  return JSON.stringify(tree, null, 2);
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function rawToTokenValue(
  raw: FigmaVariableValue,
  $type: string,
  varById: Map<string, FigmaVariable>,
): string | null {
  // Alias → reference
  if (typeof raw === "object" && raw !== null && "type" in raw && raw.type === "VARIABLE_ALIAS") {
    const target = varById.get(raw.id);
    if (!target) return null;
    return `{${fromFigmaVarName(target.name)}}`;
  }

  // Color
  if ($type === "color" && typeof raw === "object" && raw !== null && "r" in raw) {
    const c = raw as { r: number; g: number; b: number; a?: number };
    const a = c.a ?? 1;
    const hex = (n: number) =>
      Math.round(n * 255)
        .toString(16)
        .padStart(2, "0");
    if (Math.round(a * 255) === 255) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
    return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a.toFixed(2)})`;
  }

  // Boolean
  if (typeof raw === "boolean") return String(raw);

  // Number → dimension string or plain number
  if (typeof raw === "number") {
    if ($type === "dimension") return `${raw}px`;
    if ($type === "fontWeight") return String(raw);
    return String(raw);
  }

  if (typeof raw === "string") return raw;

  return null;
}

// ---------------------------------------------------------------------------
// Type inference from variable name + Figma resolvedType
// ---------------------------------------------------------------------------

function inferType(name: string, resolvedType: string): string {
  if (resolvedType === "COLOR") return "color";
  if (resolvedType === "BOOLEAN") return "boolean";
  if (resolvedType === "STRING") {
    if (/family|font/i.test(name)) return "fontFamily";
    return "string";
  }
  if (resolvedType === "FLOAT") {
    if (/size|spacing|padding|radius|width|height|border|gap/i.test(name)) return "dimension";
    if (/weight/i.test(name)) return "fontWeight";
    if (/lineHeight|line.height/i.test(name)) return "number";
    if (/letterSpacing|letter.spacing/i.test(name)) return "dimension";
    return "number";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Collection kind detection
// ---------------------------------------------------------------------------

type CollectionKind = "primitives" | "global" | "themes" | "semantic" | "unknown";

type CollectionNames = { primitives: string; global: string; themes: string; semantic: string };

function collectionKind(name: string, names: CollectionNames): CollectionKind {
  if (name === names.primitives) return "primitives";
  if (name === names.global) return "global";
  if (name === names.themes) return "themes";
  if (name === names.semantic) return "semantic";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByFirstSegment(vars: FigmaVariable[]): Record<string, FigmaVariable[]> {
  const groups: Record<string, FigmaVariable[]> = {};
  for (const v of vars) {
    const seg = firstSegment(v.name);
    if (!groups[seg]) groups[seg] = [];
    groups[seg].push(v);
  }
  return groups;
}

function firstSegment(varName: string): string {
  return varName.split("/")[0];
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/|\/$/g, ""))
    .filter(Boolean)
    .join("/");
}

function setNested(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof current[keys[i]] !== "object" || current[keys[i]] === null) {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}
