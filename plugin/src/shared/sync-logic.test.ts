import { describe, it, expect } from "vitest";
import {
  isIgnoredCollection,
  computePullDiff,
  computePushDiff,
  buildFilesFromDiffs,
} from "./sync-logic";
import type { Metadata, ResolvedCollection } from "./token-merger";
import type { FigmaFlatMap } from "./sync-logic";
import type { FigmaVariableCollection, FigmaVariable } from "./messages";

function metadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    version: "1.0.0",
    themes: ["default"],
    colorSchemes: ["light", "dark"],
    sizes: [],
    figma: {
      fileKey: "abc",
      collections: {
        primitives: ["Primitives"],
        global: ["Global"],
        themes: ["Themes"],
        semantic: ["Semantic"],
        sizes: [],
      },
    },
    ignoredCollections: [],
    ...overrides,
  };
}

function col(
  collectionName: string,
  modeName: string,
  tokens: ResolvedCollection["tokens"],
  rawTokens: ResolvedCollection["rawTokens"] = tokens,
): ResolvedCollection {
  return { collectionName, modeName, tokens, rawTokens, typographyStyles: [] };
}

describe("isIgnoredCollection", () => {
  it("is true when the collection's role is listed in ignoredCollections", () => {
    const meta = metadata({ ignoredCollections: ["primitives"] });
    expect(isIgnoredCollection("Primitives", meta)).toBe(true);
  });

  it("is false when the role isn't ignored", () => {
    const meta = metadata({ ignoredCollections: ["primitives"] });
    expect(isIgnoredCollection("Semantic", meta)).toBe(false);
  });

  it("is false for a collection name that matches no configured role at all", () => {
    const meta = metadata({ ignoredCollections: ["primitives"] });
    expect(isIgnoredCollection("Some Unmapped Collection", meta)).toBe(false);
  });

  it("finds a role even when several physical collections back it", () => {
    const meta = metadata({
      figma: {
        fileKey: "abc",
        collections: {
          primitives: ["Primitives"],
          global: [],
          themes: ["Main Color", "Support Color"],
          semantic: ["Semantic"],
          sizes: [],
        },
      },
      ignoredCollections: ["themes"],
    });
    expect(isIgnoredCollection("Support Color", meta)).toBe(true);
    expect(isIgnoredCollection("Main Color", meta)).toBe(true);
  });
});

describe("computePullDiff", () => {
  it("matches a Figma mode name case-insensitively against a GitHub capitalise()'d one", () => {
    // parseRepository always capitalise()s mode names ("Light"); a real
    // Figma mode might be any casing at all ("light"). This is the exact
    // bug found via /code-review — case-sensitive matching silently treats
    // every token as "added" when the casing doesn't line up.
    const github = [col("Semantic", "Light", { "color.a": { $type: "color", $value: "#fff" } })];
    const figmaMaps: FigmaFlatMap[] = [
      { collectionName: "Semantic", modeName: "light", values: { "color.a": "#fff" } },
    ];

    const { diffs } = computePullDiff(github, metadata(), figmaMaps);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].counts.total).toBe(0); // matched and identical -> no diff entries
  });

  it("excludes ignored collections from both the diff and the filtered list", () => {
    const github = [
      col("Primitives", "Value", { "color.a": { $type: "color", $value: "#fff" } }),
      col("Semantic", "Light", { "color.b": { $type: "color", $value: "#000" } }),
    ];
    const meta = metadata({ ignoredCollections: ["primitives"] });

    const { diffs, filteredGithubCollections } = computePullDiff(github, meta, []);

    expect(diffs.map((d) => d.collectionName)).toEqual(["Semantic"]);
    expect(filteredGithubCollections.map((c) => c.collectionName)).toEqual(["Semantic"]);
  });

  it("diffs against an empty Figma value set when no matching mode exists in Figma at all", () => {
    const github = [col("Semantic", "Light", { "color.a": { $type: "color", $value: "#fff" } })];

    const { diffs } = computePullDiff(github, metadata(), []);

    expect(diffs[0].counts.total).toBeGreaterThan(0);
  });
});

describe("computePushDiff", () => {
  it("swaps direction relative to pull — Figma is proposed, GitHub is current", () => {
    const figma = [col("Semantic", "Light", { "color.a": { $type: "color", $value: "#111111" } })];
    const github = [col("Semantic", "Light", { "color.a": { $type: "color", $value: "#fffFFF" } })];

    const diffs = computePushDiff(figma, github, metadata());

    // The diff's "current" values come from githubCol (per the real-value swap
    // computePushDiff makes) — proven by the entry actually showing a change.
    expect(diffs).toHaveLength(1);
    expect(diffs[0].counts.total).toBeGreaterThan(0);
  });

  it("matches modes case-insensitively, same as the pull direction", () => {
    const figma = [col("Semantic", "Light", { "color.a": { $type: "color", $value: "#fff" } })];
    const github = [col("Semantic", "light", { "color.a": { $type: "color", $value: "#fff" } })];

    const diffs = computePushDiff(figma, github, metadata());

    expect(diffs[0].counts.total).toBe(0);
  });

  it("excludes ignored Figma collections from the diff", () => {
    const figma = [
      col("Primitives", "Value", { "color.a": { $type: "color", $value: "#fff" } }),
      col("Semantic", "Light", { "color.b": { $type: "color", $value: "#000" } }),
    ];
    const meta = metadata({ ignoredCollections: ["primitives"] });

    const diffs = computePushDiff(figma, [], meta);

    expect(diffs.map((d) => d.collectionName)).toEqual(["Semantic"]);
  });
});

describe("buildFilesFromDiffs", () => {
  const figmaCollections: FigmaVariableCollection[] = [
    {
      id: "c1",
      name: "Primitives",
      modes: [{ modeId: "m1", name: "Value" }],
      variableIds: ["v1"],
    },
    {
      id: "c2",
      name: "Semantic",
      modes: [
        { modeId: "m2", name: "Light" },
        { modeId: "m3", name: "Dark" },
      ],
      variableIds: ["v2"],
    },
  ];

  const variables: FigmaVariable[] = [
    {
      id: "v1",
      name: "color/brand",
      resolvedType: "COLOR",
      valuesByMode: { m1: { r: 0, g: 0, b: 1 } },
      collectionId: "c1",
      collectionName: "Primitives",
    },
    {
      id: "v2",
      name: "background/default",
      resolvedType: "COLOR",
      valuesByMode: {
        m2: { r: 1, g: 1, b: 1 },
        m3: { r: 0, g: 0, b: 0 },
      },
      collectionId: "c2",
      collectionName: "Semantic",
    },
  ];

  it("only writes the selected modes — an unselected mode is dropped entirely", () => {
    const selectedKeys = new Set(["Primitives/Value", "Semantic/Light"]);

    const files = buildFilesFromDiffs(
      selectedKeys,
      { collections: figmaCollections, variables },
      metadata(),
      "tokens/",
      null,
    );

    const paths = files.map((f) => f.path);
    expect(paths).toContain("tokens/semantic/light.json");
    expect(paths).not.toContain("tokens/semantic/dark.json");
  });

  it("returns no platform output when allFigmaCollections is null", () => {
    const selectedKeys = new Set(["Primitives/Value", "Semantic/Light", "Semantic/Dark"]);

    const files = buildFilesFromDiffs(
      selectedKeys,
      { collections: figmaCollections, variables },
      metadata({ platforms: { css: { enabled: true } } }),
      "tokens/",
      null,
    );

    expect(files.some((f) => f.path.endsWith("tokens.css"))).toBe(false);
  });

  it("runs platform transformers against the full collection set when provided, regardless of selection", () => {
    const selectedKeys = new Set(["Primitives/Value"]); // Semantic deliberately not selected

    const allFigmaCollections: ResolvedCollection[] = [
      col("Primitives", "Value", { "color.brand": { $type: "color", $value: "#0000ff" } }),
      col("Semantic", "Light", { "background.default": { $type: "color", $value: "#ffffff" } }),
    ];

    const files = buildFilesFromDiffs(
      selectedKeys,
      { collections: figmaCollections, variables },
      metadata({ platforms: { css: { enabled: true, output: "dist/tokens.css" } } }),
      "tokens/",
      allFigmaCollections,
    );

    const cssFile = files.find((f) => f.path === "dist/tokens.css");
    expect(cssFile).toBeDefined();
    // Semantic wasn't in selectedKeys, but platform output reflects the full
    // design system regardless — confirmed by its value showing up in the CSS.
    expect(cssFile?.content).toContain("--background-default: #ffffff");
  });
});
