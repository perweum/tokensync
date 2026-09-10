import { describe, it, expect } from "vitest";
import { buildFigmaFlatMaps } from "./useFigmaValues";
import type { FigmaVariable, FigmaVariableCollection } from "../../shared/messages";

describe("buildFigmaFlatMaps — number formatting only appends \"px\" for genuine dimensions", () => {
  // Reproduces a real bug found live: this file had its own, separate
  // number-formatting logic from figma-to-tokens.ts's type-aware
  // rawToTokenValue — it appended "px" to *every* FLOAT value unconditionally,
  // regardless of the variable's real type. A plain number token like
  // opacity.low (a bare percentage, "30", not a pixel dimension) then
  // permanently mismatched GitHub's correctly bare-number value on every
  // pull, even though nothing had actually changed.
  const collections: FigmaVariableCollection[] = [
    { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1", "v2"] },
  ];

  it("does not append \"px\" to a plain number variable (e.g. opacity)", () => {
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "opacity/low",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 30 },
        collectionId: "c1",
        collectionName: "Primitives",
      },
    ];

    const [map] = buildFigmaFlatMaps(collections, variables);
    expect(map.values["opacity.low"]).toBe("30");
  });

  it("still appends \"px\" to a genuine dimension variable", () => {
    const variables: FigmaVariable[] = [
      {
        id: "v2",
        name: "dimension/0",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 4 },
        collectionId: "c1",
        collectionName: "Primitives",
      },
    ];

    const [map] = buildFigmaFlatMaps(collections, variables);
    expect(map.values["dimension.0"]).toBe("4px");
  });

  it("decides px-or-not from the alias TARGET's own name/type, not the aliasing variable's", () => {
    const aliasCollections: FigmaVariableCollection[] = [
      { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1"] },
      { id: "c2", name: "Semantic", modes: [{ modeId: "m2", name: "Light" }], variableIds: ["v2"] },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "opacity/low",
        resolvedType: "FLOAT",
        valuesByMode: { m1: 30 },
        collectionId: "c1",
        collectionName: "Primitives",
      },
      {
        id: "v2",
        name: "semantic/overlay-value", // name alone gives no dimension hint either way
        resolvedType: "FLOAT",
        valuesByMode: { m2: { type: "VARIABLE_ALIAS", id: "v1" } },
        collectionId: "c2",
        collectionName: "Semantic",
      },
    ];

    const maps = buildFigmaFlatMaps(aliasCollections, variables);
    const semantic = maps.find((m) => m.collectionName === "Semantic")!;
    expect(semantic.values["semantic.overlay-value"]).toBe("30");
  });
});
