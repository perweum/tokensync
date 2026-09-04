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
import type { ResolvedCollection, CollectionNames, Metadata } from "./token-merger";
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
  metadata: Metadata,
): FigmaToCollectionsResult {
  const figmaCollectionNames = metadata.figma.collections;
  const varById = new Map(variables.map((v) => [v.id, v]));
  const unknownCollectionNames: string[] = [];

  // Pass 1: gather every recognized collection's raw (ref-preserving) flat token map
  // per mode, grouped by role. Needed in full before anything can be resolved, since
  // e.g. a theme's refs point at primitives and a semantic token's refs point at the
  // theme layer. Global is merged to a single "Value" entity — consistent with
  // parseRepository, which makes the same assumption on the GitHub side. Primitives
  // stays single-mode too *for the "primitives"-role collections specifically* — a
  // Size-role collection (sizeModes below) is the one exception allowed to be
  // genuinely multi-mode, exactly mirroring how Themes already works.
  //
  // A role can be backed by several physical Figma collections (see CollectionNames)
  // — e.g. "main color" and "support color" both mapped to "themes", each contributing
  // a mode literally named "Christmas". Those must merge into *one* Christmas entry,
  // not become two separate ResolvedCollections that both render as [data-theme="christmas"]
  // — hence keying themeModes/semanticModes/sizeModes by lowercased mode name instead of
  // pushing every (collection, mode) pair as its own entry.
  let primitivesRaw: Record<string, TokenValue> = {};
  let primitivesModeName: string | undefined;
  let globalRaw: Record<string, TokenValue> = {};
  let globalModeName: string | undefined;
  const themeModes = new Map<string, { modeName: string; raw: Record<string, TokenValue> }>();
  const semanticModes = new Map<string, { modeName: string; raw: Record<string, TokenValue> }>();
  const sizeModes = new Map<string, { modeName: string; raw: Record<string, TokenValue> }>();

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
        primitivesModeName ??= mode.name; // real Figma mode name — see Code Invariant in DECISIONS.md
      } else if (kind === "global") {
        globalRaw = { ...globalRaw, ...raw };
        globalModeName ??= mode.name;
      } else if (kind === "themes") {
        mergeIntoMode(themeModes, mode.name, raw);
      } else if (kind === "semantic") {
        mergeIntoMode(semanticModes, mode.name, raw);
      } else if (kind === "sizes") {
        mergeIntoMode(sizeModes, mode.name, raw);
      }
    }
  }

  // The single primitives context everything else (Global/Themes/Semantic) resolves
  // against — shared primitives plus the *default* size mode's values, when a Size
  // axis exists. Config order (metadata.sizes) wins over whatever order Figma
  // happened to return modes in; falls back to the first size mode found.
  const defaultSizeModeRaw =
    sizeModes.size === 0
      ? {}
      : (metadata.sizes
          .map((name) => sizeModes.get(name.toLowerCase())?.raw)
          .find((raw): raw is Record<string, TokenValue> => raw !== undefined) ??
        sizeModes.values().next().value!.raw);
  const defaultPrimitivesRaw = { ...primitivesRaw, ...defaultSizeModeRaw };

  // Pass 2: resolve. Each layer's context is exactly what it's allowed to reference.
  const result: ResolvedCollection[] = [];

  if (sizeModes.size === 0) {
    if (Object.keys(primitivesRaw).length > 0) {
      result.push({
        collectionName: figmaCollectionNames.primitives[0],
        modeName: primitivesModeName ?? "Value",
        tokens: resolveAllReferences(primitivesRaw),
        rawTokens: primitivesRaw,
        typographyStyles: [],
      });
    }
  } else {
    // One ResolvedCollection per size mode — mirrors Themes exactly. Each mode
    // carries the full merged set (shared primitives + that mode's own values)
    // so it's independently valid, but rawTokens only needs to record what's
    // this mode's own — the shared part is identical across every mode and
    // Figma alias creation for it doesn't depend on which mode is active.
    for (const { modeName, raw } of sizeModes.values()) {
      const merged = { ...primitivesRaw, ...raw };
      result.push({
        collectionName: figmaCollectionNames.primitives[0],
        modeName,
        tokens: resolveAllReferences(merged),
        rawTokens: merged,
        typographyStyles: [],
      });
    }
  }

  if (Object.keys(globalRaw).length > 0) {
    const resolved = resolveAllReferences({ ...defaultPrimitivesRaw, ...globalRaw });
    result.push({
      collectionName: figmaCollectionNames.global[0],
      modeName: globalModeName ?? "Value",
      tokens: filterByPaths(resolved, Object.keys(globalRaw)),
      rawTokens: globalRaw,
      typographyStyles: [],
    });
  }

  for (const { modeName, raw } of themeModes.values()) {
    const resolved = resolveAllReferences({ ...defaultPrimitivesRaw, ...raw });
    result.push({
      collectionName: figmaCollectionNames.themes[0],
      modeName,
      tokens: filterByPaths(resolved, Object.keys(raw)),
      rawTokens: raw,
      typographyStyles: [],
    });
  }

  // Semantic resolves against the default (first) theme mode specifically — the same
  // simplification parseRepository makes for display/diff purposes on the GitHub side.
  const defaultThemeRaw = themeModes.values().next().value?.raw ?? {};
  for (const { modeName, raw } of semanticModes.values()) {
    const resolved = resolveAllReferences({
      ...defaultPrimitivesRaw,
      ...defaultThemeRaw,
      ...globalRaw,
      ...raw,
    });
    result.push({
      collectionName: figmaCollectionNames.semantic[0],
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

/** Merge a mode's raw tokens into an existing entry with the same (lowercased)
 * name, or start a new one — so two physical collections that both contribute
 * a mode called "Christmas" produce one merged Christmas entry, not two. The
 * first-seen exact casing of the name wins for display. */
function mergeIntoMode(
  modes: Map<string, { modeName: string; raw: Record<string, TokenValue> }>,
  modeName: string,
  raw: Record<string, TokenValue>,
): void {
  const key = modeName.toLowerCase();
  const existing = modes.get(key);
  if (existing) {
    existing.raw = { ...existing.raw, ...raw };
  } else {
    modes.set(key, { modeName, raw });
  }
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
  figmaCollectionNames: CollectionNames,
): TokenFile[] {
  const varById = new Map(variables.map((v) => [v.id, v]));

  // Same reasoning as figmaToCollections: a role can be backed by several
  // physical collections, and two of them can each contribute a mode with the
  // same name (e.g. "main color" + "support color" both having a "Christmas"
  // mode). Gathering everything first and writing one file per role/mode
  // afterwards — instead of writing per Figma collection as we go — means
  // that case merges into one file instead of the second collection's write
  // silently overwriting the first at the same repoPath. Each variable keeps
  // its own modeId since a modeId is only meaningful within its own collection.
  let primitivesEntries: VarEntry[] = [];
  let globalEntries: VarEntry[] = [];
  const themeModeEntries = new Map<string, { modeName: string; entries: VarEntry[] }>();
  const semanticModeEntries = new Map<string, { modeName: string; entries: VarEntry[] }>();
  const sizeModeEntries = new Map<string, { modeName: string; entries: VarEntry[] }>();

  for (const collection of collections) {
    const collVars = variables.filter((v) => v.collectionId === collection.id);
    const kind = collectionKind(collection.name, figmaCollectionNames);

    if (kind === "primitives") {
      primitivesEntries = primitivesEntries.concat(toEntries(collVars, collection.modes[0].modeId));
    } else if (kind === "global") {
      globalEntries = globalEntries.concat(toEntries(collVars, collection.modes[0].modeId));
    } else if (kind === "themes") {
      for (const mode of collection.modes) {
        mergeIntoModeEntries(themeModeEntries, mode.name, toEntries(collVars, mode.modeId));
      }
    } else if (kind === "semantic") {
      for (const mode of collection.modes) {
        mergeIntoModeEntries(semanticModeEntries, mode.name, toEntries(collVars, mode.modeId));
      }
    } else if (kind === "sizes") {
      for (const mode of collection.modes) {
        mergeIntoModeEntries(sizeModeEntries, mode.name, toEntries(collVars, mode.modeId));
      }
    }
  }

  const files: TokenFile[] = [];
  files.push(...buildPrimitiveFiles(primitivesEntries, varById, tokensPath));
  files.push(...buildGlobalFiles(globalEntries, varById, tokensPath));
  for (const { modeName, entries } of themeModeEntries.values()) {
    const file = buildThemeFile(entries, modeName, varById, tokensPath);
    if (file) files.push(file);
  }
  for (const { modeName, entries } of semanticModeEntries.values()) {
    const file = buildSemanticFile(entries, modeName, varById, tokensPath);
    if (file) files.push(file);
  }
  for (const { modeName, entries } of sizeModeEntries.values()) {
    const file = buildSizeFile(entries, modeName, varById, tokensPath);
    if (file) files.push(file);
  }

  return files;
}

/** A variable paired with the modeId to read its value at — kept together
 * once entries from more than one physical collection can be merged, since a
 * modeId is only meaningful within the collection that issued it. */
type VarEntry = { variable: FigmaVariable; modeId: string };

function toEntries(vars: FigmaVariable[], modeId: string): VarEntry[] {
  return vars.map((variable) => ({ variable, modeId }));
}

function mergeIntoModeEntries(
  modes: Map<string, { modeName: string; entries: VarEntry[] }>,
  modeName: string,
  entries: VarEntry[],
): void {
  const key = modeName.toLowerCase();
  const existing = modes.get(key);
  if (existing) {
    existing.entries = existing.entries.concat(entries);
  } else {
    modes.set(key, { modeName, entries });
  }
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
  entries: VarEntry[],
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile[] {
  // Group by first path segment: color → color.json, geometry → geometry.json
  const groups = groupByFirstSegment(entries);
  return Object.entries(groups).map(([segment, segEntries]) => ({
    repoPath: joinPath(tokensPath, "primitives", `${segment}.json`),
    content: buildJsonFile(segEntries, varById),
  }));
}

function buildGlobalFiles(
  entries: VarEntry[],
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

  const typoEntries = entries.filter((e) => typoSegments.has(firstSegment(e.variable.name)));
  const spacingEntries = entries.filter((e) => spacingSegments.has(firstSegment(e.variable.name)));
  const otherEntries = entries.filter(
    (e) =>
      !typoSegments.has(firstSegment(e.variable.name)) &&
      !spacingSegments.has(firstSegment(e.variable.name)),
  );

  const files: TokenFile[] = [];
  if (typoEntries.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "typography.json"),
      content: buildJsonFile(typoEntries, varById),
    });
  if (spacingEntries.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "spacing.json"),
      content: buildJsonFile(spacingEntries, varById),
    });
  if (otherEntries.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "other.json"),
      content: buildJsonFile(otherEntries, varById),
    });

  return files;
}

/**
 * Write a Themes collection mode to semantic/themes/{name}.json.
 * The file contains the full light.* + dark.* token set for this theme variant.
 */
function buildThemeFile(
  entries: VarEntry[],
  modeName: string,
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile | null {
  if (entries.length === 0) return null;
  const themeName = sanitizeFileName(modeName);
  return {
    repoPath: joinPath(tokensPath, "semantic/themes", `${themeName}.json`),
    content: buildJsonFile(entries, varById),
  };
}

/**
 * Write a Semantic collection mode to semantic/{colorScheme}.json.
 * Light → semantic/light.json, Dark → semantic/dark.json.
 */
function buildSemanticFile(
  entries: VarEntry[],
  modeName: string,
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile | null {
  if (entries.length === 0) return null;

  const scheme = sanitizeFileName(modeName);
  return {
    repoPath: joinPath(tokensPath, "semantic", `${scheme}.json`),
    content: buildJsonFile(entries, varById),
  };
}

/**
 * Write a Size collection mode to primitives/sizes/{name}.json — mirrors
 * buildThemeFile exactly, one level under primitives instead of semantic.
 * Only the size-varying values live here; shared primitives stay in the flat
 * primitives/{segment}.json files buildPrimitiveFiles already writes.
 */
function buildSizeFile(
  entries: VarEntry[],
  modeName: string,
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
): TokenFile | null {
  if (entries.length === 0) return null;
  const sizeName = sanitizeFileName(modeName);
  return {
    repoPath: joinPath(tokensPath, "primitives/sizes", `${sizeName}.json`),
    content: buildJsonFile(entries, varById),
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

function buildJsonFile(entries: VarEntry[], varById: Map<string, FigmaVariable>): string {
  const tree: Record<string, unknown> = {};

  for (const { variable: v, modeId } of entries) {
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

type CollectionKind = "primitives" | "global" | "themes" | "semantic" | "sizes" | "unknown";

/**
 * A collection mapped to "sizes" feeds a second, orthogonal axis on
 * Primitives — one mode per size (mobile/desktop, …), merged with the shared
 * primitives at resolve time. See docs/design/size-axis.md and the Metadata
 * `sizes`/`sizeBreakpoints` fields.
 */
function collectionKind(name: string, names: CollectionNames): CollectionKind {
  if (names.primitives.includes(name)) return "primitives";
  if (names.global.includes(name)) return "global";
  if (names.themes.includes(name)) return "themes";
  if (names.semantic.includes(name)) return "semantic";
  if (names.sizes.includes(name)) return "sizes";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByFirstSegment(entries: VarEntry[]): Record<string, VarEntry[]> {
  const groups: Record<string, VarEntry[]> = {};
  for (const e of entries) {
    const seg = firstSegment(e.variable.name);
    if (!groups[seg]) groups[seg] = [];
    groups[seg].push(e);
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
