import { describe, it, expect } from "vitest";
import {
  isIgnoredCollection,
  computePullDiff,
  computePushDiff,
  buildFilesFromDiffs,
  findMissingOutputFiles,
  buildApplyPayloads,
  buildCleanApplyPayloads,
  mergeTypographyIntoFigmaMaps,
  isModeAgnosticRole,
  findStaleConfiguredModes,
} from "./sync-logic";
import type { Metadata, ResolvedCollection, CollectionSources } from "./token-merger";
import type { TypographyStyle } from "./typography-styles";
import type { FigmaFlatMap } from "./sync-logic";
import type { FigmaVariableCollection, FigmaVariable } from "./messages";
import type { CollectionDiff, DiffEntry } from "./token-diff";
import { figmaToCollections } from "./figma-to-tokens";

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

function figmaMap(
  collectionName: string,
  modeName: string,
  values: Record<string, string>,
  rawValues: Record<string, string> = values,
): FigmaFlatMap {
  return { collectionName, modeName, values, rawValues };
}

function entry(path: string, status: DiffEntry["status"], value = "#fff"): DiffEntry {
  return {
    path,
    type: "color",
    status,
    githubValue: status === "removed" ? null : value,
    githubRawValue: status === "removed" ? null : value,
    figmaValue: status === "added" ? null : "#000",
    figmaRawValue: status === "added" ? null : "#000",
  };
}

function diff(collectionName: string, modeName: string, entries: DiffEntry[]): CollectionDiff {
  const counts = {
    added: entries.filter((e) => e.status === "added").length,
    changed: entries.filter((e) => e.status === "changed").length,
    removed: entries.filter((e) => e.status === "removed").length,
    total: entries.length,
  };
  return { collectionName, modeName, entries, counts };
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

describe("findStaleConfiguredModes", () => {
  // Reproduces a real bug found live: a Figma mode renamed from its default
  // ("Mode 1") to something meaningful ("Semantic") pushed fine under its
  // new real name (Figma is always the source of truth for its own live
  // data), but metadata.colorSchemes still held the old sanitized slug
  // ("mode-1") — nothing ever prompts a re-save of Map Collections just
  // because a mode got renamed. The next pull's file lookup then finds
  // nothing at all for "mode-1", and the whole semantic collection silently
  // vanishes with no error or indication anything is wrong.
  const semanticCollection: FigmaVariableCollection = {
    id: "cSem",
    name: "Tokens",
    modes: [{ modeId: "m1", name: "Semantic" }],
    variableIds: [],
  };

  it("flags a configured colorScheme that no longer matches any real Figma mode", () => {
    const meta = metadata({
      colorSchemes: ["mode-1"],
      figma: {
        fileKey: "abc",
        collections: {
          primitives: ["Primitives"],
          global: [],
          themes: [],
          semantic: ["Tokens"],
          sizes: [],
        },
      },
    });

    const stale = findStaleConfiguredModes(meta, [semanticCollection]);
    expect(stale).toEqual([{ role: "colorSchemes", name: "mode-1" }]);
  });

  it("reports nothing once the configured name matches the real Figma mode again", () => {
    const meta = metadata({
      colorSchemes: ["Semantic"],
      figma: {
        fileKey: "abc",
        collections: {
          primitives: ["Primitives"],
          global: [],
          themes: [],
          semantic: ["Tokens"],
          sizes: [],
        },
      },
    });

    expect(findStaleConfiguredModes(meta, [semanticCollection])).toEqual([]);
  });

  it("skips a role entirely when nothing is mapped to it at all — a leftover placeholder isn't stale", () => {
    // metadata.themes defaults to ["default"] even on a project with no
    // Themes role mapped whatsoever (figma.collections.themes: []) — must
    // not be flagged just because nothing in Figma could ever match it.
    const meta = metadata({
      themes: ["default"],
      colorSchemes: [], // unmapped too, so only the themes-role behavior is under test
      figma: {
        fileKey: "abc",
        collections: {
          primitives: ["Primitives"],
          global: [],
          themes: [],
          semantic: [],
          sizes: [],
        },
      },
    });

    expect(findStaleConfiguredModes(meta, [semanticCollection])).toEqual([]);
  });
});

describe("computePullDiff", () => {
  it("matches a Figma mode name case-insensitively against a GitHub capitalise()'d one", () => {
    // parseRepository always capitalise()s mode names ("Light"); a real
    // Figma mode might be any casing at all ("light"). This is the exact
    // bug found via /code-review — case-sensitive matching silently treats
    // every token as "added" when the casing doesn't line up.
    const github = [col("Semantic", "Light", { "color.a": { $type: "color", $value: "#fff" } })];
    const figmaMaps: FigmaFlatMap[] = [figmaMap("Semantic", "light", { "color.a": "#fff" })];

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

  it("merges Figma values from every physical collection backing a role, not just the one matching by exact name", () => {
    // Reproduces a real bug found live: primitives role backed by "size" and
    // "primitives". GitHub's merged entry is named "size" (collections.primitives[0]),
    // but the actual color values live in the "primitives" Figma collection's
    // OWN flat map entry — a plain .find() by exact name could only ever match
    // one of the two, so colors showed as "added" on every single pull,
    // forever, even immediately after pushing those exact same values.
    const github = [
      col("size", "mobile", {
        "primitive.font-size.1": { $type: "dimension", $value: "16px" },
        "Black.100": { $type: "color", $value: "rgba(0, 0, 0, 0.15)" },
      }),
    ];
    const figmaMaps: FigmaFlatMap[] = [
      figmaMap("size", "mobile", { "primitive.font-size.1": "16px" }),
      figmaMap("primitives", "color", { "Black.100": "rgba(0, 0, 0, 0.15)" }),
    ];
    const meta = metadata({
      figma: {
        fileKey: "abc",
        collections: {
          primitives: ["size", "primitives"],
          global: ["Global"],
          themes: ["Themes"],
          semantic: ["Semantic"],
          sizes: [],
        },
      },
    });

    const { diffs } = computePullDiff(github, meta, figmaMaps);

    // Both values already match what's in Figma — genuinely nothing changed.
    expect(diffs[0].counts.total).toBe(0);
  });

  it("merges a real sizes-role collection's matching mode into a Primitives+Sizes composite entry, not just the primitives-role map", () => {
    // Reproduces a real bug found live: after a completely clean repo wipe
    // and fresh push, pulling straight back still showed every dimension as
    // permanently "added" — parseRepository's Primitives+Sizes composite
    // entry (colors + this mode's own dimensions, both labeled "Primitives")
    // was only ever compared against Figma's "primitives"-role map, since
    // role was derived from githubCol.collectionName ("Primitives" — never
    // "size", see figmaValuesFor's doc comment) and the old code required an
    // exact role match, excluding the real "size" collection's data entirely.
    const github = [
      col("Primitives", "Mobile", {
        "Black.100": { $type: "color", $value: "rgba(0, 0, 0, 0.15)" },
        "primitive.dimension.1": { $type: "number", $value: "4" },
      }),
    ];
    const figmaMaps: FigmaFlatMap[] = [
      figmaMap("Primitives", "Value", { "Black.100": "rgba(0, 0, 0, 0.15)" }),
      figmaMap("Size", "mobile", { "primitive.dimension.1": "4" }),
      // Desktop's own value for the same path — must NOT be pulled in when
      // comparing against the "Mobile" entry.
      figmaMap("Size", "desktop", { "primitive.dimension.1": "7" }),
    ];
    const meta = metadata({
      figma: {
        fileKey: "abc",
        collections: {
          primitives: ["Primitives"],
          global: ["Global"],
          themes: ["Themes"],
          semantic: ["Semantic"],
          sizes: ["Size"],
        },
      },
    });

    const { diffs } = computePullDiff(github, meta, figmaMaps);

    // Everything already matches what's in the correct (mobile) Figma
    // sources — genuinely nothing changed.
    expect(diffs[0].counts.total).toBe(0);
  });
});

describe("mergeTypographyIntoFigmaMaps", () => {
  // Reproduces a real bug found live: buildFigmaFlatMaps (useFigmaValues.ts)
  // only ever reads Figma Variables — a Text Style field, bound or not, was
  // completely invisible to computePullDiff, so every already-pushed
  // typography token showed as permanently "added" on every single pull,
  // never "unchanged," even immediately after pushing those exact values.
  const names = {
    primitives: ["Primitives"],
    global: ["Global"],
    themes: ["Themes"],
    semantic: ["Semantic"],
    sizes: [] as string[],
  };
  const meta = metadata({ figma: { fileKey: "abc", collections: names } });

  it("adds an unbound field's literal value as a new Global-role entry", () => {
    const typographyStyles: TypographyStyle[] = [
      {
        path: "text.heading.caption",
        fields: { textCase: { $type: "string", $value: "uppercase" } },
      },
    ];

    const merged = mergeTypographyIntoFigmaMaps([], typographyStyles, meta);

    const global = merged.find((m) => m.collectionName === "Global")!;
    expect(global.values["text.heading.caption.textCase"]).toBe("uppercase");
  });

  it("a bound field's rawValues entry keeps the {ref} as-is, for raw-based diffing", () => {
    const figmaMaps: FigmaFlatMap[] = [
      figmaMap("Themes", "Masterbrand", { "font-family.display": "Coop Sans" }),
    ];
    const typographyStyles: TypographyStyle[] = [
      {
        path: "typography.banner",
        fields: { fontFamily: { $type: "fontFamily", $value: "{font-family.display}" } },
      },
    ];

    const merged = mergeTypographyIntoFigmaMaps(figmaMaps, typographyStyles, meta);

    const global = merged.find((m) => m.collectionName === "Global")!;
    expect(global.values["typography.banner.fontFamily"]).toBe("Coop Sans"); // resolved
    expect(global.rawValues["typography.banner.fontFamily"]).toBe("{font-family.display}"); // raw
  });

  it("resolves a bound field's {ref} against the other FigmaFlatMaps' already-resolved values", () => {
    const figmaMaps: FigmaFlatMap[] = [
      figmaMap("Themes", "Masterbrand", { "font-family.display": "Coop Sans" }),
    ];
    const typographyStyles: TypographyStyle[] = [
      {
        path: "typography.banner",
        fields: { fontFamily: { $type: "fontFamily", $value: "{font-family.display}" } },
      },
    ];

    const merged = mergeTypographyIntoFigmaMaps(figmaMaps, typographyStyles, meta);

    const global = merged.find((m) => m.collectionName === "Global")!;
    expect(global.values["typography.banner.fontFamily"]).toBe("Coop Sans");
  });

  it("end-to-end: computePullDiff shows no change when GitHub's resolved typography matches Figma's live Text Style", () => {
    const github = [
      col(
        "Global",
        "Value",
        { "typography.banner.fontFamily": { $type: "fontFamily", $value: "Coop Sans" } },
        // rawTokens stays the unresolved {ref} — matches what's actually
        // committed to typography.json (injectTypographyStyles writes the
        // literal ref, never the resolved value).
        {
          "typography.banner.fontFamily": { $type: "fontFamily", $value: "{font-family.display}" },
        },
      ),
    ];
    const figmaMaps: FigmaFlatMap[] = [
      figmaMap("Themes", "Masterbrand", { "font-family.display": "Coop Sans" }),
    ];
    const typographyStyles: TypographyStyle[] = [
      {
        path: "typography.banner",
        fields: { fontFamily: { $type: "fontFamily", $value: "{font-family.display}" } },
      },
    ];

    const merged = mergeTypographyIntoFigmaMaps(figmaMaps, typographyStyles, meta);
    const { diffs } = computePullDiff(github, meta, merged);

    expect(diffs[0].counts.total).toBe(0);
  });

  it("returns figmaMaps unchanged when there are no typography styles", () => {
    const figmaMaps: FigmaFlatMap[] = [figmaMap("Primitives", "Value", {})];
    expect(mergeTypographyIntoFigmaMaps(figmaMaps, [], meta)).toBe(figmaMaps);
  });

  it("resolves a size-varying ref against the DEFAULT size mode, not whichever mode's map comes last", () => {
    // Reproduces a real bug found live: a naive union of every FigmaFlatMap's
    // values let desktop's font-size scale silently win over mobile's
    // (metadata.sizes[0], the configured default) purely because it happened
    // to be processed later in the array — every typography fontSize showed
    // as "changed" (desktop's value vs. GitHub's correctly mobile-resolved
    // one) even when nothing had actually changed.
    const figmaMaps: FigmaFlatMap[] = [
      figmaMap("Size", "desktop", { "primitive.font-size.6": "21px" }),
      figmaMap("Size", "mobile", { "primitive.font-size.6": "17px" }),
    ];
    const typographyStyles: TypographyStyle[] = [
      {
        path: "typography.action-large",
        fields: { fontSize: { $type: "dimension", $value: "{primitive.font-size.6}" } },
      },
    ];
    const sizeMeta = metadata({
      sizes: ["mobile", "desktop"],
      figma: {
        fileKey: "abc",
        collections: { ...names, sizes: ["Size"] },
      },
    });

    const merged = mergeTypographyIntoFigmaMaps(figmaMaps, typographyStyles, sizeMeta);

    const global = merged.find((m) => m.collectionName === "Global")!;
    expect(global.values["typography.action-large.fontSize"]).toBe("17px");
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

  it("matches Primitives (no Size axis) regardless of mode name — it's an arbitrary Figma default, not real data", () => {
    // Reproduces a real bug found live: with no Size axis, GitHub's own
    // parsed Primitives collection always uses a fixed placeholder modeName
    // ("Value" — parseRepository has no way to know what Figma's real,
    // arbitrary mode name actually is from a plain color.json). Figma's real
    // Primitives collection reports whatever it's actually called — often
    // literally "Mode 1", Figma's own unrenamed default. Requiring an exact
    // modeName match compared these and never matched, permanently showing
    // every Primitives token as newly "added" on every single push, even
    // when nothing had actually changed (confirmed live: the resulting
    // written file was byte-identical to what was already committed).
    const figma = [col("Primitives", "Mode 1", { "color.a": { $type: "color", $value: "#fff" } })];
    const github = [col("Primitives", "Value", { "color.a": { $type: "color", $value: "#fff" } })];

    const diffs = computePushDiff(figma, github, metadata());

    expect(diffs[0].counts.total).toBe(0);
  });

  it("still matches Primitives by mode name when a real Size axis exists — multiple real modes must not collapse into one", () => {
    // The relaxation above only applies when there's genuinely one
    // Primitives entry to begin with — a real Size axis produces one
    // ResolvedCollection per size mode, each needing its own distinct match.
    const figma = [
      col("Primitives", "Mobile", { "font-size.1": { $type: "dimension", $value: "11px" } }),
      col("Primitives", "Desktop", { "font-size.1": { $type: "dimension", $value: "12px" } }),
    ];
    const github = [
      col("Primitives", "Mobile", { "font-size.1": { $type: "dimension", $value: "11px" } }),
      col("Primitives", "Desktop", { "font-size.1": { $type: "dimension", $value: "99px" } }),
    ];

    const diffs = computePushDiff(figma, github, metadata({ sizes: ["mobile", "desktop"] }));

    const mobile = diffs.find((d) => d.modeName === "Mobile")!;
    const desktop = diffs.find((d) => d.modeName === "Desktop")!;
    expect(mobile.counts.total).toBe(0);
    expect(desktop.counts.changed).toBe(1);
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

  it("surfaces a real Figma Text Style field as a reviewable diff entry, not just a file write", () => {
    // End-to-end proof that the push diff view (built from figmaToCollections'
    // output, see handlePushCollectionsLoaded in Sync.tsx) actually shows a
    // Text Style change before it's pushed — textCase has no Variable
    // counterpart at all, so this is the only path it can appear on.
    const { collections: figmaCollections } = figmaToCollections([], [], metadata(), [
      {
        path: "text.heading.caption",
        fields: { textCase: { $type: "string", $value: "uppercase" } },
      },
    ]);

    const diffs = computePushDiff(figmaCollections, [], metadata());
    const globalDiff = diffs.find((d) => d.collectionName === "Global")!;

    expect(globalDiff).toBeDefined();
    const entry = globalDiff.entries.find((e) => e.path === "text.heading.caption.textCase");
    expect(entry?.status).toBe("added");
    expect(entry?.githubValue).toBe("uppercase");
  });
});

describe("isModeAgnosticRole", () => {
  // The single, shared definition computePushDiff and figmaValuesFor (pull's
  // matching) both consult — see its own doc comment for the live bug this
  // fixed. Direct tests here so a future change to this policy can't
  // silently pass while breaking one direction's actual behavior.
  it("Global is always mode-agnostic", () => {
    expect(isModeAgnosticRole("global")).toBe(true);
    expect(isModeAgnosticRole("global", true)).toBe(true);
  });

  it("Primitives is mode-agnostic only without a genuine Size axis", () => {
    expect(isModeAgnosticRole("primitives")).toBe(true);
    expect(isModeAgnosticRole("primitives", false)).toBe(true);
    expect(isModeAgnosticRole("primitives", true)).toBe(false);
  });

  it("every other role always requires a real mode-name match", () => {
    expect(isModeAgnosticRole("themes")).toBe(false);
    expect(isModeAgnosticRole("semantic")).toBe(false);
    expect(isModeAgnosticRole("sizes")).toBe(false);
    expect(isModeAgnosticRole("unknown")).toBe(false);
  });
});

describe("push and pull agree on a genuinely single-mode system", () => {
  // The actual drift guard: rather than trusting the two directions to keep
  // agreeing just because they both now call isModeAgnosticRole, this drives
  // computePushDiff AND computePullDiff from the *same* real-world data (a
  // single-mode Primitives collection, Figma's real mode name vs GitHub's
  // reconstructed placeholder) and asserts both report zero changes. If a
  // future edit to either direction reintroduces a mismatch, this fails
  // regardless of which side regressed.
  const figmaCol = col("Primitives", "Mode 1", {
    "color.a": { $type: "color", $value: "#fff" },
  });
  const githubCol = col("Primitives", "Value", {
    "color.a": { $type: "color", $value: "#fff" },
  });

  it("push reports no changes", () => {
    const diffs = computePushDiff([figmaCol], [githubCol], metadata());
    expect(diffs[0].counts.total).toBe(0);
  });

  it("pull reports no changes", () => {
    const figmaMaps = [figmaMap("Primitives", "Mode 1", { "color.a": "#fff" })];
    const { diffs } = computePullDiff([githubCol], metadata(), figmaMaps);
    expect(diffs[0].counts.total).toBe(0);
  });
});

describe("findMissingOutputFiles", () => {
  // Reproduces a real bug found live: enabling a new platform in Output
  // Formats (e.g. Dart, previously off) has nothing to do with any token's
  // value, so a push with zero token changes reported "already up to date"
  // and never generated its output file — the check only ever looked at
  // token-level diffs, with no idea that metadata.platforms is a second,
  // independent source of "something changed."
  const collections = [
    col("Primitives", "Value", { "color.a": { $type: "color", $value: "#fff" } }),
  ];

  it("reports the configured output path as missing when it doesn't exist in the repo yet", () => {
    const meta = metadata({ platforms: { js: { enabled: true, output: "dist/tokens.js" } } });
    const missing = findMissingOutputFiles(collections, meta, "tokens/", new Set());
    expect(missing.map((f) => f.path)).toEqual(["dist/tokens.js"]);
  });

  it("reports nothing missing once the output path already exists in the repo", () => {
    const meta = metadata({ platforms: { js: { enabled: true, output: "dist/tokens.js" } } });
    const missing = findMissingOutputFiles(
      collections,
      meta,
      "tokens/",
      new Set(["dist/tokens.js"]),
    );
    expect(missing).toEqual([]);
  });

  it("reports nothing when no platform is enabled at all", () => {
    const meta = metadata({});
    const missing = findMissingOutputFiles(collections, meta, "tokens/", new Set());
    expect(missing).toEqual([]);
  });

  it("only reports the specific platforms that are actually missing", () => {
    const meta = metadata({
      platforms: {
        css: { enabled: true, output: "dist/tokens.css" },
        js: { enabled: true, output: "dist/tokens.js" },
      },
    });
    // css already exists; js was just enabled and never generated
    const missing = findMissingOutputFiles(
      collections,
      meta,
      "tokens/",
      new Set(["dist/tokens.css"]),
    );
    expect(missing.map((f) => f.path)).toEqual(["dist/tokens.js"]);
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

    const { files } = buildFilesFromDiffs(
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

    const { files } = buildFilesFromDiffs(
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

    const { files } = buildFilesFromDiffs(
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

  it("threads real Figma Text Styles through to the pushed typography.json", () => {
    const globalCollections: FigmaVariableCollection[] = [
      { id: "c3", name: "Global", modes: [{ modeId: "m4", name: "Value" }], variableIds: [] },
    ];
    const selectedKeys = new Set(["Global/Value"]);

    const { files } = buildFilesFromDiffs(
      selectedKeys,
      {
        collections: globalCollections,
        variables: [],
        typographyStyles: [
          {
            path: "text.heading.caption",
            fields: { textCase: { $type: "string", $value: "uppercase" } },
          },
        ],
      },
      metadata(),
      "tokens/",
      null,
    );

    const typoFile = files.find((f) => f.path === "tokens/semantic/global/typography.json")!;
    const tree = JSON.parse(typoFile.content);
    expect(tree.text.heading.caption.$type).toBe("typography");
    expect(tree.text.heading.caption.textCase.$value).toBe("uppercase");
  });

  it("includes every physical collection sharing a role, not just the one whose real name matches figma.collections[0]", () => {
    // Reproduces a real bug found live: primitives role backed by two real
    // Figma collections, "size" and "primitives" (figma.collections.primitives
    // === ["size", "primitives"]). figmaToCollections merges both into ONE
    // synthetic ResolvedCollection named after figma.collections.primitives[0]
    // ("size") for diffing — the diff correctly showed both collections'
    // tokens together. But selection filtering here matched selectedKeys
    // against each REAL collection's own name, so "primitives" (color) never
    // matched "size/mobile" and was silently dropped from the actual PR file,
    // even though it was shown, counted, and checked in the diff the user approved.
    const realCollections: FigmaVariableCollection[] = [
      { id: "c1", name: "size", modes: [{ modeId: "m1", name: "mobile" }], variableIds: ["v1"] },
      {
        id: "c2",
        name: "primitives",
        modes: [{ modeId: "m2", name: "color" }],
        variableIds: ["v2"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "primitive/font-size/1",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 16 },
        collectionId: "c1",
        collectionName: "size",
      },
      {
        id: "v2",
        name: "Black/100",
        resolvedType: "COLOR",
        valuesByMode: { m2: { r: 0, g: 0, b: 0, a: 0.15 } },
        collectionId: "c2",
        collectionName: "primitives",
      },
    ];
    // This is exactly the one key the diff view would have produced and had
    // checked — computePushDiff/figmaToCollections only ever emit one merged
    // entry for the whole role, named figma.collections.primitives[0].
    const selectedKeys = new Set(["size/mobile"]);

    const { files } = buildFilesFromDiffs(
      selectedKeys,
      { collections: realCollections, variables },
      metadata({
        figma: {
          fileKey: "abc",
          collections: {
            primitives: ["size", "primitives"],
            global: ["Global"],
            themes: ["Themes"],
            semantic: ["Semantic"],
            sizes: [],
          },
        },
      }),
      "tokens/",
      null,
    );

    const allContent = files.map((f) => f.content).join("\n");
    expect(allContent).toContain('"font-size"');
    expect(allContent).toContain("rgba(0, 0, 0, 0.15)");
  });

  it("matches selected mode names case-insensitively, for a themes role backed by two physical collections", () => {
    // The same class of bug, on the mode-name-matching branch instead of the
    // whole-role branch — "Main Color" and "Support Color" both contribute a
    // "Christmas" mode (a real, documented case — see figma-to-tokens.test.ts
    // "multiple physical collections mapped to one role"), and mode names
    // merge case-insensitively (mergeIntoMode). The selection check must too.
    const realCollections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Main Color",
        modes: [{ modeId: "m1", name: "Christmas" }],
        variableIds: ["v1"],
      },
      {
        id: "c2",
        name: "Support Color",
        modes: [{ modeId: "m2", name: "christmas" }],
        variableIds: ["v2"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "color/primary",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 1, g: 0, b: 0 } },
        collectionId: "c1",
        collectionName: "Main Color",
      },
      {
        id: "v2",
        name: "color/accent",
        resolvedType: "COLOR",
        valuesByMode: { m2: { r: 0, g: 1, b: 0 } },
        collectionId: "c2",
        collectionName: "Support Color",
      },
    ];
    // The diff produces one merged entry per mode name, named after
    // figma.collections.themes[0] — "Main Color/Christmas" here.
    const selectedKeys = new Set(["Main Color/Christmas"]);

    const { files } = buildFilesFromDiffs(
      selectedKeys,
      { collections: realCollections, variables },
      metadata({
        figma: {
          fileKey: "abc",
          collections: {
            primitives: ["Primitives"],
            global: ["Global"],
            themes: ["Main Color", "Support Color"],
            semantic: ["Semantic"],
            sizes: [],
          },
        },
      }),
      "tokens/",
      null,
    );

    const allContent = files.map((f) => f.content).join("\n");
    expect(allContent).toContain('"primary"');
    expect(allContent).toContain('"accent"');
  });

  it("selects a real sizes-role collection's matching mode, and the shared primitives collection regardless of mode — the Primitives+Sizes composite", () => {
    // Reproduces a real bug found live: primitives role backed by a single
    // "primitives" collection (colors), with "size" mapped to the dedicated
    // sizes role (mobile/desktop). figmaToCollections labels every size-mode
    // entry "Primitives" (never "size" — see isModeSelected's doc comment),
    // so selecting "Primitives/mobile" must resolve to the real "size"
    // collection's mobile mode specifically, and separately always include
    // the real "primitives" collection since it's shared across every mode.
    const realCollections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "primitives",
        modes: [{ modeId: "m1", name: "color" }],
        variableIds: ["v1"],
      },
      {
        id: "c2",
        name: "size",
        modes: [
          { modeId: "m2", name: "mobile" },
          { modeId: "m3", name: "desktop" },
        ],
        variableIds: ["v2"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "Black/100",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 0.15 } },
        collectionId: "c1",
        collectionName: "primitives",
      },
      {
        id: "v2",
        name: "primitive/dimension/1",
        resolvedType: "FLOAT",
        valuesByMode: { m2: 4, m3: 7 },
        collectionId: "c2",
        collectionName: "size",
      },
    ];
    const names = {
      primitives: ["primitives"],
      global: ["Global"],
      themes: ["Themes"],
      semantic: ["Semantic"],
      sizes: ["size"],
    };
    // Exactly what the diff view produces and lets the user check — one
    // "primitives/mobile" entry (named after collections.primitives[0],
    // lowercase to match this real collection's actual name), never
    // "size/mobile".
    const selectedKeys = new Set(["primitives/mobile"]);

    const { files } = buildFilesFromDiffs(
      selectedKeys,
      { collections: realCollections, variables },
      metadata({ figma: { fileKey: "abc", collections: names } }),
      "tokens/",
      null,
    );

    const allContent = files.map((f) => f.content).join("\n");
    expect(allContent).toContain("rgba(0, 0, 0, 0.15)"); // shared primitives — included regardless of mode
    expect(allContent).toContain('"$value": "4px"'); // mobile's own dimension value
    expect(allContent).not.toContain('"$value": "7px"'); // desktop's — must NOT be pulled in by selecting mobile
  });
});

describe("buildApplyPayloads", () => {
  it("with no provenance recorded, sends exactly one payload targeting diff.collectionName — identical to the old single-message behavior", () => {
    const d = diff("Primitives", "Value", [
      entry("color.brand", "added", "#0142fe"),
      entry("color.accent", "changed", "#003ee0"),
      entry("color.old", "removed"),
    ]);

    const payloads = buildApplyPayloads(d, metadata().figma.collections, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0].collectionId).toBe("Primitives");
    expect(payloads[0].modeId).toBe("Value");
    expect(payloads[0].tokens["color.brand"]).toEqual({ $type: "color", $value: "#0142fe" });
    expect(payloads[0].tokens["color.accent"]).toEqual({ $type: "color", $value: "#003ee0" });
    expect(payloads[0].removedPaths).toEqual(["color.old"]);
  });

  it("routes each entry to the real collection its top-level segment came from — the primitives/size bug", () => {
    // Reproduces exactly what went wrong live: primitives role backed by
    // "size" and "primitives", nothing routes to "primitives" without this.
    const d = diff("size", "mobile", [
      entry("primitive.font-size.1", "added", "16px"),
      entry("Black.100", "added", "rgba(0, 0, 0, 0.15)"),
    ]);
    const names = {
      primitives: ["size", "primitives"],
      global: ["Global"],
      themes: ["Themes"],
      semantic: ["Semantic"],
      sizes: [] as string[],
    };
    const sources: CollectionSources = { primitives: { primitive: "size", Black: "primitives" } };

    const payloads = buildApplyPayloads(d, names, sources);

    const sizePayload = payloads.find((p) => p.collectionId === "size")!;
    const primitivesPayload = payloads.find((p) => p.collectionId === "primitives")!;
    expect(sizePayload.tokens["primitive.font-size.1"].$value).toBe("16px");
    expect(sizePayload.tokens["Black.100"]).toBeUndefined();
    expect(primitivesPayload.tokens["Black.100"].$value).toBe("rgba(0, 0, 0, 0.15)");
    expect(primitivesPayload.tokens["primitive.font-size.1"]).toBeUndefined();
  });

  it("routes a removed entry to its recorded target too, not always diff.collectionName", () => {
    const d = diff("Main Color", "Christmas", [entry("support.old", "removed")]);
    const names = {
      primitives: ["Primitives"],
      global: ["Global"],
      themes: ["Main Color", "Support Color"],
      semantic: ["Semantic"],
      sizes: [] as string[],
    };
    const sources: CollectionSources = { themes: { support: "Support Color" } };

    const payloads = buildApplyPayloads(d, names, sources);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].collectionId).toBe("Support Color");
    expect(payloads[0].removedPaths).toEqual(["support.old"]);
  });

  it("checks sources.sizes too when the diff's own role resolves to primitives — the Primitives+Sizes composite", () => {
    // Different from the "routes each entry..." test above: there, BOTH
    // physical collections are mapped to the primitives role directly. Here,
    // "size" is mapped to the dedicated sizes role instead — so the diff
    // entry's OWN resolved role is "primitives" (figmaToCollections/
    // parseRepository always label a size-mode composite entry that way,
    // never "sizes" — see isModeSelected's doc comment), but the segment's
    // provenance was recorded under sources.sizes, since buildCollectionSources
    // derives it from the segment's own real collection. Checking only
    // sources.primitives would miss it and fall back to the wrong collection.
    const d = diff("Primitives", "Mobile", [
      entry("Black.100", "added", "rgba(0, 0, 0, 0.15)"),
      entry("primitive.dimension.1", "added", "4"),
    ]);
    const names = {
      primitives: ["Primitives"],
      global: ["Global"],
      themes: ["Themes"],
      semantic: ["Semantic"],
      sizes: ["Size"],
    };
    const sources: CollectionSources = {
      primitives: { Black: "Primitives" },
      sizes: { primitive: "Size" },
    };

    const payloads = buildApplyPayloads(d, names, sources);

    const primitivesPayload = payloads.find((p) => p.collectionId === "Primitives")!;
    const sizePayload = payloads.find((p) => p.collectionId === "Size")!;
    expect(primitivesPayload.tokens["Black.100"].$value).toBe("rgba(0, 0, 0, 0.15)");
    expect(primitivesPayload.tokens["primitive.dimension.1"]).toBeUndefined();
    expect(sizePayload.tokens["primitive.dimension.1"].$value).toBe("4");
    expect(sizePayload.tokens["Black.100"]).toBeUndefined();
  });
});

describe("buildCleanApplyPayloads", () => {
  it("with no provenance recorded, sends exactly one payload for the whole collection", () => {
    const c = col("Primitives", "Value", {
      "color.brand": { $type: "color", $value: "#0142fe" },
    });

    const payloads = buildCleanApplyPayloads(c, metadata().figma.collections, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0].collectionId).toBe("Primitives");
    expect(payloads[0].tokens["color.brand"].$value).toBe("#0142fe");
  });

  it("splits a role's full token set across the real collections its segments belong to", () => {
    const c = col("size", "mobile", {
      "primitive.font-size.1": { $type: "dimension", $value: "16px" },
      "Black.100": { $type: "color", $value: "rgba(0, 0, 0, 0.15)" },
    });
    const names = {
      primitives: ["size", "primitives"],
      global: ["Global"],
      themes: ["Themes"],
      semantic: ["Semantic"],
      sizes: [] as string[],
    };
    const sources: CollectionSources = { primitives: { primitive: "size", Black: "primitives" } };

    const payloads = buildCleanApplyPayloads(c, names, sources);

    expect(payloads.map((p) => p.collectionId).sort()).toEqual(["primitives", "size"]);
  });
});
