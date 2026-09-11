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

describe("buildFigmaFlatMaps — color alpha formatting matches figma-to-tokens.ts's push side", () => {
  // Reproduces a real bug found live: this file's own rgbaToHex quantized
  // alpha through an 8-bit byte (Math.round(a * 255)) before re-deriving a
  // float for comparison, while figma-to-tokens.ts's rawToTokenValue (push
  // side) keeps alpha as a direct decimal (a.toFixed(2)). The two agree for
  // almost every alpha value, but not 0.025: toFixed(2) rounds it to "0.03"
  // (matching what push had already written to GitHub) while the byte
  // round-trip produces 6/255 ≈ 0.0235 → "0.02" — a permanent false
  // "changed" diff on every single pull, for that one alpha value only.
  const collections: FigmaVariableCollection[] = [
    { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1"] },
  ];

  it('formats alpha 0.025 as "0.03", same as the push-side rounding', () => {
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "color/black-25",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 0.025 } },
        collectionId: "c1",
        collectionName: "Primitives",
      },
    ];

    const [map] = buildFigmaFlatMaps(collections, variables);
    expect(map.values["color.black-25"]).toBe("rgba(0, 0, 0, 0.03)");
    expect(map.rawValues["color.black-25"]).toBe("rgba(0, 0, 0, 0.03)");
  });
});

describe("buildFigmaFlatMaps — rawValues stop at one hop, unlike the fully-resolved values", () => {
  // Supports raw-based diffing (see token-diff.ts): editing one primitive
  // shouldn't make every alias that references it look individually
  // "changed" — only a token whose own {ref} definition actually changed
  // should. That requires knowing what a token aliases, not just its final
  // resolved value, which buildFigmaFlatMaps didn't track at all before.
  it("an alias's raw value is \"{target.path}\", not the resolved final value", () => {
    const collections = [
      { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1"] },
      { id: "c2", name: "Themes", modes: [{ modeId: "m2", name: "Masterbrand" }], variableIds: ["v2"] },
    ];
    const variables: FigmaVariable[] = [
      {
        id: "v1",
        name: "color/blue/600",
        resolvedType: "COLOR",
        valuesByMode: { m1: { r: 0, g: 0.349, b: 0.698, a: 1 } },
        collectionId: "c1",
        collectionName: "Primitives",
      },
      {
        id: "v2",
        name: "theme/border-default",
        resolvedType: "COLOR",
        valuesByMode: { m2: { type: "VARIABLE_ALIAS", id: "v1" } },
        collectionId: "c2",
        collectionName: "Themes",
      },
    ];

    const maps = buildFigmaFlatMaps(collections, variables);
    const theme = maps.find((m) => m.collectionName === "Themes")!;
    expect(theme.values["theme.border-default"]).toBe("#0059b2"); // fully resolved
    expect(theme.rawValues["theme.border-default"]).toBe("{color.blue.600}"); // one hop only
  });

  it("a literal's raw value equals its resolved value", () => {
    const collections = [
      { id: "c1", name: "Primitives", modes: [{ modeId: "m1", name: "Value" }], variableIds: ["v1"] },
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
    ];

    const [map] = buildFigmaFlatMaps(collections, variables);
    expect(map.rawValues["opacity.low"]).toBe(map.values["opacity.low"]);
    expect(map.rawValues["opacity.low"]).toBe("30");
  });
});
