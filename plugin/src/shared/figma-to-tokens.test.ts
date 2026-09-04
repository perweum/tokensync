import { describe, it, expect } from "vitest";
import { figmaToCollections, figmaToTokenFiles } from "./figma-to-tokens";
import type { FigmaVariable, FigmaVariableCollection } from "./messages";
import type { CollectionNames, Metadata } from "./token-merger";

const figmaCollectionNames = {
  primitives: ["Primitives"],
  global: ["Global"],
  themes: ["Themes"],
  semantic: ["Semantic"],
  sizes: [],
};

/** figmaToCollections takes the full Metadata (needs `.sizes` for the default
 * size-mode order) — this wraps a bare CollectionNames into a minimal but
 * complete Metadata for tests that don't care about themes/colorSchemes/sizes. */
function metadataFor(collections: CollectionNames, sizes: string[] = []): Metadata {
  return {
    version: "1.0.0",
    themes: ["default"],
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
    const files = figmaToTokenFiles(collections, variables, "tokens/", names);
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
    const files = figmaToTokenFiles(figmaCollections, variables, "tokens/", names);
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
