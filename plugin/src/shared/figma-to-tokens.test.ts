import { describe, it, expect } from "vitest";
import { figmaToCollections } from "./figma-to-tokens";
import type { FigmaVariable, FigmaVariableCollection } from "./messages";

const figmaCollectionNames = {
  primitives: "Primitives",
  global: "Global",
  themes: "Themes",
  semantic: "Semantic",
};

describe("figmaToCollections — reference resolution", () => {
  // Reproduces the exact shape found in the Coop stress test: a theme token
  // aliasing a primitive, and a semantic token aliasing the theme token through
  // an extra path segment ({color.light.X}, not the special-cased {light.X}).
  // Before this was fixed, `tokens` and `rawTokens` were the same object on the
  // push side, so anything beyond the one special-cased pattern stayed as
  // literal unresolved {ref} text — which leaked straight into generated CSS
  // as an invalid declaration value.
  const collections: FigmaVariableCollection[] = [
    { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: [] },
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

  it("resolves a theme token that aliases a primitive", () => {
    const { collections: result } = figmaToCollections(
      collections,
      variables,
      figmaCollectionNames,
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
      figmaCollectionNames,
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
      figmaCollectionNames,
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
