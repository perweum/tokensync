/**
 * Pure sync-flow logic extracted from Sync.tsx — matching collections between
 * GitHub and Figma, filtering ignored ones, and building the files a push PR
 * writes. Kept separate specifically so it's directly testable without
 * mounting the React component or mocking `figma.*`/`fetch` — Sync.tsx itself
 * has never had test coverage; this is the part of it actually worth locking
 * down, since it's where several real bugs have lived this project (the
 * mode-name case-sensitivity fix, the ignored-collection role lookup).
 */

import type { Metadata, ResolvedCollection, CollectionNames, CollectionSources } from "./token-merger";
import type { FigmaVariableCollection, FigmaVariable, TokenValue } from "./messages";
import { buildCollectionDiff } from "./token-diff";
import type { CollectionDiff } from "./token-diff";
import { figmaToTokenFiles, collectionKind, flattenTypographyStyles } from "./figma-to-tokens";
import type { CollectionKind } from "./figma-to-tokens";
import { runTransformers } from "./transformer";
import type { TransformedFile } from "./transformer";
import type { TypographyStyle } from "./typography-styles";

/** A flat resolved value map for one collection/mode from Figma — same shape
 * the UI's useFigmaValues.ts (`buildFigmaFlatMaps`) produces. Duplicated as a
 * minimal local type rather than importing a UI-layer hook module into
 * shared/. */
export interface FigmaFlatMap {
  collectionName: string;
  modeName: string;
  /** dot-notation path → fully resolved string value */
  values: Record<string, string>;
  /** dot-notation path → one-hop value: the literal, or "{target.dot.path}" for an alias */
  rawValues: Record<string, string>;
}

/**
 * True when a collection is listed in metadata.ignoredCollections.
 * Entries are layer keys ("primitives", "global", "themes", "semantic",
 * "sizes"), matched against the configured Figma collection names.
 */
export function isIgnoredCollection(collectionName: string, metadata: Metadata): boolean {
  const names = metadata.figma.collections;
  const key = (Object.keys(names) as Array<keyof typeof names>).find((k) =>
    names[k].includes(collectionName),
  );
  return key !== undefined && (metadata.ignoredCollections ?? []).includes(key);
}

/**
 * Whether `role`'s own Figma mode name carries no real information and must
 * never be required to match exactly — the single, shared definition of
 * "mode-agnostic" both push (`computePushDiff`) and pull (`figmaValuesFor`
 * below) match against, so the two directions can't silently define "the
 * same collection" differently again.
 *
 * Global is *always* mode-agnostic — Figma only ever gives it one mode, an
 * arbitrary default ("Mode 1", say) nothing in the repo records or could
 * reconstruct. A *raw, physical* Primitives collection is mode-agnostic the
 * same way — colour/geometry primitives that don't vary by size always live
 * in one real Figma mode, never split across several, even on a project
 * that also has a genuine Size axis (that axis lives in a *separate*
 * physical "sizes"-role collection instead — see the composite-merge
 * comment on `figmaValuesFor`). `hasGenuineModes` exists only for the
 * *composite* Primitives entries `figmaToCollections`/`parseRepository`
 * build when a Size axis exists — one per real size mode, each with a real,
 * distinct, comparison-worthy name — which computePushDiff must tell apart
 * by mode; pass `false` (or omit) anywhere that ambiguity can't arise.
 *
 * Found live (`single-theme-stresstest`, a genuinely single-mode system):
 * `figmaValuesFor` already treated Primitives/Global this way from an
 * earlier fix; `computePushDiff` was never updated to match, and compared
 * Figma's real (if meaningless) mode name against GitHub's fixed placeholder
 * ("Value" — `parseRepository` has no way to reconstruct what a plain
 * `color.json` file's original Figma mode was actually called) — never
 * equal, so every token in a single-mode role's collection permanently
 * showed as newly "added" on every push, even when nothing had changed.
 */
export function isModeAgnosticRole(role: CollectionKind, hasGenuineModes = false): boolean {
  if (role === "global") return true;
  if (role === "primitives") return !hasGenuineModes;
  return false;
}

/**
 * Every real Figma flat value map that belongs to the same merged GitHub
 * entry as `githubCol` — i.e. the Figma-side counterpart of how
 * figmaToCollections already merges multiple physical collections sharing a
 * role. Primitives/global collapse every contributing collection into one
 * flat map regardless of mode (see isModeAgnosticRole); themes/semantic
 * match by mode name case-insensitively, same as `isModeSelected`.
 *
 * Matching a single FigmaFlatMap by exact real collection name (the previous
 * approach) meant a role backed by more than one physical collection could
 * only ever match one of them — every token belonging to the others showed
 * as permanently "added" on every pull, no matter how many times the repo
 * was pushed and re-pulled, since the lookup could never find where they
 * actually lived in Figma. Found live: colors from a "primitives" collection
 * never matched a merged "primitives" role entry named after "size".
 *
 * `role` is always resolved from `githubCol.collectionName`, which for a
 * Size-mode entry is always `names.primitives[0]` — never `names.sizes[0]`
 * (see `isModeSelected`'s doc comment for why). So a `"primitives"` role here
 * can genuinely be the primitives+sizes composite `figmaToCollections`
 * builds: merge in every real `sizes`-role map whose own mode also matches
 * `githubCol.modeName`, alongside the unconditional primitives merge (a raw
 * "primitives"-kind map is always mode-agnostic in its own right — see
 * isModeAgnosticRole — so it's included regardless of githubCol's own mode).
 */
function figmaValuesFor(
  githubCol: ResolvedCollection,
  names: CollectionNames,
  figmaMaps: FigmaFlatMap[],
): { values: Record<string, string>; rawValues: Record<string, string> } {
  const role = collectionKind(githubCol.collectionName, names);
  const matching = figmaMaps.filter((m) => {
    const mKind = collectionKind(m.collectionName, names);
    if (role === "primitives") {
      if (mKind === "primitives") return isModeAgnosticRole("primitives");
      if (mKind === "sizes") return m.modeName.toLowerCase() === githubCol.modeName.toLowerCase();
      return false;
    }
    if (mKind !== role) return false;
    if (isModeAgnosticRole(role)) return true;
    return m.modeName.toLowerCase() === githubCol.modeName.toLowerCase();
  });
  return {
    values: Object.assign({}, ...matching.map((m) => m.values)),
    rawValues: Object.assign({}, ...matching.map((m) => m.rawValues)),
  };
}

/**
 * Merges Figma's live Text Style fields into a new Global-role FigmaFlatMap
 * entry for pull comparison — the pull-side mirror of figmaToCollections'
 * identical merge on the push side (flattenTypographyStyles into globalRaw).
 * Needed because buildFigmaFlatMaps (useFigmaValues.ts) only ever reads
 * Variables — a Text Style field, bound or not, was completely invisible to
 * computePullDiff, so every already-pushed typography token showed as
 * permanently "added" on every single pull, never "unchanged."
 *
 * A bound field's raw value is a {ref} into a real Variable's dot-path (see
 * getLocalTypographyStyles) — resolved here with one direct lookup against
 * the other FigmaFlatMaps' already-resolved values, no chain-walking needed
 * since buildFigmaFlatMaps already walked each Variable's own alias chain to
 * a final value. That lookup must pick exactly one mode for "sizes"- and
 * "themes"-role maps (mirroring figmaToCollections' own defaultSizeModeRaw/
 * defaultThemeRaw) rather than union every mode's map together — a
 * size-varying or theme-scoped path exists once per mode with a genuinely
 * different value each time, so a blind union lets whichever mode's map
 * happens to be processed last silently win, with no error or indication
 * anything was wrong (found live: desktop's font-size scale won over
 * mobile's, purely from FigmaFlatMap array order).
 */
export function mergeTypographyIntoFigmaMaps(
  figmaMaps: FigmaFlatMap[],
  typographyStyles: TypographyStyle[],
  metadata: Metadata,
): FigmaFlatMap[] {
  if (typographyStyles.length === 0) return figmaMaps;

  const names = metadata.figma.collections;
  const allResolved: Record<string, string> = {};

  // primitives/global/semantic: single-mode or shared-regardless-of-mode —
  // safe to union directly, same assumption figmaValuesFor already makes.
  for (const map of figmaMaps) {
    const kind = collectionKind(map.collectionName, names);
    if (kind === "primitives" || kind === "global" || kind === "semantic") {
      Object.assign(allResolved, map.values);
    }
  }

  // sizes/themes: genuinely multi-mode with different values per mode — only
  // the configured default mode's map may be merged in.
  for (const kind of ["sizes", "themes"] as const) {
    const configOrder = kind === "sizes" ? metadata.sizes : metadata.themes;
    const modeMaps = figmaMaps.filter((m) => collectionKind(m.collectionName, names) === kind);
    const defaultMap =
      configOrder
        .map((name) => modeMaps.find((m) => m.modeName.toLowerCase() === name.toLowerCase()))
        .find((m): m is FigmaFlatMap => m !== undefined) ?? modeMaps[0];
    if (defaultMap) Object.assign(allResolved, defaultMap.values);
  }

  const typographyValues: Record<string, string> = {};
  const typographyRawValues: Record<string, string> = {};
  for (const [path, token] of Object.entries(flattenTypographyStyles(typographyStyles))) {
    const match = /^\{(.+)\}$/.exec(token.$value);
    typographyValues[path] = match ? (allResolved[match[1]] ?? token.$value) : token.$value;
    // Already one-hop as-is — getLocalTypographyStyles produces exactly this
    // shape (a literal, or a "{ref}" into the bound variable's dot-path).
    typographyRawValues[path] = token.$value;
  }

  return [
    ...figmaMaps,
    {
      collectionName: names.global[0] ?? "Global",
      modeName: "Value",
      values: typographyValues,
      rawValues: typographyRawValues,
    },
  ];
}

/**
 * Pull direction: GitHub (current) vs Figma (proposed target) — what would
 * change in Figma if applied. Mode names are matched case-insensitively:
 * parseRepository always capitalise()s a GitHub-side mode name, but the real
 * Figma mode it was written from might be any casing at all.
 */
export function computePullDiff(
  githubCollections: ResolvedCollection[],
  metadata: Metadata,
  figmaMaps: FigmaFlatMap[],
): { diffs: CollectionDiff[]; filteredGithubCollections: ResolvedCollection[] } {
  const names = metadata.figma.collections;
  const filteredGithubCollections = githubCollections.filter(
    (c) => !isIgnoredCollection(c.collectionName, metadata),
  );

  const diffs = filteredGithubCollections.map((githubCol) => {
    const { values, rawValues } = figmaValuesFor(githubCol, names, figmaMaps);
    return buildCollectionDiff(
      githubCol.collectionName,
      githubCol.modeName,
      githubCol.tokens,
      values,
      githubCol.rawTokens,
      rawValues,
    );
  });

  return { diffs, filteredGithubCollections };
}

/**
 * Push direction: Figma (proposed) vs GitHub (current) — what would change in
 * GitHub if pushed. Swapped relative to pull: figmaCol's tokens are the
 * proposed new state, githubCol's are the current one being compared against.
 */
export function computePushDiff(
  figmaCollections: ResolvedCollection[],
  githubCollections: ResolvedCollection[],
  metadata: Metadata,
): CollectionDiff[] {
  const names = metadata.figma.collections;
  const filteredFigmaCollections = figmaCollections.filter(
    (c) => !isIgnoredCollection(c.collectionName, metadata),
  );

  return filteredFigmaCollections.map((figmaCol) => {
    const role = collectionKind(figmaCol.collectionName, names);
    // Every figmaCol sharing this collectionName — >1 means a genuine Size
    // axis (one composite entry per real size mode), which isModeAgnosticRole
    // needs to know before it can tell whether Primitives' mode name here is
    // real or an arbitrary Figma default. See isModeAgnosticRole's own
    // comment for why this exists and the live symptom it fixed.
    const hasGenuineModes =
      figmaCollections.filter((c) => c.collectionName === figmaCol.collectionName).length > 1;
    const modeAgnostic = isModeAgnosticRole(role, hasGenuineModes);
    const githubCol = githubCollections.find(
      (c) =>
        c.collectionName === figmaCol.collectionName &&
        (modeAgnostic || c.modeName.toLowerCase() === figmaCol.modeName.toLowerCase()),
    );
    return buildCollectionDiff(
      figmaCol.collectionName,
      figmaCol.modeName,
      figmaCol.tokens,
      Object.fromEntries(Object.entries(githubCol?.tokens ?? {}).map(([k, v]) => [k, v.$value])),
      figmaCol.rawTokens,
      Object.fromEntries(Object.entries(githubCol?.rawTokens ?? {}).map(([k, v]) => [k, v.$value])),
    );
  });
}

/**
 * Builds the token JSON + platform output files for a push PR.
 * `selectedKeys` is the set of "collectionName/modeName" pairs the user chose
 * to include in the diff view — every other mode in `figmaRaw` is dropped
 * before writing. Writes ALL variables for a selected mode (not just the
 * changed ones) so GitHub files stay complete. Platform transformers
 * (CSS/JS/TS/Dart/Swift) always run against the *full* collection set
 * regardless of selection — they represent the whole design system, not a
 * partial sync.
 */
export interface BuildFilesFromDiffsResult {
  files: Array<{ path: string; content: string }>;
  /** Dot-paths skipped because two real Figma variable names structurally
   * collide (see figma-to-tokens.ts's setNested) — e.g. "surface/brand" and
   * "surface/brand/default" both existing. A caller should treat this as a
   * reason not to proceed with the write, not just a warning: the collision
   * means the written files are missing real data by construction. */
  conflictPaths: string[];
}

export function buildFilesFromDiffs(
  selectedKeys: Set<string>,
  figmaRaw: {
    collections: FigmaVariableCollection[];
    variables: FigmaVariable[];
    typographyStyles?: TypographyStyle[];
  },
  metadata: Metadata,
  tokensPath: string,
  allFigmaCollections: ResolvedCollection[] | null,
): BuildFilesFromDiffsResult {
  const names = metadata.figma.collections;
  const selectedList = Array.from(selectedKeys);
  const filteredCollections = figmaRaw.collections
    .map((col) => ({ ...col, modes: col.modes.filter((mode) => isModeSelected(col, mode, names, selectedList)) }))
    .filter((col) => col.modes.length > 0);

  const { files: tokenFileList, conflictPaths } = figmaToTokenFiles(
    filteredCollections,
    figmaRaw.variables,
    tokensPath,
    metadata.figma.collections,
    figmaRaw.typographyStyles ?? [],
  );
  const tokenFiles = tokenFileList.map((f) => ({ path: f.repoPath, content: f.content }));

  if (allFigmaCollections) {
    const platformFiles = runTransformers(allFigmaCollections, metadata, tokensPath);
    return { files: [...tokenFiles, ...platformFiles], conflictPaths };
  }

  return { files: tokenFiles, conflictPaths };
}

/**
 * Paths runTransformers would write that don't exist in the repo yet —
 * found live: enabling a new platform (e.g. Dart, previously off) has
 * nothing to do with any token's value, so a push with zero token changes
 * silently reported "already up to date" and never generated its output
 * file at all. `existingPaths` is every real blob path currently in the
 * repo (see useGitHub.ts's fetchRepoPaths) — not just the token JSON
 * fetchTokenFiles reads, since a platform's output normally lives outside
 * tokensPath entirely (dist/, lib/, ios/, …).
 */
export function findMissingOutputFiles(
  figmaCollections: ResolvedCollection[],
  metadata: Metadata,
  tokensPath: string,
  existingPaths: ReadonlySet<string>,
): TransformedFile[] {
  return runTransformers(figmaCollections, metadata, tokensPath).filter(
    (f) => !existingPaths.has(f.path),
  );
}

/** Fallback name for a role with nothing mapped to it (`names.role === []`) —
 * matches the same fallback figmaToCollections/parseRepository use when
 * building the synthetic collection itself, so a key built from either side
 * always agrees on what to call an unmapped role. */
const ROLE_DEFAULT_NAME: Record<Exclude<CollectionKind, "unknown">, string> = {
  primitives: "Primitives",
  global: "Global",
  themes: "Themes",
  semantic: "Semantic",
  sizes: "Sizes",
};

/**
 * Whether a real (collection, mode) pair belongs to a selected diff entry.
 *
 * `selectedKeys` holds *synthetic* "collectionName/modeName" pairs — the ones
 * figmaToCollections actually produced for diffing, named after
 * metadata.figma.collections[role][0]. When a role is backed by more than one
 * physical Figma collection (a supported, documented case — see "Multiple
 * Figma Collections Per Role"), a real collection's own name/mode often
 * doesn't match that synthetic key directly, even though its tokens were
 * merged into the diff the user reviewed and checked. Matching selectedKeys
 * against `col.name` directly (the previous approach) silently dropped every
 * contributing collection except whichever one happened to share its name
 * with metadata.figma.collections[role][0] — found live via a real project
 * where "primitives" role was backed by both "size" and "primitives"
 * collections; only "size"'s tokens ever reached the pushed files.
 *
 * Primitives and Global merge every physical collection into one indivisible
 * synthetic entry regardless of mode name (see figmaToCollections) — the diff
 * never offers a way to select part of that, so the whole role is in or out
 * together. Themes/Semantic instead produce one entry per real mode name,
 * merged case-insensitively (mergeIntoMode) — matched the same way here.
 *
 * Sizes is a special case of the primitives branch, not its own: a Size axis
 * on Primitives makes figmaToCollections build one *composite* entry per size
 * mode — shared primitives (colors, etc.) merged with that mode's own data —
 * always labeled `names.primitives[0]`, never `names.sizes[0]` (sizes is a
 * second axis ON primitives, not an independently displayed role — see the
 * Size axis decision in DECISIONS.md). So a real `sizes`-role collection is
 * "selected" exactly when the matching `Primitives/<thisMode>` key was
 * checked — matching on `names.sizes[0]` (the previous approach) checked for
 * a key that never exists in `selectedList`, silently excluding every sizes
 * collection from push no matter what was checked in the UI.
 */
function isModeSelected(
  col: FigmaVariableCollection,
  mode: { modeId: string; name: string },
  names: CollectionNames,
  selectedList: string[],
): boolean {
  const kind = collectionKind(col.name, names);
  if (kind === "unknown") return false; // never included, same as before

  if (kind === "primitives" || kind === "global") {
    const syntheticName = names[kind][0] ?? ROLE_DEFAULT_NAME[kind];
    return selectedList.some((key) => key.startsWith(`${syntheticName}/`));
  }

  if (kind === "sizes") {
    const primitivesName = names.primitives[0] ?? ROLE_DEFAULT_NAME.primitives;
    return selectedList.some((key) => {
      const slash = key.indexOf("/");
      return key.slice(0, slash) === primitivesName && key.slice(slash + 1).toLowerCase() === mode.name.toLowerCase();
    });
  }

  const syntheticName = names[kind][0] ?? ROLE_DEFAULT_NAME[kind];
  return selectedList.some((key) => {
    const slash = key.indexOf("/");
    return key.slice(0, slash) === syntheticName && key.slice(slash + 1).toLowerCase() === mode.name.toLowerCase();
  });
}

// ---------------------------------------------------------------------------
// Apply (pull direction) — routing tokens back to the real Figma collection
// they came from, for a role backed by more than one physical collection.
// ---------------------------------------------------------------------------

/** What one `APPLY_TOKENS` message needs — `cleanApply` is added by the
 * caller, since it depends on cross-payload state (has this real collection
 * already been wiped by an earlier payload?) that these pure builders don't
 * track themselves. */
export interface ApplyPayload {
  collectionId: string;
  modeId: string;
  tokens: Record<string, TokenValue>;
  resolvedValues?: Record<string, string>;
  removedPaths?: string[];
}

/**
 * Which real Figma collection a token path should apply to: the one
 * CollectionSources recorded for its top-level segment, or `fallbackName`
 * (today's behavior — collections[role][0]) when nothing was ever recorded,
 * e.g. before "Map collections" has been saved since this feature shipped.
 *
 * `role === "primitives"` checks `sources.sizes` too, not just
 * `sources.primitives`: a segment that only ever lived in a real `sizes`-role
 * collection (e.g. `primitive.dimension.*` in a Size-axis setup) is recorded
 * under `sources.sizes`, since `buildCollectionSources` derives each
 * variable's role from its own real collection — but the *diff entry* asking
 * to route it is always labeled `"primitives"` (see `isModeSelected`'s doc
 * comment for why). Checking only `sources.primitives` would silently miss
 * it and fall back to routing it at the shared primitives collection instead
 * of the real sizes collection it belongs to.
 */
function resolveTarget(
  path: string,
  role: CollectionKind,
  sources: CollectionSources,
  fallbackName: string,
): string {
  const segment = path.split(".")[0];
  if (role === "primitives") {
    return sources.primitives?.[segment] ?? sources.sizes?.[segment] ?? fallbackName;
  }
  return (role === "unknown" ? undefined : sources[role]?.[segment]) ?? fallbackName;
}

function bucket<T>(map: Map<string, T>, key: string, make: () => T): T {
  let value = map.get(key);
  if (!value) {
    value = make();
    map.set(key, value);
  }
  return value;
}

/**
 * Builds one `APPLY_TOKENS` payload per real Figma collection a diff's
 * changed/removed entries actually belong to — a faithful extraction of what
 * used to be Sync.tsx's `sendApplyDiff`, generalized to fan out instead of
 * always targeting `diff.collectionName`. With no CollectionSources recorded
 * for this role, every entry resolves to `diff.collectionName` and this
 * returns exactly one payload, identical to the old single-message behavior.
 */
export function buildApplyPayloads(
  diff: CollectionDiff,
  names: CollectionNames,
  sources: CollectionSources,
): ApplyPayload[] {
  const role = collectionKind(diff.collectionName, names);

  const groups = new Map<
    string,
    { tokens: Record<string, TokenValue>; resolvedValues: Record<string, string>; removedPaths: string[] }
  >();

  for (const entry of diff.entries) {
    if (entry.status === "unchanged") continue;
    const target = resolveTarget(entry.path, role, sources, diff.collectionName);
    const group = bucket(groups, target, () => ({
      tokens: {} as Record<string, TokenValue>,
      resolvedValues: {} as Record<string, string>,
      removedPaths: [] as string[],
    }));

    if (entry.status === "removed") {
      group.removedPaths.push(entry.path);
      continue;
    }
    const value = entry.githubRawValue ?? entry.githubValue;
    if (!value) continue;
    group.tokens[entry.path] = { $type: entry.type, $value: value };
    if (entry.githubValue && entry.githubRawValue && entry.githubRawValue !== entry.githubValue) {
      group.resolvedValues[entry.path] = entry.githubValue;
    }
  }

  return Array.from(groups.entries()).map(([collectionId, group]) => ({
    collectionId,
    modeId: diff.modeName,
    tokens: group.tokens,
    resolvedValues: Object.keys(group.resolvedValues).length > 0 ? group.resolvedValues : undefined,
    removedPaths: group.removedPaths.length > 0 ? group.removedPaths : undefined,
  }));
}

/**
 * Same routing as buildApplyPayloads, for Clean Apply — which sends every
 * token in the collection (not just the changed ones) and has no concept of
 * "removed" entries of its own (deletion there is handled by `cleanApply`
 * wiping the target collection first, applied by the caller per real target).
 */
export function buildCleanApplyPayloads(
  col: ResolvedCollection,
  names: CollectionNames,
  sources: CollectionSources,
): ApplyPayload[] {
  const role = collectionKind(col.collectionName, names);

  const groups = new Map<string, { tokens: Record<string, TokenValue>; resolvedValues: Record<string, string> }>();

  for (const [path, token] of Object.entries(col.rawTokens)) {
    const target = resolveTarget(path, role, sources, col.collectionName);
    const group = bucket(groups, target, () => ({
      tokens: {} as Record<string, TokenValue>,
      resolvedValues: {} as Record<string, string>,
    }));
    group.tokens[path] = token;
    const resolved = col.tokens[path];
    if (resolved && token.$value !== resolved.$value) {
      group.resolvedValues[path] = resolved.$value;
    }
  }

  return Array.from(groups.entries()).map(([collectionId, group]) => ({
    collectionId,
    modeId: col.modeName,
    tokens: group.tokens,
    resolvedValues: Object.keys(group.resolvedValues).length > 0 ? group.resolvedValues : undefined,
  }));
}
