import { describe, it, expect } from "vitest";
import {
  formatLineHeightCSS,
  formatLetterSpacingCSS,
  formatTextCaseCSS,
  formatTextDecorationCSS,
  formatTypographyField,
  fontStyleSiblings,
  typographyFieldIndex,
} from "./typography-css";

describe("formatLineHeightCSS", () => {
  it("turns the repo's bare-number percent into the unitless ratio CSS expects", () => {
    // "150" means 150% here. Emitted raw, `line-height: 150` is 150x the font size.
    expect(formatLineHeightCSS("150")).toBe("1.5");
    expect(formatLineHeightCSS("140")).toBe("1.4");
    expect(formatLineHeightCSS("100")).toBe("1");
  });

  it("absorbs Figma's float artefact (real value from the Coop repo, 21 times)", () => {
    expect(formatLineHeightCSS("129.99999523162842")).toBe("1.3");
  });

  it("accepts an explicit percent sign", () => {
    expect(formatLineHeightCSS("150%")).toBe("1.5");
  });

  it("keeps a pixel line height as px", () => {
    expect(formatLineHeightCSS("24px")).toBe("24px");
    expect(formatLineHeightCSS("31.5px")).toBe("31.5px");
    expect(formatLineHeightCSS("20.00000001px")).toBe("20px");
  });

  it("leaves anything it doesn't recognise untouched", () => {
    expect(formatLineHeightCSS("normal")).toBe("normal");
    expect(formatLineHeightCSS("calc(1em + 4px)")).toBe("calc(1em + 4px)");
    expect(formatLineHeightCSS("")).toBe("");
  });
});

describe("formatLetterSpacingCSS", () => {
  it("turns percent into em", () => {
    expect(formatLetterSpacingCSS("4")).toBe("0.04em");
    expect(formatLetterSpacingCSS("4%")).toBe("0.04em");
    expect(formatLetterSpacingCSS("-1")).toBe("-0.01em");
    expect(formatLetterSpacingCSS("0.5")).toBe("0.005em");
    expect(formatLetterSpacingCSS("0")).toBe("0em");
  });

  it("rounds the percent, not the em, so small values aren't flattened", () => {
    // Real Coop value. Rounding the em to 3 places would give 0.002em.
    expect(formatLetterSpacingCSS("0.15000000596046448")).toBe("0.0015em");
  });

  it("keeps px as px, and passes an em value through", () => {
    expect(formatLetterSpacingCSS("0px")).toBe("0px");
    expect(formatLetterSpacingCSS("1.5px")).toBe("1.5px");
    expect(formatLetterSpacingCSS("0.02em")).toBe("0.02em");
  });

  it("leaves anything it doesn't recognise untouched", () => {
    expect(formatLetterSpacingCSS("normal")).toBe("normal");
  });
});

describe("formatTextCaseCSS / formatTextDecorationCSS", () => {
  it("maps Figma's words (as stored) to valid text-transform values", () => {
    expect(formatTextCaseCSS("upper")).toBe("uppercase");
    expect(formatTextCaseCSS("UPPER")).toBe("uppercase");
    expect(formatTextCaseCSS("lower")).toBe("lowercase");
    expect(formatTextCaseCSS("title")).toBe("capitalize");
    expect(formatTextCaseCSS("original")).toBe("none");
    expect(formatTextCaseCSS("ORIGINAL")).toBe("none");
  });

  it("passes values that are already valid CSS through", () => {
    expect(formatTextCaseCSS("uppercase")).toBe("uppercase");
    expect(formatTextCaseCSS("capitalize")).toBe("capitalize");
    expect(formatTextCaseCSS("none")).toBe("none");
  });

  it("leaves a case CSS text-transform has no equivalent for as it was", () => {
    expect(formatTextCaseCSS("SMALL_CAPS")).toBe("SMALL_CAPS");
    expect(formatTextCaseCSS("weird")).toBe("weird");
  });

  it("maps decoration, including Figma's STRIKETHROUGH to line-through", () => {
    expect(formatTextDecorationCSS("UNDERLINE")).toBe("underline");
    expect(formatTextDecorationCSS("underline")).toBe("underline");
    expect(formatTextDecorationCSS("STRIKETHROUGH")).toBe("line-through");
    expect(formatTextDecorationCSS("strikethrough")).toBe("line-through");
    expect(formatTextDecorationCSS("line-through")).toBe("line-through");
    expect(formatTextDecorationCSS("none")).toBe("none");
    expect(formatTextDecorationCSS("NONE")).toBe("none");
  });
});

describe("formatTypographyField", () => {
  it("dispatches by field and leaves other fields alone", () => {
    expect(formatTypographyField("lineHeight", "150")).toBe("1.5");
    expect(formatTypographyField("letterSpacing", "4")).toBe("0.04em");
    expect(formatTypographyField("textCase", "upper")).toBe("uppercase");
    expect(formatTypographyField("fontSize", "16px")).toBe("16px");
    expect(formatTypographyField("fontFamily", "GT America")).toBe("GT America");
  });
});

describe("fontStyleSiblings", () => {
  it("emits nothing for a plain, standard-width upright style", () => {
    expect(fontStyleSiblings("typography.body.fontWeight", "Regular", undefined, false)).toEqual(
      [],
    );
  });

  it("replaces the fontWeight segment for a typography field", () => {
    expect(
      fontStyleSiblings("typography.action.fontWeight", "Expanded Medium", undefined, false),
    ).toEqual([["typography.action.fontStretch", "125%"]]);
    expect(
      fontStyleSiblings("typography.action.fontWeight", "Condensed Bold Italic", undefined, false),
    ).toEqual([
      ["typography.action.fontStretch", "75%"],
      ["typography.action.fontStyle", "italic"],
    ]);
  });

  it("appends to the name for a standalone token that isn't called fontWeight", () => {
    expect(
      fontStyleSiblings("font-weight.display.bold", "Expanded Bold", undefined, false),
    ).toEqual([["font-weight.display.bold-fontStretch", "125%"]]);
  });

  it("spells out the defaults when asked, so an override block can reset a base value", () => {
    expect(fontStyleSiblings("typography.body.fontWeight", "Regular", undefined, true)).toEqual([
      ["typography.body.fontStretch", "100%"],
      ["typography.body.fontStyle", "normal"],
    ]);
  });

  it("emits nothing for a name it doesn't recognise (the weight warning covers it)", () => {
    expect(fontStyleSiblings("typography.body.fontWeight", "Text", undefined, false)).toEqual([]);
  });

  it("honours project overrides", () => {
    expect(
      fontStyleSiblings(
        "t.fontWeight",
        "Expanded Medium",
        { stretchKeywords: { expanded: "120%" } },
        false,
      ),
    ).toEqual([["t.fontStretch", "120%"]]);
  });
});

describe("typographyFieldIndex", () => {
  it("maps every field path of every marked typography style, across collections", () => {
    const col = (typographyStyles: unknown) => ({ typographyStyles }) as never;
    const index = typographyFieldIndex([
      col([{ path: "typography.body", fields: { lineHeight: {}, fontSize: {} } }]),
      col([{ path: "type.small", fields: { letterSpacing: {} } }]),
      col([]),
    ]);
    expect(index.get("typography.body.lineHeight")).toBe("lineHeight");
    expect(index.get("typography.body.fontSize")).toBe("fontSize");
    expect(index.get("type.small.letterSpacing")).toBe("letterSpacing");
    expect(index.get("typography.body.nope")).toBeUndefined();
  });
});
