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
import { figmaToTokenFiles, collectionKind } from "./figma-to-tokens";
import type { CollectionKind } from "./figma-to-tokens";
import { runTransformers } from "./transformer";
import type { TypographyStyle } from "./typography-styles";

/** A flat resolved value map for one collection/mode from Figma — same shape
 * the UI's useFigmaValues.ts (`buildFigmaFlatMaps`) produces. Duplicated as a
 * minimal local type rather than importing a UI-layer hook module into
 * shared/. */
export interface FigmaFlatMap {
  collectionName: string;
  modeName: string;
  values: Record<string, string>;
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
  const filteredGithubCollections = githubCollections.filter(
    (c) => !isIgnoredCollection(c.collectionName, metadata),
  );

  const diffs = filteredGithubCollections.map((githubCol) => {
    const figmaMap = figmaMaps.find(
      (m) =>
        m.collectionName === githubCol.collectionName &&
        m.modeName.toLowerCase() === githubCol.modeName.toLowerCase(),
    );
    return buildCollectionDiff(
      githubCol.collectionName,
      githubCol.modeName,
      githubCol.tokens,
      figmaMap?.values ?? {},
      githubCol.rawTokens,
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
  const filteredFigmaCollections = figmaCollections.filter(
    (c) => !isIgnoredCollection(c.collectionName, metadata),
  );

  return filteredFigmaCollections.map((figmaCol) => {
    const githubCol = githubCollections.find(
      (c) =>
        c.collectionName === figmaCol.collectionName &&
        c.modeName.toLowerCase() === figmaCol.modeName.toLowerCase(),
    );
    return buildCollectionDiff(
      figmaCol.collectionName,
      figmaCol.modeName,
      figmaCol.tokens,
      Object.fromEntries(Object.entries(githubCol?.tokens ?? {}).map(([k, v]) => [k, v.$value])),
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
): Array<{ path: string; content: string }> {
  const names = metadata.figma.collections;
  const selectedList = Array.from(selectedKeys);
  const filteredCollections = figmaRaw.collections
    .map((col) => ({ ...col, modes: col.modes.filter((mode) => isModeSelected(col, mode, names, selectedList)) }))
    .filter((col) => col.modes.length > 0);

  const tokenFiles = figmaToTokenFiles(
    filteredCollections,
    figmaRaw.variables,
    tokensPath,
    metadata.figma.collections,
    figmaRaw.typographyStyles ?? [],
  ).map((f) => ({ path: f.repoPath, content: f.content }));

  if (allFigmaCollections) {
    const platformFiles = runTransformers(allFigmaCollections, metadata, tokensPath);
    return [...tokenFiles, ...platformFiles];
  }

  return tokenFiles;
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
 * together. Themes/Semantic/Sizes instead produce one entry per real mode
 * name, merged case-insensitively (mergeIntoMode) — matched the same way here.
 */
function isModeSelected(
  col: FigmaVariableCollection,
  mode: { modeId: string; name: string },
  names: CollectionNames,
  selectedList: string[],
): boolean {
  const kind = collectionKind(col.name, names);
  if (kind === "unknown") return false; // never included, same as before

  const syntheticName = names[kind][0] ?? ROLE_DEFAULT_NAME[kind];

  if (kind === "primitives" || kind === "global") {
    return selectedList.some((key) => key.startsWith(`${syntheticName}/`));
  }

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
 */
function resolveTarget(
  path: string,
  roleSources: Record<string, string> | undefined,
  fallbackName: string,
): string {
  return roleSources?.[path.split(".")[0]] ?? fallbackName;
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
  const roleSources = role === "unknown" ? undefined : sources[role];

  const groups = new Map<
    string,
    { tokens: Record<string, TokenValue>; resolvedValues: Record<string, string>; removedPaths: string[] }
  >();

  for (const entry of diff.entries) {
    if (entry.status === "unchanged") continue;
    const target = resolveTarget(entry.path, roleSources, diff.collectionName);
    const group = bucket(groups, target, () => ({ tokens: {}, resolvedValues: {}, removedPaths: [] }));

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
  const roleSources = role === "unknown" ? undefined : sources[role];

  const groups = new Map<string, { tokens: Record<string, TokenValue>; resolvedValues: Record<string, string> }>();

  for (const [path, token] of Object.entries(col.rawTokens)) {
    const target = resolveTarget(path, roleSources, col.collectionName);
    const group = bucket(groups, target, () => ({ tokens: {}, resolvedValues: {} }));
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
