import { describe, it, expect } from "vitest";
import { reviewPull, reviewPush, skippedCollectionsSuffix } from "./syncReview";
import type { FigmaVariable, FigmaVariableCollection, GitHubFile } from "../shared/messages";
import { parseRepository } from "../shared/token-merger";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures: a one-token design system — Primitives with dimension/0 = 4px.
// ─────────────────────────────────────────────────────────────────────────

const file = (path: string, content: object): GitHubFile => ({
  path,
  content: JSON.stringify(content, null, 2),
  sha: "x",
});

const metadataJson = (extra: object = {}) => ({
  version: "1.0.0",
  themes: ["default"],
  colorSchemes: ["light", "dark"],
  figma: {
    fileKey: "",
    // Only Primitives is mapped — mapping a role Figma doesn't have would (correctly)
    // trigger the stale-mode warning in every test below, not just the ones about it.
    collections: { primitives: ["Primitives"], global: [], themes: [], semantic: [] },
  },
  ...extra,
});

const withThemesMapped = {
  figma: {
    fileKey: "",
    collections: { primitives: ["Primitives"], global: [], themes: ["Themes"], semantic: [] },
  },
};

const primitivesFile = file("tokens/primitives/dimension.json", {
  dimension: { "0": { $type: "dimension", $value: "4px" } },
});

const figmaCollections = (): FigmaVariableCollection[] => [
  { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1"] },
];
const figmaVariables = (value: number): FigmaVariable[] => [
  {
    id: "v1",
    name: "dimension/0",
    resolvedType: "FLOAT",
    valuesByMode: { m1: value },
    collectionId: "c1",
    collectionName: "Primitives",
  },
];

const push = (over: Partial<Parameters<typeof reviewPush>[0]> = {}) =>
  reviewPush({
    githubFiles: [file("tokens/metadata.json", metadataJson()), primitivesFile],
    tokensPath: "tokens",
    figmaCollections: figmaCollections(),
    figmaVariables: figmaVariables(4),
    figmaTypographyStyles: [],
    repoPaths: new Set(),
    ...over,
  });

// ─────────────────────────────────────────────────────────────────────────
// Push
// ─────────────────────────────────────────────────────────────────────────

describe("reviewPush", () => {
  it("is up to date when Figma and GitHub already agree", () => {
    const r = push();
    expect(r.outcome).toBe("up-to-date");
    expect(r.diffs).toEqual([]);
    expect(r.outputOnlyFiles).toEqual([]);
  });

  it("opens the review with the changed token when Figma differs", () => {
    const r = push({ figmaVariables: figmaVariables(8) });
    expect(r.outcome).toBe("review");
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0].counts).toMatchObject({ changed: 1, total: 1 });
    expect(r.outputOnlyFiles).toEqual([]);
  });

  it("opens an output-only review when a platform was enabled but its file was never generated", () => {
    // Regression guard for a real bug: turning on an output format changes
    // nothing about any token, so a push reported "already up to date".
    const githubFiles = [
      file(
        "tokens/metadata.json",
        metadataJson({ platforms: { css: { enabled: true, output: "dist/tokens.css" } } }),
      ),
      primitivesFile,
    ];
    const missing = push({ githubFiles, repoPaths: new Set() });
    expect(missing.outcome).toBe("review");
    expect(missing.diffs).toEqual([]);
    expect(missing.outputOnlyFiles).toEqual(["dist/tokens.css"]);

    const present = push({ githubFiles, repoPaths: new Set(["dist/tokens.css"]) });
    expect(present.outcome).toBe("up-to-date");
    expect(present.outputOnlyFiles).toEqual([]);
  });

  it("opens the review, with no diffs, when a configured mode no longer exists in Figma", () => {
    // Regression guard: a mode renamed in Figma hides its whole collection
    // from the diff, which looks exactly like "up to date" — but the warning
    // banner only renders on the review screen.
    const githubFiles = [
      file("tokens/metadata.json", metadataJson({ themes: ["old-name"], ...withThemesMapped })),
      primitivesFile,
    ];
    const collections: FigmaVariableCollection[] = [
      ...figmaCollections(),
      { id: "c2", name: "Themes", modes: [{ modeId: "t1", name: "New Name" }], variableIds: [] },
    ];
    const r = push({ githubFiles, figmaCollections: collections });
    expect(r.staleModes).toEqual([{ role: "themes", name: "old-name" }]);
    expect(r.diffs).toEqual([]);
    expect(r.outcome).toBe("review");
  });

  it("returns the parsed repo and Figma data the Create PR step needs", () => {
    const r = push({ figmaVariables: figmaVariables(8) });
    expect(r.githubParsed.collections.length).toBeGreaterThan(0);
    expect(r.figmaCollectionData.length).toBeGreaterThan(0);
    expect(r.conflictPaths).toEqual([]);
  });

  it("reports Figma collections it doesn't recognise instead of dropping them silently", () => {
    const collections: FigmaVariableCollection[] = [
      ...figmaCollections(),
      { id: "c9", name: "Mystery", modes: [{ modeId: "z", name: "Value" }], variableIds: [] },
    ];
    expect(push({ figmaCollections: collections }).unknownCollectionNames).toEqual(["Mystery"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pull
// ─────────────────────────────────────────────────────────────────────────

describe("reviewPull", () => {
  // A real parse, so the GitHub side of each fixture stays honest.
  const parsedFrom = (files: GitHubFile[]) => parseRepository(files, "tokens");

  it("is up to date when Figma already matches GitHub", () => {
    const github = parsedFrom([file("tokens/metadata.json", metadataJson()), primitivesFile]);
    const r = reviewPull(github, figmaCollections(), figmaVariables(4), []);
    expect(r.outcome).toBe("up-to-date");
    expect(r.diffs).toEqual([]);
  });

  it("opens the review when GitHub differs from Figma, listing only collections with changes", () => {
    const github = parsedFrom([file("tokens/metadata.json", metadataJson()), primitivesFile]);
    const r = reviewPull(github, figmaCollections(), figmaVariables(8), []);
    expect(r.outcome).toBe("review");
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0].counts.changed).toBe(1);
    expect(r.filteredGithubCollections.length).toBeGreaterThan(0);
  });

  it("still opens the review when there are no changes but a configured mode is missing in Figma", () => {
    const github = parsedFrom([
      file("tokens/metadata.json", metadataJson({ themes: ["old-name"], ...withThemesMapped })),
    ]);
    const collections: FigmaVariableCollection[] = [
      { id: "c2", name: "Themes", modes: [{ modeId: "t1", name: "New Name" }], variableIds: [] },
    ];
    const r = reviewPull(github, collections, [], []);
    expect(r.staleModes).toEqual([{ role: "themes", name: "old-name" }]);
    expect(r.diffs).toEqual([]);
    expect(r.outcome).toBe("review");
  });
});

describe("skippedCollectionsSuffix", () => {
  it("is empty when nothing was skipped", () => {
    expect(skippedCollectionsSuffix([])).toBe("");
  });
  it("names the skipped collections, pluralising", () => {
    expect(skippedCollectionsSuffix(["A"])).toContain("skipped unrecognized collection: A");
    expect(skippedCollectionsSuffix(["A", "B"])).toContain("collections: A, B");
  });
});
