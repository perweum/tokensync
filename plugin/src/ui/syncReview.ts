/**
 * The decision half of Pull and Push: given what GitHub and Figma each hold,
 * work out what the user should be shown — extracted from Sync.tsx's
 * `handle*CollectionsLoaded`, which did this inline and interleaved with a
 * dozen setState calls, so none of it could be tested.
 *
 * Pure: every function here takes data and returns a result. Sync.tsx only
 * copies the result into React state and refs.
 *
 * The outcome rule both directions share is the one that has bitten this
 * project before: "no token changes" is NOT the same as "nothing to show". A
 * mode renamed in Figma since Map Collections was saved makes a whole
 * collection invisible to the diff (nothing on the other side to compare
 * against), which looks identical to genuinely being up to date — so a stale
 * configured mode forces the review screen open, where its warning renders.
 */

import type { FigmaVariable, FigmaVariableCollection } from "../shared/messages";
import type { CollectionDiff } from "../shared/token-diff";
import type { ParsedRepository, ResolvedCollection } from "../shared/token-merger";
import { parseRepository } from "../shared/token-merger";
import { figmaToCollections, figmaToTokenFiles } from "../shared/figma-to-tokens";
import {
  computePullDiff,
  computePushDiff,
  findMissingOutputFiles,
  findStaleConfiguredModes,
  mergeTypographyIntoFigmaMaps,
} from "../shared/sync-logic";
import type { StaleConfiguredMode } from "../shared/sync-logic";
import type { GitHubFile } from "../shared/messages";
import type { TypographyStyle } from "../shared/typography-styles";
import { buildFigmaFlatMaps } from "./hooks/useFigmaValues";

const totalChanges = (diffs: CollectionDiff[]) => diffs.reduce((n, d) => n + d.counts.total, 0);
const withChanges = (diffs: CollectionDiff[]) => diffs.filter((d) => d.counts.total > 0);

// ---------------------------------------------------------------------------
// Pull (GitHub → Figma)
// ---------------------------------------------------------------------------

export interface PullReview {
  /** "up-to-date": nothing to apply and nothing to warn about. "review": open the diff view. */
  outcome: "up-to-date" | "review";
  /** Only diffs that contain changes — what the diff view lists. */
  diffs: CollectionDiff[];
  /** GitHub collections with ignored ones removed — what Clean Apply rebuilds from. */
  filteredGithubCollections: ResolvedCollection[];
  staleModes: StaleConfiguredMode[];
}

export function reviewPull(
  github: ParsedRepository,
  figmaCollections: FigmaVariableCollection[],
  figmaVariables: FigmaVariable[],
  figmaTypographyStyles: TypographyStyle[],
): PullReview {
  const figmaMaps = mergeTypographyIntoFigmaMaps(
    buildFigmaFlatMaps(figmaCollections, figmaVariables),
    figmaTypographyStyles,
    github.metadata,
  );
  const { diffs, filteredGithubCollections } = computePullDiff(
    github.collections,
    github.metadata,
    figmaMaps,
  );
  const staleModes = findStaleConfiguredModes(github.metadata, figmaCollections);

  return {
    outcome: totalChanges(diffs) === 0 && staleModes.length === 0 ? "up-to-date" : "review",
    diffs: withChanges(diffs),
    filteredGithubCollections,
    staleModes,
  };
}

// ---------------------------------------------------------------------------
// Push (Figma → GitHub)
// ---------------------------------------------------------------------------

export interface PushReview {
  /** "up-to-date": nothing to push and nothing to warn about. "review": open the push view. */
  outcome: "up-to-date" | "review";
  /** GitHub's current state, parsed — kept for writing files on Create PR. */
  githubParsed: ParsedRepository;
  /** Figma's state in the same resolved shape (recognised layers only). */
  figmaCollectionData: ResolvedCollection[];
  /** Only diffs that contain changes. Empty for an output-only / warning-only review. */
  diffs: CollectionDiff[];
  /** Enabled platforms' output files that don't exist in the repo yet. Only ever
   * non-empty when there are zero token changes — a change to `metadata.platforms`
   * is a change with nothing to do with any token's value. */
  outputOnlyFiles: string[];
  unknownCollectionNames: string[];
  brokenAliasPaths: string[];
  /** Real Figma variable names that structurally collide (a leaf and a group at one path). */
  conflictPaths: string[];
  staleModes: StaleConfiguredMode[];
}

export function reviewPush(input: {
  githubFiles: GitHubFile[];
  tokensPath: string;
  figmaCollections: FigmaVariableCollection[];
  figmaVariables: FigmaVariable[];
  figmaTypographyStyles: TypographyStyle[];
  /** Every real blob path in the repo — to tell whether an output file already exists. */
  repoPaths: Set<string>;
}): PushReview {
  const { githubFiles, tokensPath, figmaCollections, figmaVariables, figmaTypographyStyles } =
    input;

  const githubParsed = parseRepository(githubFiles, tokensPath);

  const {
    collections: figmaCollectionData,
    unknownCollectionNames,
    brokenAliasPaths,
  } = figmaToCollections(
    figmaCollections,
    figmaVariables,
    githubParsed.metadata,
    figmaTypographyStyles,
  );

  // Checked against the *full*, unfiltered Figma data — a structural naming
  // collision can't be seen by figmaToCollections' flat map (string keys don't
  // nest), only by the tree builder figmaToTokenFiles actually writes files
  // with. Surfacing it as soon as the diff loads means the user doesn't have to
  // select collections and click Create PR just to learn about a Figma-side
  // naming problem the PR step would refuse anyway.
  const { conflictPaths } = figmaToTokenFiles(
    figmaCollections,
    figmaVariables,
    tokensPath,
    githubParsed.metadata.figma.collections,
    figmaTypographyStyles,
  );

  const staleModes = findStaleConfiguredModes(githubParsed.metadata, figmaCollections);

  // Diff: Figma (new) vs GitHub (current) — githubValue = current state in
  // GitHub, figmaValue = new state from Figma.
  const result = computePushDiff(
    figmaCollectionData,
    githubParsed.collections,
    githubParsed.metadata,
  );

  const shared = {
    githubParsed,
    figmaCollectionData,
    unknownCollectionNames,
    brokenAliasPaths,
    conflictPaths,
    staleModes,
  };

  if (totalChanges(result) > 0) {
    return { ...shared, outcome: "review", diffs: withChanges(result), outputOnlyFiles: [] };
  }

  // No token changes — but an enabled platform might have never had its file
  // generated (a config change, not a token change), and a stale configured
  // mode can hide a whole collection. Either way the user needs the screen.
  const missing = findMissingOutputFiles(
    figmaCollectionData,
    githubParsed.metadata,
    tokensPath,
    input.repoPaths,
  );
  if (missing.length > 0 || staleModes.length > 0) {
    return { ...shared, outcome: "review", diffs: [], outputOnlyFiles: missing.map((f) => f.path) };
  }
  return { ...shared, outcome: "up-to-date", diffs: [], outputOnlyFiles: [] };
}

/** " (skipped unrecognized collection(s): X, Y — check metadata.json figma.collections)" or "". */
export function skippedCollectionsSuffix(unknownCollectionNames: string[]): string {
  if (unknownCollectionNames.length === 0) return "";
  const s = unknownCollectionNames.length > 1 ? "s" : "";
  return ` (skipped unrecognized collection${s}: ${unknownCollectionNames.join(", ")} — check metadata.json figma.collections)`;
}
