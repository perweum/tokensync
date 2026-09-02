import { describe, it, expect } from "vitest";
import { figmaTypeFromTokenType, toFigmaValue } from "./figma-variables";

describe("figmaTypeFromTokenType", () => {
  it("maps numeric token types to a real Figma FLOAT variable", () => {
    // Regression: these previously all mapped to STRING, so applying a spacing/
    // radius/font-size/line-height token created a Figma variable holding the
    // literal text "16px" instead of a numeric variable — unusable for
    // auto-layout gap, corner radius, stroke weight, or a Typography Variable
    // binding. See DECISIONS.md "Priority 1b".
    expect(figmaTypeFromTokenType("dimension")).toBe("FLOAT");
    expect(figmaTypeFromTokenType("number")).toBe("FLOAT");
  });

  it("keeps fontWeight as STRING — Figma stores the installed font style name verbatim", () => {
    expect(figmaTypeFromTokenType("fontWeight")).toBe("STRING");
  });

  it("keeps the other established mappings", () => {
    expect(figmaTypeFromTokenType("color")).toBe("COLOR");
    expect(figmaTypeFromTokenType("boolean")).toBe("BOOLEAN");
    expect(figmaTypeFromTokenType("fontFamily")).toBe("STRING");
    expect(figmaTypeFromTokenType("string")).toBe("STRING");
    expect(figmaTypeFromTokenType("shadow")).toBe("STRING");
    expect(figmaTypeFromTokenType("unknown-type")).toBeNull();
  });
});

describe("toFigmaValue with FLOAT", () => {
  it("parses a dimension value into a real number", () => {
    expect(toFigmaValue("16px", "FLOAT")).toBe(16);
    expect(toFigmaValue("1.5rem", "FLOAT")).toBe(1.5);
  });

  it("parses a unitless number value", () => {
    // e.g. lineHeight "150", letterSpacing "-2" in this repo's typography.json
    expect(toFigmaValue("150", "FLOAT")).toBe(150);
    expect(toFigmaValue("-2", "FLOAT")).toBe(-2);
  });
});
