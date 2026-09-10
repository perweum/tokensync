/**
 * Pure sync-flow logic extracted from Sync.tsx — matching collections between
 * GitHub and Figma, filtering ignored ones, and building the files a push PR
 * writes. Kept separate specifically so it's directly testable without
 * mounting the React component or mocking `figma.*`/`fetch` — Sync.tsx itself
 * has never had test coverage; this is the part of it actually worth locking
 * down, since it's where several real bugs have lived this project (the
 * mode-name case-sensitivity fix, the ignored-collection role lookup).
 */

import type { Metadata, ResolvedCollection } from "./token-merger";
import type { FigmaVariableCollection, FigmaVariable } from "./messages";
import { buildCollectionDiff } from "./token-diff";
import type { CollectionDiff } from "./token-diff";
import { figmaToTokenFiles, collectionKind } from "./figma-to-tokens";
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
  const filteredCollections = figmaRaw.collections
    .map((col) => ({ ...col, modes: col.modes.filter((mode) => isModeSelected(col, mode, metadata, selectedKeys)) }))
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
  metadata: Metadata,
  selectedKeys: Set<string>,
): boolean {
  const names = metadata.figma.collections;
  const kind = collectionKind(col.name, names);
  const selectedList = Array.from(selectedKeys);

  if (kind === "primitives" || kind === "global") {
    const syntheticName = kind === "primitives" ? (names.primitives[0] ?? "Primitives") : (names.global[0] ?? "Global");
    return selectedList.some((key) => key.startsWith(`${syntheticName}/`));
  }

  if (kind === "themes" || kind === "semantic" || kind === "sizes") {
    const syntheticName =
      kind === "themes"
        ? (names.themes[0] ?? "Themes")
        : kind === "semantic"
          ? (names.semantic[0] ?? "Semantic")
          : (names.sizes[0] ?? "Sizes");
    return selectedList.some((key) => {
      const slash = key.indexOf("/");
      return key.slice(0, slash) === syntheticName && key.slice(slash + 1).toLowerCase() === mode.name.toLowerCase();
    });
  }

  return false; // "unknown" collection — never included, same as before
}
