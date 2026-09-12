import { describe, it, expect } from "vitest";
import { toFieldName, toModeTypeName, snapFontWeightStep } from "./naming";

// The shared helper dart.ts and swift.ts both call now — used to be
// independently defined in each file (toDartFieldName/toSwiftFieldName,
// dartClassName/swiftStructName), byte-identical but for their names.

describe("toFieldName", () => {
  it("camelCases a dot path", () => {
    expect(toFieldName("color.brand.500")).toBe("colorBrand500");
  });

  it("prefixes a leading-digit result with an underscore", () => {
    expect(toFieldName("2xl.display.letterSpacing")).toBe("_2xlDisplayLetterspacing");
  });
});

describe("toModeTypeName", () => {
  it("PascalCases a simple mode name", () => {
    expect(toModeTypeName("Light")).toBe("Light");
  });

  it("combines a brand/theme pair and strips a literal 'Default'", () => {
    expect(toModeTypeName("Default/Light")).toBe("Light");
    expect(toModeTypeName("Brand-A/Dark")).toBe("BrandADark");
  });
});

describe("snapFontWeightStep", () => {
  it("snaps to the nearest 100-step", () => {
    expect(snapFontWeightStep(550)).toBe(600);
  });

  it("clamps to the 100-900 range", () => {
    expect(snapFontWeightStep(950)).toBe(900);
    expect(snapFontWeightStep(50)).toBe(100);
  });
});
