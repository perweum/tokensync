import { describe, it, expect } from "vitest";
import {
  FIGMA_BINDABLE_FIELD,
  resolveTextCase,
  resolveTextDecoration,
  formatUnitValue,
  unitFromLiteral,
  describeFontStyleMismatch,
} from "./text-style-figma-fields";

describe("FIGMA_BINDABLE_FIELD", () => {
  it("maps fontWeight to Figma's fontStyle field — verified against a real Figma file", () => {
    // Figma's own "fontWeight" field rejects a STRING variable outright; see
    // docs/design/text-styles-stage0-spike.md for the confirmed error message.
    expect(FIGMA_BINDABLE_FIELD.fontWeight).toBe("fontStyle");
  });

  it("maps every other bindable field 1:1", () => {
    expect(FIGMA_BINDABLE_FIELD.fontFamily).toBe("fontFamily");
    expect(FIGMA_BINDABLE_FIELD.fontSize).toBe("fontSize");
    expect(FIGMA_BINDABLE_FIELD.lineHeight).toBe("lineHeight");
    expect(FIGMA_BINDABLE_FIELD.letterSpacing).toBe("letterSpacing");
    expect(FIGMA_BINDABLE_FIELD.paragraphSpacing).toBe("paragraphSpacing");
    expect(FIGMA_BINDABLE_FIELD.paragraphIndent).toBe("paragraphIndent");
  });

  it("excludes textCase and textDecoration — Figma cannot bind them", () => {
    expect(FIGMA_BINDABLE_FIELD.textCase).toBeUndefined();
    expect(FIGMA_BINDABLE_FIELD.textDecoration).toBeUndefined();
  });
});

describe("resolveTextCase", () => {
  it("resolves CSS-familiar spellings", () => {
    expect(resolveTextCase("uppercase")).toBe("UPPER");
    expect(resolveTextCase("lowercase")).toBe("LOWER");
    expect(resolveTextCase("capitalize")).toBe("TITLE");
    expect(resolveTextCase("none")).toBe("ORIGINAL");
  });

  it("resolves Figma's own enum spellings case-insensitively, round-tripping the read path", () => {
    expect(resolveTextCase("UPPER")).toBe("UPPER");
    expect(resolveTextCase("upper")).toBe("UPPER");
    expect(resolveTextCase("SMALL_CAPS")).toBe("SMALL_CAPS");
    expect(resolveTextCase("small_caps")).toBe("SMALL_CAPS");
  });

  it("returns null for an unrecognized value", () => {
    expect(resolveTextCase("something-else")).toBeNull();
  });
});

describe("resolveTextDecoration", () => {
  it("resolves CSS-familiar spellings, including the hyphenated CSS keyword", () => {
    expect(resolveTextDecoration("underline")).toBe("UNDERLINE");
    expect(resolveTextDecoration("line-through")).toBe("STRIKETHROUGH");
    expect(resolveTextDecoration("none")).toBe("NONE");
  });

  it("resolves Figma's own enum spellings", () => {
    expect(resolveTextDecoration("STRIKETHROUGH")).toBe("STRIKETHROUGH");
  });

  it("returns null for an unrecognized value", () => {
    expect(resolveTextDecoration("wavy")).toBeNull();
  });
});

describe("formatUnitValue / unitFromLiteral — lineHeight/letterSpacing PIXELS-vs-PERCENT round trip", () => {
  // The bug this fixes: a Text Style with PIXELS-based letterSpacing/lineHeight
  // used to always come back out as PERCENT on apply, silently changing an
  // absolute size into a percentage of font size — e.g. 2px became 2% (of a
  // 16px font, 0.32px), a huge, silent visual change.
  it("encodes PERCENT as a bare number — this repo's existing convention, unchanged", () => {
    expect(formatUnitValue({ value: 150, unit: "PERCENT" })).toBe("150");
  });

  it("encodes PIXELS with an explicit px suffix instead of losing the unit", () => {
    expect(formatUnitValue({ value: 2, unit: "PIXELS" })).toBe("2px");
  });

  it("round-trips both units through format -> parse", () => {
    expect(unitFromLiteral(formatUnitValue({ value: 150, unit: "PERCENT" }))).toBe("PERCENT");
    expect(unitFromLiteral(formatUnitValue({ value: 2, unit: "PIXELS" }))).toBe("PIXELS");
  });

  it("defaults a bare number (every token written before this fix) to PERCENT", () => {
    expect(unitFromLiteral("150")).toBe("PERCENT");
    expect(unitFromLiteral("-2")).toBe("PERCENT");
  });
});

describe("formatUnitValue — rounds Figma's float artefacts", () => {
  it("writes 130, not 129.99999523162842, for a 130% line height", () => {
    // Figma stores 130% as 129.99999523162842. That exact value is in the real
    // Coop repo 21 times — noise in every diff and every committed file.
    expect(formatUnitValue({ value: 129.99999523162842, unit: "PERCENT" })).toBe("130");
    expect(formatUnitValue({ value: 0.15000000596046448, unit: "PERCENT" })).toBe("0.15");
  });

  it("rounds pixels too, and keeps the px marker", () => {
    expect(formatUnitValue({ value: 20.0000001, unit: "PIXELS" })).toBe("20px");
    expect(formatUnitValue({ value: 31.5, unit: "PIXELS" })).toBe("31.5px");
  });

  it("leaves ordinary values exactly as they were", () => {
    expect(formatUnitValue({ value: 150, unit: "PERCENT" })).toBe("150");
    expect(formatUnitValue({ value: -0.25, unit: "PERCENT" })).toBe("-0.25");
    expect(formatUnitValue({ value: 0, unit: "PIXELS" })).toBe("0px");
  });
});

describe("lineHeight / letterSpacing round trip: stored value -> Figma -> stored value", () => {
  // The stored tokens stay Figma-native; reading back what was just written must
  // reproduce them byte for byte, or every push would show spurious changes.
  const roundTrip = (stored: string) => {
    const figma = { value: Number(stored.replace("px", "")), unit: unitFromLiteral(stored) };
    return formatUnitValue(figma);
  };

  it.each(["150", "130", "100", "24px", "31.5px", "0", "0px", "0.5", "-1", "-0.25", "4"])(
    "%s survives the trip unchanged",
    (stored) => {
      expect(roundTrip(stored)).toBe(stored);
    },
  );

  it("settles an old unrounded value after one trip, and stays settled", () => {
    const once = roundTrip("129.99999523162842");
    expect(once).toBe("130");
    expect(roundTrip(once)).toBe("130");
  });
});

describe("describeFontStyleMismatch — a font style binding Figma silently ignored", () => {
  // Verified against Figma's Plugin API: binding a STRING variable to fontStyle
  // with a style that isn't installed ("Bold") throws nothing — the style just
  // stays as it was ("Regular"). Without checking afterwards, that looks like
  // a successful apply.
  it("names the font and says what the style was left as", () => {
    expect(describeFontStyleMismatch("Bold", { family: "GT America", style: "Regular" })).toBe(
      `Font "GT America Bold" isn't installed in this Figma file — style kept as "Regular"`,
    );
  });

  it("is silent when the style took effect", () => {
    expect(describeFontStyleMismatch("Bold", { family: "GT America", style: "Bold" })).toBeNull();
  });

  it("ignores spacing, case and punctuation, so a naming difference isn't reported as a failure", () => {
    expect(describeFontStyleMismatch("SemiBold", { family: "F", style: "Semi Bold" })).toBeNull();
    expect(
      describeFontStyleMismatch("expanded medium", { family: "F", style: "Expanded Medium" }),
    ).toBeNull();
  });

  it("has nothing to compare when the intended style is unknown", () => {
    expect(describeFontStyleMismatch(undefined, { family: "F", style: "Regular" })).toBeNull();
    expect(describeFontStyleMismatch("", { family: "F", style: "Regular" })).toBeNull();
  });
});
