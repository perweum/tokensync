import { describe, it, expect } from "vitest";
import { resolveFontWeightNumber, DEFAULT_FONT_WEIGHT } from "./font-weight";

describe("resolveFontWeightNumber", () => {
  it("resolves DTCG's own kebab-case aliases", () => {
    expect(resolveFontWeightNumber("thin")).toBe(100);
    expect(resolveFontWeightNumber("extra-light")).toBe(200);
    expect(resolveFontWeightNumber("semi-bold")).toBe(600);
    expect(resolveFontWeightNumber("bold")).toBe(700);
    expect(resolveFontWeightNumber("extra-black")).toBe(950);
  });

  it("resolves Figma-style PascalCase and spaced style names", () => {
    expect(resolveFontWeightNumber("Regular")).toBe(400);
    expect(resolveFontWeightNumber("Medium")).toBe(500);
    expect(resolveFontWeightNumber("SemiBold")).toBe(600);
    expect(resolveFontWeightNumber("Semi Bold")).toBe(600);
    expect(resolveFontWeightNumber("Bold")).toBe(700);
    expect(resolveFontWeightNumber("ExtraBold")).toBe(800);
  });

  it("resolves this repo's actual primitive weight values", () => {
    // tokens/primitives/typography.json — named to match Figma's style names
    expect(resolveFontWeightNumber("Regular")).toBe(400);
    expect(resolveFontWeightNumber("Medium")).toBe(500);
    expect(resolveFontWeightNumber("SemiBold")).toBe(600);
    expect(resolveFontWeightNumber("Bold")).toBe(700);
  });

  it("accepts a raw numeric weight in range", () => {
    expect(resolveFontWeightNumber("600")).toBe(600);
    expect(resolveFontWeightNumber("1")).toBe(1);
    expect(resolveFontWeightNumber("1000")).toBe(1000);
  });

  it("rejects out-of-range numbers", () => {
    expect(resolveFontWeightNumber("0")).toBeNull();
    expect(resolveFontWeightNumber("1001")).toBeNull();
  });

  it("returns null for a font-specific style name with no numeric equivalent", () => {
    expect(resolveFontWeightNumber("Text")).toBeNull();
    expect(resolveFontWeightNumber("Black Italic")).toBeNull();
  });

  it("exposes 400 as the documented default fallback", () => {
    expect(DEFAULT_FONT_WEIGHT).toBe(400);
  });
});
