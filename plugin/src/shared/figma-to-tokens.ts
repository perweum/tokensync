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
import type { ResolvedCollection, CollectionNames, CollectionSources, Metadata } from "./token-merger";
import {
  fromFigmaVarName,
  resolveAllReferences,
  isPureRef,
  isTokenValue,
  filterByPaths,
  formatFigmaColor,
} from "./token-format";
import type { TypographyStyle } from "./typography-styles";

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
  /** Dot-paths whose Figma variable is a "ghost" alias — the picker shows the
   * right target name, but the underlying link is dead — so the field was
   * dropped entirely rather than written with a value. See isBrokenAlias. */
  brokenAliasPaths: string[];
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
  typographyStyles: TypographyStyle[] = [],
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
  const brokenAliasPaths: string[] = [];

  for (const collection of collections) {
    const kind = collectionKind(collection.name, figmaCollectionNames);
    if (kind === "unknown") {
      unknownCollectionNames.push(collection.name);
      continue;
    }

    const collVars = variables.filter((v) => v.collectionId === collection.id);

    for (const mode of collection.modes) {
      const { tokens: raw, brokenAliasPaths: broken } = buildFlatTokens(collVars, mode.modeId, varById);
      brokenAliasPaths.push(...broken);
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

  // The default theme's raw values — needed by both Global (a type style's
  // fontFamily/fontWeight fields commonly reference a theme-scoped choice
  // like {font-family.display}, not Primitives directly — see
  // parseRepository's identical fix on the GitHub side) and Semantic below.
  // Config order (metadata.themes) wins over whatever order Figma happened
  // to return modes in, same reasoning as defaultSizeModeRaw just above.
  const defaultThemeRaw =
    themeModes.size === 0
      ? {}
      : (metadata.themes
          .map((name) => themeModes.get(name.toLowerCase())?.raw)
          .find((raw): raw is Record<string, TokenValue> => raw !== undefined) ??
        themeModes.values().next().value!.raw);

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

  // Real Figma Text Style fields join the flat Global map like any other
  // token — including textCase/textDecoration, which have no Variable
  // representation at all and would otherwise never appear in the diff view.
  // Only lets a field win when it's genuinely bound (a {ref}) or there's no
  // Variable-derived value at that path at all — see shouldTypographyFieldWin.
  for (const [path, token] of Object.entries(flattenTypographyStyles(typographyStyles))) {
    if (shouldTypographyFieldWin(globalRaw[path], token)) {
      globalRaw[path] = token;
    }
  }

  if (Object.keys(globalRaw).length > 0) {
    const resolved = resolveAllReferences({ ...defaultPrimitivesRaw, ...defaultThemeRaw, ...globalRaw });
    result.push({
      // Falls back to a literal "Global" when no Figma collection is actually
      // mapped to the role (figmaCollectionNames.global === []) — a real,
      // common case for a project whose only typography source is Text
      // Styles, with no matching decomposed Variables ever set up. Without
      // this, collectionName was `undefined`, which renders as a blank diff
      // tab label — the row still showed a count, just no title.
      collectionName: figmaCollectionNames.global[0] ?? "Global",
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

  // Semantic resolves against the default theme mode specifically — the same
  // simplification parseRepository makes for display/diff purposes on the GitHub
  // side.
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

  return { collections: result, unknownCollectionNames, brokenAliasPaths };
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


export interface FigmaToTokenFilesResult {
  files: TokenFile[];
  /** Dot-paths skipped because a real Figma variable name structurally
   * collided with another one at the same position (e.g. "surface/brand"
   * and "surface/brand/default" both existing) — see setNested. Whichever
   * shape was established first in the written file; the other is listed
   * here rather than silently corrupting or replacing it. */
  conflictPaths: string[];
}

/**
 * Produce token JSON files suitable for committing to GitHub.
 */
export function figmaToTokenFiles(
  collections: FigmaVariableCollection[],
  variables: FigmaVariable[],
  tokensPath: string,
  figmaCollectionNames: CollectionNames,
  typographyStyles: TypographyStyle[] = [],
): FigmaToTokenFilesResult {
  const varById = new Map(variables.map((v) => [v.id, v]));
  const conflictPaths: string[] = [];

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
  files.push(...buildPrimitiveFiles(primitivesEntries, varById, tokensPath, conflictPaths));
  files.push(...buildGlobalFiles(globalEntries, varById, tokensPath, typographyStyles, conflictPaths));
  for (const { modeName, entries } of themeModeEntries.values()) {
    const file = buildThemeFile(entries, modeName, varById, tokensPath, conflictPaths);
    if (file) files.push(file);
  }
  for (const { modeName, entries } of semanticModeEntries.values()) {
    const file = buildSemanticFile(entries, modeName, varById, tokensPath, conflictPaths);
    if (file) files.push(file);
  }
  for (const { modeName, entries } of sizeModeEntries.values()) {
    const file = buildSizeFile(entries, modeName, varById, tokensPath, conflictPaths);
    if (file) files.push(file);
  }

  return { files, conflictPaths };
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
): { tokens: Record<string, TokenValue>; brokenAliasPaths: string[] } {
  const result: Record<string, TokenValue> = {};
  const brokenAliasPaths: string[] = [];

  for (const v of vars) {
    const raw = v.valuesByMode[modeId];
    if (raw === undefined) continue;

    const path = fromFigmaVarName(v.name);
    const $type = inferType(v.name, v.resolvedType);
    const $value = rawToTokenValue(raw, $type, varById);
    if ($value === null) {
      if (isBrokenAlias(raw, varById)) brokenAliasPaths.push(path);
      continue;
    }

    result[path] = {
      $type,
      $value,
      ...(v.description ? { $description: v.description } : {}),
    };
  }

  return { tokens: result, brokenAliasPaths };
}

/**
 * True when `raw` is a VARIABLE_ALIAS whose target id doesn't resolve to any
 * variable Figma actually returned — a "ghost" alias, confirmed live (Vy's
 * Spor system): Figma's own variable picker still shows the intended
 * target's name correctly, but the internal link is dead (the target was
 * deleted/recreated and the alias's id was never repointed). rawToTokenValue
 * already returns null for this — correct, since Token Spark has no way to
 * know what the intended value should be — but nothing distinguished it from
 * any other "no value" reason, so the whole field was silently dropped from
 * every generated output with zero trace, making a data-integrity issue
 * inside Figma itself extremely hard to diagnose from the sync side.
 */
function isBrokenAlias(raw: FigmaVariableValue, varById: Map<string, FigmaVariable>): boolean {
  return (
    typeof raw === "object" && raw !== null && "type" in raw && raw.type === "VARIABLE_ALIAS" && !varById.has(raw.id)
  );
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

function buildPrimitiveFiles(
  entries: VarEntry[],
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
  conflictPaths: string[],
): TokenFile[] {
  // Group by first path segment: color → color.json, geometry → geometry.json
  const groups = groupByFirstSegment(entries);
  return Object.entries(groups).map(([segment, segEntries]) => ({
    repoPath: joinPath(tokensPath, "primitives", `${segment}.json`),
    content: buildJsonFile(segEntries, varById, conflictPaths),
  }));
}

function buildGlobalFiles(
  entries: VarEntry[],
  varById: Map<string, FigmaVariable>,
  tokensPath: string,
  typographyStyles: TypographyStyle[],
  conflictPaths: string[],
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
  if (typoEntries.length > 0 || typographyStyles.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "typography.json"),
      content: injectTypographyStyles(
        buildJsonFile(typoEntries, varById, conflictPaths),
        typographyStyles,
      ),
    });
  if (spacingEntries.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "spacing.json"),
      content: buildJsonFile(spacingEntries, varById, conflictPaths),
    });
  if (otherEntries.length > 0)
    files.push({
      repoPath: joinPath(tokensPath, "semantic/global", "other.json"),
      content: buildJsonFile(otherEntries, varById, conflictPaths),
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
  conflictPaths: string[],
): TokenFile | null {
  if (entries.length === 0) return null;
  const themeName = sanitizeFileName(modeName);
  return {
    repoPath: joinPath(tokensPath, "semantic/themes", `${themeName}.json`),
    content: buildJsonFile(entries, varById, conflictPaths),
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
  conflictPaths: string[],
): TokenFile | null {
  if (entries.length === 0) return null;

  const scheme = sanitizeFileName(modeName);
  return {
    repoPath: joinPath(tokensPath, "semantic", `${scheme}.json`),
    content: buildJsonFile(entries, varById, conflictPaths),
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
  conflictPaths: string[],
): TokenFile | null {
  if (entries.length === 0) return null;
  const sizeName = sanitizeFileName(modeName);
  return {
    repoPath: joinPath(tokensPath, "primitives/sizes", `${sizeName}.json`),
    content: buildJsonFile(entries, varById, conflictPaths),
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
  entries: VarEntry[],
  varById: Map<string, FigmaVariable>,
  conflictPaths: string[],
): string {
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
    if (!setNested(tree, path.split("."), entry)) conflictPaths.push(path);
  }

  return JSON.stringify(tree, null, 2);
}

/**
 * Flattens Text Style fields into the same "dot.path" → TokenValue shape
 * every other Global token uses, so they diff and resolve exactly like an
 * ordinary Variable-derived entry (see figmaToCollections). The group-level
 * `$type: "typography"` marker itself has no equivalent here — it isn't a
 * token, so it isn't diffable in this flat-map model; see injectTypographyStyles
 * below for where it actually gets written.
 */
export function flattenTypographyStyles(styles: TypographyStyle[]): Record<string, TokenValue> {
  const flat: Record<string, TokenValue> = {};
  for (const style of styles) {
    for (const [field, token] of Object.entries(style.fields)) {
      flat[`${style.path}.${field}`] = token;
    }
  }
  return flat;
}

/**
 * Whether a Text-Style-derived typography field is safe to overlay onto
 * whatever the Variable-derived tree already has at that path.
 *
 * Originally this overwrote unconditionally, on the theory that a bound
 * field's value here is already exactly what the matching Variable-derived
 * entry would produce (same underlying bound variable) — true when the
 * field genuinely *is* bound. It doesn't hold for a field the Text Style
 * leaves unbound: reading it then falls back to a plain literal (see
 * getLocalTypographyStyles' readLiteralField), which silently clobbered a
 * real Variable-derived alias. Confirmed live against Coop's actual file
 * (tokensync-coop-stresstest PR #35): fontFamily/fontWeight were bound and
 * round-tripped fine, fontSize wasn't, and a real `{primitive.font-size.11}`
 * alias baked into a dead `48` — breaking that token's size-axis live
 * switching, with zero Figma Variable change involved.
 *
 * A ref should always win (it's the same or better information); a literal
 * should only win when there's nothing there yet — a Text Style created by
 * hand with no matching Variable at all, or a field like textCase/
 * textDecoration that has no Variable representation to begin with.
 */
function shouldTypographyFieldWin(existing: TokenValue | undefined, incoming: TokenValue): boolean {
  return !existing || isPureRef(incoming.$value);
}

/**
 * Overlays real Figma Text Styles onto a built typography.json: sets the
 * group-level `$type: "typography"` marker (which has no Variable
 * counterpart — it only exists because a matching Text Style does), then
 * writes each field the Text Style reports only when shouldTypographyFieldWin
 * allows it — see that function for why this can't be unconditional.
 */
function injectTypographyStyles(json: string, styles: TypographyStyle[]): string {
  if (styles.length === 0) return json;

  const tree = JSON.parse(json) as Record<string, unknown>;
  for (const style of styles) {
    const keys = style.path.split(".");
    setNested(tree, [...keys, "$type"], "typography");
    for (const [field, token] of Object.entries(style.fields)) {
      const existing = getNested(tree, [...keys, field]) as TokenValue | undefined;
      if (shouldTypographyFieldWin(existing, token)) {
        setNested(tree, [...keys, field], token);
      }
    }
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
    return formatFigmaColor(c.r, c.g, c.b, c.a ?? 1);
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

export function inferType(name: string, resolvedType: string): string {
  if (resolvedType === "COLOR") return "color";
  if (resolvedType === "BOOLEAN") return "boolean";
  if (resolvedType === "STRING") {
    // Check "weight" first — "fontWeight/light" also matches /family|font/i,
    // since it contains "font", and would otherwise always be misclassified
    // as fontFamily. Named weights ("Light", "Bold") are STRING-typed in
    // real usage, not FLOAT — see the fontWeight/fontStyle decision above.
    if (/weight/i.test(name)) return "fontWeight";
    if (/family|font/i.test(name)) return "fontFamily";
    return "string";
  }
  if (resolvedType === "FLOAT") {
    if (/dimension|size|spacing|padding|radius|width|height|border|gap/i.test(name)) return "dimension";
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

export type CollectionKind = "primitives" | "global" | "themes" | "semantic" | "sizes" | "unknown";

/**
 * A collection mapped to "sizes" feeds a second, orthogonal axis on
 * Primitives — one mode per size (mobile/desktop, …), merged with the shared
 * primitives at resolve time. See docs/design/size-axis.md and the Metadata
 * `sizes`/`sizeBreakpoints` fields.
 */
export function collectionKind(name: string, names: CollectionNames): CollectionKind {
  if (names.primitives.includes(name)) return "primitives";
  if (names.global.includes(name)) return "global";
  if (names.themes.includes(name)) return "themes";
  if (names.semantic.includes(name)) return "semantic";
  if (names.sizes.includes(name)) return "sizes";
  return "unknown";
}

/**
 * Records which real Figma collection each top-level path segment came from,
 * per role — see CollectionSources' own doc comment (token-merger.ts) for why
 * this exists. Meant to be called when "Map collections" is saved (it has the
 * live collections/variables at hand there), not on every push — the whole
 * point is a stable record of "where segment X currently lives", which a
 * push has no reason to recompute every time.
 */
export function buildCollectionSources(
  variables: FigmaVariable[],
  names: CollectionNames,
): CollectionSources {
  const sources: CollectionSources = {};

  for (const variable of variables) {
    const kind = collectionKind(variable.collectionName, names);
    if (kind === "unknown") continue;

    const bucket = (sources[kind] ??= {});
    bucket[firstSegment(variable.name)] = variable.collectionName;
  }

  return sources;
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

/**
 * Sets `value` at `keys` within `obj` — but refuses to silently corrupt the
 * tree when two real Figma variable names collide structurally, e.g.
 * "Light/surface/brand" *and* "Light/surface/brand/default" both existing
 * at once (Figma allows this; a nested JSON tree cannot represent both a
 * leaf and a group at the same path). Confirmed live (Vy's Spor system):
 * depending purely on which variable Figma happened to return last, this
 * either silently destroyed an entire group's data (the flat one, written
 * last, overwrote the group with nothing left behind) or produced an
 * invalid hybrid object that's both a leaf and a group at once (the flat
 * one written first, then children got merged directly onto it) — neither
 * outcome was ever visible anywhere.
 *
 * Whichever shape is established *first* wins; the later, conflicting
 * write is skipped entirely rather than corrupting or replacing it. Returns
 * false when a write was skipped this way, so the caller can collect and
 * report the conflicting path instead of it disappearing silently.
 */
function setNested(obj: Record<string, unknown>, keys: string[], value: unknown): boolean {
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const existing = current[keys[i]];
    if (existing !== undefined && isTokenValue(existing)) {
      return false; // a shorter path already claimed this position as a complete leaf
    }
    if (typeof existing !== "object" || existing === null) {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  const finalKey = keys[keys.length - 1];
  const existingFinal = current[finalKey];
  if (existingFinal !== undefined && typeof existingFinal === "object" && existingFinal !== null && !isTokenValue(existingFinal)) {
    return false; // a longer path already established this position as a group
  }
  current[finalKey] = value;
  return true;
}

function getNested(obj: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
