import { describe, it, expect } from "vitest";
import { readLiteralField } from "./figma-text-styles";

function fakeStyle(fields: Partial<TextStyle>): TextStyle {
  return fields as TextStyle;
}

describe("readLiteralField — dimension fields need their unit", () => {
  // Reproduces a real bug found live (the single-theme-stresstest push):
  // fontSize/paragraphSpacing/paragraphIndent are all $type "dimension"
  // (TYPOGRAPHY_FIELD_TOKEN_TYPE), the same as every other dimension token
  // in the codebase, all of which carry a "px" suffix — but these three read
  // the bare Figma number with no unit at all. formatCSSValue does no unit
  // fallback, so the committed value produced genuinely invalid CSS:
  // `--typography-h1-fontsize: 48;` instead of `...: 48px;`.
  it('formats fontSize as "48px", not a bare "48"', () => {
    const style = fakeStyle({ fontSize: 48 });
    expect(readLiteralField(style, "fontSize")).toBe("48px");
  });

  it('formats paragraphSpacing as "0px", not a bare "0"', () => {
    const style = fakeStyle({ paragraphSpacing: 0 });
    expect(readLiteralField(style, "paragraphSpacing")).toBe("0px");
  });

  it('formats paragraphIndent as "12px", not a bare "12"', () => {
    const style = fakeStyle({ paragraphIndent: 12 });
    expect(readLiteralField(style, "paragraphIndent")).toBe("12px");
  });
});

describe("readLiteralField — lineHeight keeps its PIXELS/PERCENT unit marker", () => {
  // NOT the same bug as above, even though lineHeight is $type "number" and
  // still carries a "px" suffix — this one is deliberate. The apply-to-Figma
  // direction (applyOneStyle's lineHeight case) uses whether the string ends
  // in "px" to decide PIXELS vs PERCENT when reconstructing Figma's
  // {value, unit} shape (unitFromLiteral). Stripping the suffix here to
  // "match" the dimension fields above would silently turn every
  // PIXELS-mode line-height into PERCENT on the next apply — a real
  // regression this test guards against introducing.
  it("keeps the px suffix for a PIXELS-unit lineHeight", () => {
    const style = fakeStyle({ lineHeight: { value: 58, unit: "PIXELS" } });
    expect(readLiteralField(style, "lineHeight")).toBe("58px");
  });

  it("has no suffix for a PERCENT-unit lineHeight", () => {
    const style = fakeStyle({ lineHeight: { value: 150, unit: "PERCENT" } });
    expect(readLiteralField(style, "lineHeight")).toBe("150");
  });

  it("returns null for an AUTO-unit lineHeight", () => {
    const style = fakeStyle({ lineHeight: { unit: "AUTO" } });
    expect(readLiteralField(style, "lineHeight")).toBe(null);
  });
});
