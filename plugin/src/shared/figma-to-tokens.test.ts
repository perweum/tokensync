import { describe, it, expect } from "vitest";
import { figmaToCollections, figmaToTokenFiles, buildCollectionSources } from "./figma-to-tokens";
import type { FigmaVariable, FigmaVariableCollection } from "./messages";
import type { CollectionNames, Metadata } from "./token-merger";
import type { TypographyStyle } from "./typography-styles";

const figmaCollectionNames = {
  primitives: ["Primitives"],
  global: ["Global"],
  themes: ["Themes"],
  semantic: ["Semantic"],
  sizes: [],
};

/** figmaToCollections takes the full Metadata (needs `.sizes` for the default
 * size-mode order, `.themes` for the default theme) — this wraps a bare
 * CollectionNames into a minimal but complete Metadata for tests that don't
 * care about the rest. */
function metadataFor(
  collections: CollectionNames,
  sizes: string[] = [],
  themes = ["default"],
): Metadata {
  return {
    version: "1.0.0",
    themes,
    colorSchemes: ["light", "dark"],
    sizes,
    figma: { fileKey: "abc", collections },
  };
}

describe("figmaToCollections — reference resolution", () => {
  // Reproduces the exact shape found in the Coop stress test: a theme token
  // aliasing a primitive, and a semantic token aliasing the theme token through
  // an extra path segment ({color.light.X}, not the special-cased {light.X}).
  // Before this was fixed, `tokens` and `rawTokens` were the same object on the
  // push side, so anything beyond the one special-cased pattern stayed as
  // literal unresolved {ref} text — which leaked straight into generated CSS
  // as an invalid declaration value.
  const collections: FigmaVariableCollection[] = [
    // Mode intentionally NOT named "Value" — a real Figma collection's single
    // mode can be called anything ("Mode 1" here). A regression where this got
    // silently overwritten with a hardcoded "Value" broke Coop's real push: the
    // diff/selection UI showed the fabricated name, but the actual file-write
    // step matches against Figma's real mode name, so primitives silently
    // dropped out of the PR despite looking selected. See DECISIONS.md.
    { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Mode 1" }], variableIds: [] },
    { id: "c2", name: "Themes", modes: [{ modeId: "m2", name: "Masterbrand" }], variableIds: [] },
    { id: "c3", name: "Semantic", modes: [{ modeId: "m3", name: "Light" }], variableIds: [] },
  ];

  const variables: FigmaVariable[] = [
    {
      id: "v1",
      name: "color/blue/500",
      resolvedType: "COLOR",
      valuesByMode: { m1: { r: 0.02, g: 0.32, b: 1 } },
      collectionId: "c1",
      collectionName: "Primitives",
    },
    {
      id: "v2",
      name: "color/light/accent/background-default",
      resolvedType: "COLOR",
      valuesByMode: { m2: { type: "VARIABLE_ALIAS", id: "v1" } },
      collectionId: "c2",
      collectionName: "Themes",
    },
    {
      id: "v3",
      name: "background/default",
      resolvedType: "COLOR",
      // Nested one level deeper than {light.X} — the pattern that broke.
      valuesByMode: { m3: { type: "VARIABLE_ALIAS", id: "v2" } },
      collectionId: "c3",
      collectionName: "Semantic",
    },
  ];

  it("reports primitives' real Figma mode name, not a fabricated one", () => {
    const { collections: result } = figmaToCollections(
      collections,
      variables,
      metadataFor(figmaCollectionNames),
    );
    const primitives = result.find((c) => c.collectionName === "Primitives")!;
    expect(primitives.modeName).toBe("Mode 1");
  });

  it("resolves a theme token that aliases a primitive", () => {
    const { collections: result } = figmaToCollections(
      collections,
      variables,
      metadataFor(figmaCollectionNames),
    );
    const theme = result.find((c) => c.collectionName === "Themes")!;

    expect(theme.tokens["color.light.accent.background-default"].$value).toBe("#0552ff");
    // rawTokens must still preserve the alias, for file writes and the CSS var() cascade.
    expect(theme.rawTokens["color.light.accent.background-default"].$value).toBe(
      "{color.blue.500}",
    );
  });

  it("resolves a semantic token through a two-hop alias chain (semantic -> theme -> primitive)", () => {
    const { collections: result } = figmaToCollections(
      collections,
      variables,
      metadataFor(figmaCollectionNames),
    );
    const semantic = result.find((c) => c.collectionName === "Semantic")!;

    // The bug: this used to still be the literal string
    // "{color.light.accent.background-default}" — invalid as a CSS value.
    expect(semantic.tokens["background.default"].$value).toBe("#0552ff");
    expect(semantic.rawTokens["background.default"].$value).toBe(
      "{color.light.accent.background-default}",
    );
  });

  it("never mutates rawTokens while resolving tokens", () => {
    const { collections: result } = figmaToCollections(
      collections,
      variables,
      metadataFor(figmaCollectionNames),
    );
    for (const col of result) {
      for (const [path, raw] of Object.entries(col.rawTokens)) {
        if (raw.$value.startsWith("{")) {
          // Every ref in rawTokens must remain a ref — only `tokens` resolves.
          expect(col.tokens[path]).toBeDefined();
        }
      }
    }
  });
});

describe("figmaToCollections — multiple physical collections mapped to one role", () => {
  // Reproduces a real production shape: Figma's one-mode-axis-per-collection
  // limit forces "main color" and "support color" to be separate physical
  // collections, both mapped to the "themes" role, each with a mode literally
  // named "Christmas". They must merge into one Christmas entry — not become
  // two separate ResolvedCollections that would both render as the same
  // [data-theme="christmas"] CSS selector with only half the tokens each.
  const names = {
    primitives: ["Primitives"],
    global: [] as string[],
    themes: ["Main Color", "Support Color"],
    semantic: [] as string[],
    sizes: [] as string[],
  };

  const collections = [
    { id: "c1", name: "Main Color", modes: [{ modeId: "m1", name: "Christmas" }], variableIds: [] },
    {
      id: "c2",
      name: "Support Color",
      modes: [{ modeId: "m2", name: "Christmas" }],
      variableIds: [],
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

  it("merges same-named modes from different physical collections into one ResolvedCollection", () => {
    const { collections: result } = figmaToCollections(collections, variables, metadataFor(names));
    const christmas = result.filter((c) => c.modeName === "Christmas");
    expect(christmas).toHaveLength(1);
    expect(christmas[0].tokens["color.primary"].$value).toBe("#ff0000");
    expect(christmas[0].tokens["color.accent"].$value).toBe("#00ff00");
  });

  it("writes one merged file instead of the second collection silently overwriting the first at the same path", () => {
    const { files } = figmaToTokenFiles(collections, variables, "tokens/", names);
    const christmasFiles = files.filter(
      (f) => f.repoPath === "tokens/semantic/themes/christmas.json",
    );
    expect(christmasFiles).toHaveLength(1);
    expect(christmasFiles[0].content).toContain('"primary"');
    expect(christmasFiles[0].content).toContain('"accent"');
  });
});

describe("figmaToCollections/figmaToTokenFiles — Size axis on Primitives", () => {
  // Reproduces the real bug found in production: folding a genuinely
  // multi-mode "Size" collection into the (single-mode-assumption)
  // "primitives" role produced silently different values in the committed
  // JSON vs the generated CSS, because the two code paths picked a different
  // mode (modes[0] vs whichever mode a naive merge processed last). Size
  // must be its own role with real per-mode handling instead.
  const names = {
    primitives: ["Primitives"],
    global: [] as string[],
    themes: [] as string[],
    semantic: [] as string[],
    sizes: ["Size"],
  };

  const figmaCollections = [
    { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: [] },
    {
      id: "c2",
      name: "Size",
      modes: [
        { modeId: "m2", name: "Mobile" },
        { modeId: "m3", name: "Desktop" },
      ],
      variableIds: [],
    },
  ];

  const variables: FigmaVariable[] = [
    {
      id: "v1",
      name: "color/brand/500",
      resolvedType: "COLOR",
      valuesByMode: { m1: { r: 0, g: 0, b: 1 } },
      collectionId: "c1",
      collectionName: "Primitives",
    },
    {
      id: "v2",
      name: "font-size/1",
      resolvedType: "FLOAT",
      valuesByMode: { m2: 11, m3: 12 },
      collectionId: "c2",
      collectionName: "Size",
    },
  ];

  it("emits one primitives ResolvedCollection per size mode, each with the correct distinct value", () => {
    const { collections: result } = figmaToCollections(
      figmaCollections,
      variables,
      metadataFor(names, ["mobile", "desktop"]),
    );
    const primitivesCols = result.filter((c) => c.collectionName === "Primitives");
    expect(primitivesCols).toHaveLength(2);

    const mobile = primitivesCols.find((c) => c.modeName === "Mobile")!;
    const desktop = primitivesCols.find((c) => c.modeName === "Desktop")!;
    expect(mobile.tokens["font-size.1"].$value).toBe("11px");
    expect(desktop.tokens["font-size.1"].$value).toBe("12px");
    // Shared, size-invariant primitive present in both.
    expect(mobile.tokens["color.brand.500"].$value).toBe("#0000ff");
    expect(desktop.tokens["color.brand.500"].$value).toBe("#0000ff");
  });

  it("writes one primitives/sizes/{mode}.json per size mode, distinct from the flat primitives files", () => {
    const { files } = figmaToTokenFiles(figmaCollections, variables, "tokens/", names);
    const mobileFile = files.find((f) => f.repoPath === "tokens/primitives/sizes/mobile.json");
    const desktopFile = files.find((f) => f.repoPath === "tokens/primitives/sizes/desktop.json");
    expect(mobileFile?.content).toContain('"$value": "11px"');
    expect(desktopFile?.content).toContain('"$value": "12px"');

    // The shared primitive still goes to the ordinary flat file, unaffected.
    const colorFile = files.find((f) => f.repoPath === "tokens/primitives/color.json");
    expect(colorFile?.content).toContain('"$value": "#0000ff"');
  });

  it("falls back to a single 'Value'-mode primitives collection when no Size collection is mapped", () => {
    const namesWithoutSizes = { ...names, sizes: [] };
    const collectionsWithoutSize = [figmaCollections[0]]; // just "Primitives"
    const { collections: result } = figmaToCollections(
      collectionsWithoutSize,
      [variables[0]],
      metadataFor(namesWithoutSizes),
    );
    const primitivesCols = result.filter((c) => c.collectionName === "Primitives");
    expect(primitivesCols).toHaveLength(1);
    expect(primitivesCols[0].modeName).toBe("Value");
  });
});

describe("figmaToCollections — default theme for Semantic resolution is chosen by metadata.themes", () => {
  // Figma's own Themes collection mode order has nothing to do with
  // metadata.themes — a semantic token must still resolve against the
  // *configured* default theme, not whichever mode Figma happened to list
  // first.
  const names = {
    primitives: ["Primitives"],
    global: [] as string[],
    themes: ["Themes"],
    semantic: ["Semantic"],
    sizes: [] as string[],
  };

  const figmaCollections = [
    {
      id: "c1",
      name: "Themes",
      // Christmas listed first in Figma — unrelated to metadata.themes' order.
      modes: [
        { modeId: "m1", name: "Christmas" },
        { modeId: "m2", name: "Original" },
      ],
      variableIds: [],
    },
    { id: "c2", name: "Semantic", modes: [{ modeId: "m3", name: "Light" }], variableIds: [] },
  ];

  const variables: FigmaVariable[] = [
    {
      id: "v1",
      name: "color/accent",
      resolvedType: "COLOR",
      valuesByMode: { m1: { r: 0.75, g: 0, b: 0 }, m2: { r: 0, g: 0.26, b: 1 } },
      collectionId: "c1",
      collectionName: "Themes",
    },
    {
      id: "v2",
      name: "background/default",
      resolvedType: "COLOR",
      valuesByMode: { m3: { type: "VARIABLE_ALIAS", id: "v1" } },
      collectionId: "c2",
      collectionName: "Semantic",
    },
  ];

  it("resolves Semantic against metadata.themes[0] ('original'), not Figma's first-listed mode ('Christmas')", () => {
    const { collections: result } = figmaToCollections(
      figmaCollections,
      variables,
      metadataFor(names, [], ["original", "christmas"]),
    );
    const semantic = result.find((c) => c.collectionName === "Semantic")!;
    // #0042ff would mean it resolved against Christmas instead of Original.
    expect(semantic.tokens["background.default"].$value).toBe("#0042ff");
  });
});

describe("figmaToTokenFiles — real Figma Text Styles pushed into typography.json", () => {
  const names = {
    primitives: [] as string[],
    global: ["Global"],
    themes: [] as string[],
    semantic: [] as string[],
    sizes: [] as string[],
  };

  it("adds the group-level $type marker onto a group that already exists via decomposed Variables", () => {
    const collections: FigmaVariableCollection[] = [
      { id: "c1", name: "Global", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1"] },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "text/heading/display/fontSize",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 32 },
        collectionId: "c1",
        collectionName: "Global",
      },
    ];
    const typographyStyles: TypographyStyle[] = [
      {
        path: "text.heading.display",
        fields: { fontSize: { $type: "dimension", $value: "32px" } },
      },
    ];

    const { files } = figmaToTokenFiles(collections, variables, "tokens/", names, typographyStyles);
    const typoFile = files.find((f) => f.repoPath === "tokens/semantic/global/typography.json")!;
    const tree = JSON.parse(typoFile.content);

    expect(tree.text.heading.display.$type).toBe("typography");
    expect(tree.text.heading.display.fontSize.$value).toBe("32px");
  });

  it("writes a typography.json group from Text Style fields alone when no matching Variable exists", () => {
    // Reproduces the actual gap being fixed: a Text Style created by hand in
    // Figma, with fields that were never separately decomposed into
    // Variables (in particular textCase/textDecoration, which Figma doesn't
    // support binding to a Variable at all, so they can ONLY ever reach the
    // file through this path).
    const collections: FigmaVariableCollection[] = [
      { id: "c1", name: "Global", modes: [{ modeId: "m1", name: "Value" }], variableIds: [] },
    ];
    const variables: FigmaVariable[] = [];
    const typographyStyles: TypographyStyle[] = [
      {
        path: "text.heading.caption",
        fields: {
          fontFamily: { $type: "fontFamily", $value: "Arial" },
          textCase: { $type: "string", $value: "uppercase" },
        },
      },
    ];

    const { files } = figmaToTokenFiles(collections, variables, "tokens/", names, typographyStyles);
    const typoFile = files.find((f) => f.repoPath === "tokens/semantic/global/typography.json")!;
    const tree = JSON.parse(typoFile.content);

    expect(tree.text.heading.caption.$type).toBe("typography");
    expect(tree.text.heading.caption.fontFamily.$value).toBe("Arial");
    expect(tree.text.heading.caption.textCase.$value).toBe("uppercase");
  });

  it("writes nothing typography-related when there are no typography-tagged Variables and no Text Styles", () => {
    const collections: FigmaVariableCollection[] = [
      { id: "c1", name: "Global", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1"] },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "spacing/small",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 4 },
        collectionId: "c1",
        collectionName: "Global",
      },
    ];

    const { files } = figmaToTokenFiles(collections, variables, "tokens/", names, []);
    expect(files.some((f) => f.repoPath === "tokens/semantic/global/typography.json")).toBe(false);
  });

  it("does not overwrite an existing Variable-derived alias in the committed file when the Text Style field reads as an unbound literal", () => {
    // File-writing counterpart to the figmaToCollections test above — the
    // committed JSON must keep the real alias too, not just the diff.
    const collections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
      { id: "c2", name: "Global", modes: [{ modeId: "m2", name: "Value" }], variableIds: ["v2"] },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "primitive/font-size/11",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 48 },
        collectionId: "c1",
        collectionName: "Primitives",
      },
      {
        id: "v2",
        name: "text/banner/fontSize",
        resolvedType: "FLOAT",
        valuesByMode: { m2: { type: "VARIABLE_ALIAS", id: "v1" } },
        collectionId: "c2",
        collectionName: "Global",
      },
    ];
    const namesWithPrimitives = { ...names, primitives: ["Primitives"] };
    const typographyStyles: TypographyStyle[] = [
      { path: "text.banner", fields: { fontSize: { $type: "dimension", $value: "48px" } } },
    ];

    const { files } = figmaToTokenFiles(
      collections,
      variables,
      "tokens/",
      namesWithPrimitives,
      typographyStyles,
    );
    const typoFile = files.find((f) => f.repoPath === "tokens/semantic/global/typography.json")!;
    const tree = JSON.parse(typoFile.content);

    expect(tree.text.banner.fontSize.$value).toBe("{primitive.font-size.11}");
  });
});

describe("figmaToCollections — real Figma Text Styles are diffable, not just written to file", () => {
  // The push diff view is built from figmaToCollections' output (see
  // computePushDiff in sync-logic.ts) — a field only shows as a reviewable
  // change if it's present in the flat token map here, entirely separate
  // from figmaToTokenFiles' file-writing path above.
  const names = {
    primitives: [] as string[],
    global: ["Global"],
    themes: [] as string[],
    semantic: [] as string[],
    sizes: [] as string[],
  };

  it("includes a Text Style field with no backing Variable in the Global collection's flat tokens", () => {
    const typographyStyles: TypographyStyle[] = [
      {
        path: "text.heading.caption",
        fields: { textCase: { $type: "string", $value: "uppercase" } },
      },
    ];

    const { collections } = figmaToCollections([], [], metadataFor(names), typographyStyles);
    const global = collections.find((c) => c.collectionName === "Global")!;

    expect(global).toBeDefined();
    expect(global.tokens["text.heading.caption.textCase"].$value).toBe("uppercase");
  });

  it("resolves a Text Style field that's a ref into a primitive, same as any other Global token", () => {
    const collections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "fontFamily/sans",
        resolvedType: "STRING",
        valuesByMode: { m1: "Inter" },
        collectionId: "c1",
        collectionName: "Primitives",
      },
    ];
    const namesWithPrimitives = { ...names, primitives: ["Primitives"] };
    const typographyStyles: TypographyStyle[] = [
      {
        path: "text.heading.display",
        fields: { fontFamily: { $type: "fontFamily", $value: "{fontFamily.sans}" } },
      },
    ];

    const { collections: result } = figmaToCollections(
      collections,
      variables,
      metadataFor(namesWithPrimitives),
      typographyStyles,
    );
    const global = result.find((c) => c.collectionName === "Global")!;

    expect(global.tokens["text.heading.display.fontFamily"].$value).toBe("Inter");
  });

  it("resolves a Text Style field that's a ref into a theme-scoped group, not just Primitives", () => {
    // Reproduces a real bug found live: the actual reference chain is
    // fontFamily (Primitives) -> Theme (e.g. Masterbrand) -> type styles —
    // a theme picks its own named font choice ({font-family.display}), and
    // a Text Style field references *that*, not a primitive directly. The
    // Global collection's resolution context here never merged in any theme
    // (only Semantic did), so this ref had nothing to resolve against and
    // stayed as the literal unresolved string in the push diff — showing a
    // false "changed" entry (GitHub's already-fixed resolved value vs.
    // Figma's still-literal one) even when nothing had actually changed.
    const collections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
      {
        id: "c2",
        name: "Theme",
        modes: [{ modeId: "m2", name: "Masterbrand" }],
        variableIds: ["v2"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "fontFamily/coop-sans",
        resolvedType: "STRING",
        valuesByMode: { m1: "Coop Sans" },
        collectionId: "c1",
        collectionName: "Primitives",
      },
      {
        id: "v2",
        name: "font-family/display",
        resolvedType: "STRING",
        valuesByMode: { m2: { type: "VARIABLE_ALIAS", id: "v1" } },
        collectionId: "c2",
        collectionName: "Theme",
      },
    ];
    const namesWithThemes = { ...names, primitives: ["Primitives"], themes: ["Theme"] };
    const typographyStyles: TypographyStyle[] = [
      {
        path: "typography.banner",
        fields: { fontFamily: { $type: "fontFamily", $value: "{font-family.display}" } },
      },
    ];

    const { collections: result } = figmaToCollections(
      collections,
      variables,
      metadataFor(namesWithThemes, [], ["masterbrand"]),
      typographyStyles,
    );
    const global = result.find((c) => c.collectionName === "Global")!;

    expect(global.tokens["typography.banner.fontFamily"].$value).toBe("Coop Sans");
  });

  it('falls back to a literal "Global" collection name when no Figma collection is mapped to that role', () => {
    // Reproduces a real bug found live against a production Figma file: a
    // project whose only typography source is Text Styles (no decomposed
    // Variables ever set up) has figma.collections.global === [] — the
    // previous code used figmaCollectionNames.global[0] directly, which came
    // out `undefined` and rendered as a blank push-diff tab label (the row
    // still showed a change count, just no title).
    const namesWithNoGlobalRole = { ...names, global: [] as string[] };
    const typographyStyles: TypographyStyle[] = [
      {
        path: "text.heading.caption",
        fields: { textCase: { $type: "string", $value: "uppercase" } },
      },
    ];

    const { collections } = figmaToCollections(
      [],
      [],
      metadataFor(namesWithNoGlobalRole),
      typographyStyles,
    );

    expect(collections.some((c) => c.collectionName === "Global")).toBe(true);
    expect(collections.some((c) => c.collectionName === undefined)).toBe(false);
  });

  it("does not let an unbound Text Style field clobber an existing Variable-derived alias", () => {
    // Reproduces the exact live bug (tokensync-coop-stresstest PR #35): a
    // Global-role fontSize Variable is a real alias into a size-varying
    // primitive, but Figma's Text Style read reported the same field as an
    // unbound literal with no user-initiated change at all — silently baking
    // a dead value over a live one in both the diff and the committed file.
    const collections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
      { id: "c2", name: "Global", modes: [{ modeId: "m2", name: "Value" }], variableIds: ["v2"] },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "primitive/font-size/11",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 48 },
        collectionId: "c1",
        collectionName: "Primitives",
      },
      {
        id: "v2",
        name: "typography/banner/fontSize",
        resolvedType: "FLOAT",
        valuesByMode: { m2: { type: "VARIABLE_ALIAS", id: "v1" } },
        collectionId: "c2",
        collectionName: "Global",
      },
    ];
    const namesWithGlobal = { ...names, primitives: ["Primitives"], global: ["Global"] };
    const typographyStyles: TypographyStyle[] = [
      {
        path: "typography.banner",
        // What getLocalTypographyStyles reports when Figma's read shows the
        // field as unbound — a plain literal, same shape as readLiteralField.
        fields: { fontSize: { $type: "dimension", $value: "48px" } },
      },
    ];

    const { collections: result } = figmaToCollections(
      collections,
      variables,
      metadataFor(namesWithGlobal),
      typographyStyles,
    );
    const global = result.find((c) => c.collectionName === "Global")!;

    expect(global.rawTokens["typography.banner.fontSize"].$value).toBe("{primitive.font-size.11}");
  });
});

describe('figmaToCollections — a "ghost" alias (right name, dead target id) is reported, not silently dropped', () => {
  // Confirmed live (Vy's Spor system): a Theme-collection color variable's
  // VARIABLE_ALIAS pointed at a target id that no longer resolves to any
  // real variable — the target was deleted/recreated and the alias's id was
  // never repointed. Figma's own variable picker still showed the intended
  // target's name correctly (looked completely normal), but the field was
  // silently missing from every synced output, with zero trace anywhere,
  // making it extremely hard to diagnose from the sync side alone.
  const names = {
    primitives: ["Foundation"],
    global: [] as string[],
    themes: ["Theme"],
    semantic: [] as string[],
    sizes: [] as string[],
  };

  it("reports the path as a broken alias and excludes it from tokens, instead of silently dropping it", () => {
    const collections: FigmaVariableCollection[] = [
      {
        id: "cTheme",
        name: "Theme",
        modes: [{ modeId: "mVy", name: "Vy" }],
        variableIds: ["vSuccess"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "vSuccess",
        name: "Light/surface/success/default",
        resolvedType: "COLOR",
        // "vDeleted" is not in `variables` at all — a dangling target id.
        valuesByMode: { mVy: { type: "VARIABLE_ALIAS", id: "vDeleted" } },
        collectionId: "cTheme",
        collectionName: "Theme",
      },
    ];

    const { collections: result, brokenAliasPaths } = figmaToCollections(
      collections,
      variables,
      metadataFor(names),
    );
    const theme = result.find((c) => c.collectionName === "Theme")!;

    expect(brokenAliasPaths).toEqual(["Light.surface.success.default"]);
    expect(theme.tokens["Light.surface.success.default"]).toBeUndefined();
  });

  it("does not report a variable that simply has no value for this mode", () => {
    // A variable can legitimately have no value set for a given mode — not
    // every "no value" case is a broken alias, only a dangling VARIABLE_ALIAS
    // target specifically.
    const collections: FigmaVariableCollection[] = [
      {
        id: "cTheme",
        name: "Theme",
        modes: [{ modeId: "mVy", name: "Vy" }],
        variableIds: ["vUnset"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "vUnset",
        name: "Light/surface/unset/default",
        resolvedType: "COLOR",
        valuesByMode: {},
        collectionId: "cTheme",
        collectionName: "Theme",
      },
    ];

    const { brokenAliasPaths } = figmaToCollections(collections, variables, metadataFor(names));

    expect(brokenAliasPaths).toEqual([]);
  });

  it("does not report a genuinely working alias", () => {
    const collections: FigmaVariableCollection[] = [
      {
        id: "cFoundation",
        name: "Foundation",
        modes: [{ modeId: "mF", name: "Value" }],
        variableIds: ["vPrimitive"],
      },
      {
        id: "cTheme",
        name: "Theme",
        modes: [{ modeId: "mVy", name: "Vy" }],
        variableIds: ["vCore"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "vPrimitive",
        name: "color/green/100",
        resolvedType: "COLOR",
        valuesByMode: { mF: { r: 0.8, g: 0.95, b: 0.9 } },
        collectionId: "cFoundation",
        collectionName: "Foundation",
      },
      {
        id: "vCore",
        name: "Light/surface/core/active",
        resolvedType: "COLOR",
        valuesByMode: { mVy: { type: "VARIABLE_ALIAS", id: "vPrimitive" } },
        collectionId: "cTheme",
        collectionName: "Theme",
      },
    ];
    const namesWithPrimitives = { ...names, primitives: ["Foundation"] };

    const { brokenAliasPaths } = figmaToCollections(
      collections,
      variables,
      metadataFor(namesWithPrimitives),
    );

    expect(brokenAliasPaths).toEqual([]);
  });
});

describe("figmaToTokenFiles — a variable name structurally collides with another (a leaf and a group at the same path)", () => {
  // Confirmed live (Vy's Spor system): "Light/surface/brand" (a real, standalone
  // variable) coexisted with "Light/surface/brand/default" / "/active" / "/hover"
  // (a real group) — both legal Figma variable names, but a nested JSON tree
  // cannot represent both at once. Depending purely on which variable Figma
  // happened to return last, this either silently destroyed the entire group
  // (the flat one written last wins, group data gone) or produced an invalid
  // hybrid object that's both a leaf and a group (the flat one written first,
  // then children merged directly onto it) — neither was visible anywhere.
  const names = {
    primitives: [] as string[],
    global: [] as string[],
    themes: ["Theme"],
    semantic: [] as string[],
    sizes: [] as string[],
  };

  function makeCollisionVars(order: "flat-first" | "group-first"): FigmaVariable[] {
    const flat: FigmaVariable = {
      id: "vFlat",
      name: "Light/surface/brand",
      resolvedType: "COLOR",
      valuesByMode: { m1: { r: 0, g: 0.5, b: 0 } },
      collectionId: "cTheme",
      collectionName: "Theme",
    };
    const groupVars: FigmaVariable[] = [
      {
        id: "vDefault",
        name: "Light/surface/brand/default",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0.1, g: 0.6, b: 0.1 } },
        collectionId: "cTheme",
        collectionName: "Theme",
      },
      {
        id: "vActive",
        name: "Light/surface/brand/active",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0.2, g: 0.7, b: 0.2 } },
        collectionId: "cTheme",
        collectionName: "Theme",
      },
    ];
    return order === "flat-first" ? [flat, ...groupVars] : [...groupVars, flat];
  }

  const collections: FigmaVariableCollection[] = [
    { id: "cTheme", name: "Theme", modes: [{ modeId: "m1", name: "Vy" }], variableIds: [] },
  ];

  it("never produces an invalid hybrid object, regardless of which variable Figma returns first", () => {
    for (const order of ["flat-first", "group-first"] as const) {
      const { files } = figmaToTokenFiles(collections, makeCollisionVars(order), "tokens/", names);
      const themeFile = files.find((f) => f.repoPath === "tokens/semantic/themes/vy.json")!;
      const brand = JSON.parse(themeFile.content).Light.surface.brand;

      // Never both at once: either a clean leaf ($value, no children) or a
      // clean group (children, no $value of its own) — never a corrupted mix.
      const isLeaf = "$value" in brand;
      const isGroup = "default" in brand || "active" in brand;
      expect(isLeaf && isGroup).toBe(false);
    }
  });

  it("reports the losing path in conflictPaths instead of silently dropping it", () => {
    const { conflictPaths } = figmaToTokenFiles(
      collections,
      makeCollisionVars("group-first"),
      "tokens/",
      names,
    );
    expect(conflictPaths.length).toBeGreaterThan(0);
    expect(conflictPaths).toContain("Light.surface.brand");
  });

  it("does not report a conflict for ordinary, non-colliding variable names", () => {
    const variables: FigmaVariable[] = [
      {
        id: "vCore",
        name: "Light/surface/core/active",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0.1, g: 0.1, b: 0.1 } },
        collectionId: "cTheme",
        collectionName: "Theme",
      },
      {
        id: "vAccent",
        name: "Light/surface/accent/default",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0.2, g: 0.2, b: 0.2 } },
        collectionId: "cTheme",
        collectionName: "Theme",
      },
    ];

    const { conflictPaths } = figmaToTokenFiles(collections, variables, "tokens/", names);

    expect(conflictPaths).toEqual([]);
  });
});

describe("buildCollectionSources", () => {
  const names = {
    primitives: ["size", "primitives"],
    global: ["Global"],
    themes: ["Themes"],
    semantic: ["Semantic"],
    sizes: [] as string[],
  };

  it("records which real collection each top-level segment came from, for a role backed by two collections", () => {
    // The exact real-world shape that exposed the bug: "size" (font-size,
    // multi-mode) and "primitives" (colors) both mapped to the primitives role.
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "primitive/font-size/1",
        resolvedType: "FLOAT",
        valuesByMode: {},
        collectionId: "c1",
        collectionName: "size",
      },
      {
        id: "v2",
        name: "Black/100",
        resolvedType: "COLOR",
        valuesByMode: {},
        collectionId: "c2",
        collectionName: "primitives",
      },
      {
        id: "v3",
        name: "Blue/100",
        resolvedType: "COLOR",
        valuesByMode: {},
        collectionId: "c2",
        collectionName: "primitives",
      },
    ];

    const sources = buildCollectionSources(variables, names);

    expect(sources.primitives).toEqual({
      primitive: "size",
      Black: "primitives",
      Blue: "primitives",
    });
  });

  it("skips variables from collections mapped to no role at all", () => {
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "dominant/background-default",
        resolvedType: "COLOR",
        valuesByMode: {},
        collectionId: "c1",
        collectionName: "main color", // not listed under any role — "Ignore" in Map Collections
      },
    ];

    const sources = buildCollectionSources(variables, names);

    expect(sources.primitives ?? {}).toEqual({});
    expect(sources.themes ?? {}).toEqual({});
  });
});

describe("figmaToTokenFiles — STRING variable type inference", () => {
  const names = {
    primitives: ["Primitives"],
    global: [] as string[],
    themes: [] as string[],
    semantic: [] as string[],
    sizes: [] as string[],
  };

  it("classifies a STRING fontWeight variable as fontWeight, not fontFamily", () => {
    // Real bug found live: "fontWeight/light" also matches /family|font/i
    // (it contains "font"), so without a "weight" check first, every named
    // STRING weight ("Light", "Bold", ...) was misclassified as fontFamily.
    // Named weights are STRING in real usage, not FLOAT — see the
    // fontWeight/fontStyle decision in DECISIONS.md.
    const collections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "fontWeight/light",
        resolvedType: "STRING",
        valuesByMode: { m1: "Light" },
        collectionId: "c1",
        collectionName: "Primitives",
      },
    ];

    const { files } = figmaToTokenFiles(collections, variables, "tokens/", names);
    const tree = JSON.parse(files[0].content);

    expect(tree.fontWeight.light.$type).toBe("fontWeight");
    expect(tree.fontWeight.light.$value).toBe("Light");
  });

  it("still classifies a genuine fontFamily variable as fontFamily", () => {
    const collections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "fontFamily/sans",
        resolvedType: "STRING",
        valuesByMode: { m1: "Inter" },
        collectionId: "c1",
        collectionName: "Primitives",
      },
    ];

    const { files } = figmaToTokenFiles(collections, variables, "tokens/", names);
    const tree = JSON.parse(files[0].content);

    expect(tree.fontFamily.sans.$type).toBe("fontFamily");
  });
});

describe("figmaToTokenFiles — FLOAT variable type inference", () => {
  const names = {
    primitives: ["Primitives"],
    global: [] as string[],
    themes: [] as string[],
    semantic: [] as string[],
    sizes: [] as string[],
  };

  it('classifies a FLOAT variable literally named "dimension" as dimension, not number', () => {
    // Real bug found live: a variable group literally named "dimension"
    // (e.g. "dimension/0") didn't match the FLOAT-classification regex
    // (size|spacing|padding|radius|width|height|border|gap) — none of those
    // keywords appear in the word "dimension" itself — so it fell through to
    // "number", which formats without a "px" suffix. Every pull then showed
    // a permanent false "changed" diff (e.g. Figma's live "0px" vs GitHub's
    // stored "0"), even though the numeric value never actually changed.
    const collections: FigmaVariableCollection[] = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "dimension/0",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 4 },
        collectionId: "c1",
        collectionName: "Primitives",
      },
    ];

    const { files } = figmaToTokenFiles(collections, variables, "tokens/", names);
    const tree = JSON.parse(files[0].content);

    expect(tree.dimension["0"].$type).toBe("dimension");
    expect(tree.dimension["0"].$value).toBe("4px");
  });
});
