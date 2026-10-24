import { describe, it, expect } from "vitest";
import { resolveFontWeightNumber, parseFontStyleName, DEFAULT_FONT_WEIGHT } from "./font-weight";

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
    expect(resolveFontWeightNumber("Expanded Heavyish")).toBeNull();
  });

  it("reads the weight out of a name that also carries width and/or italic", () => {
    // Used to be null (-> 400 plus a warning) for anything but a bare weight
    // word, so "Expanded Medium" silently became Regular on every platform.
    expect(resolveFontWeightNumber("Black Italic")).toBe(900);
    expect(resolveFontWeightNumber("Expanded Medium")).toBe(500);
    expect(resolveFontWeightNumber("Condensed Bold Italic")).toBe(700);
  });

  it("exposes 400 as the documented default fallback", () => {
    expect(DEFAULT_FONT_WEIGHT).toBe(400);
  });
});

describe("parseFontStyleName", () => {
  const parse = parseFontStyleName;

  it("reads a plain weight as standard width, upright", () => {
    expect(parse("Regular")).toEqual({
      weight: 400,
      stretch: null,
      style: "normal",
      recognized: true,
    });
    expect(parse("Bold")).toEqual({
      weight: 700,
      stretch: null,
      style: "normal",
      recognized: true,
    });
    expect(parse("Standard")).toEqual({
      weight: 400,
      stretch: null,
      style: "normal",
      recognized: true,
    });
  });

  it("separates weight, width and italic", () => {
    expect(parse("Medium Italic")).toMatchObject({ weight: 500, stretch: null, style: "italic" });
    expect(parse("Expanded Medium")).toMatchObject({
      weight: 500,
      stretch: "125%",
      style: "normal",
    });
    expect(parse("Condensed Bold Italic")).toMatchObject({
      weight: 700,
      stretch: "75%",
      style: "italic",
    });
  });

  it("knows every width GT America ships", () => {
    expect(parse("Compressed Thin").stretch).toBe("62.5%");
    expect(parse("Condensed Light").stretch).toBe("75%");
    expect(parse("Extended Black").stretch).toBe("112.5%");
    expect(parse("Expanded Regular").stretch).toBe("125%");
  });

  it("is case-, spacing- and punctuation-insensitive, and handles multi-word weights", () => {
    expect(parse("ULTRA LIGHT")).toMatchObject({ weight: 200 });
    expect(parse("semi-bold italic")).toMatchObject({ weight: 600, style: "italic" });
    expect(parse("ExpandedSemiBold")).toMatchObject({ weight: 600, stretch: "125%" });
    expect(parse("Expanded_Extra Bold")).toMatchObject({ weight: 800, stretch: "125%" });
  });

  it("treats width/italic with no weight word as regular weight", () => {
    expect(parse("Expanded")).toMatchObject({ weight: 400, stretch: "125%", recognized: true });
    expect(parse("Italic")).toMatchObject({ weight: 400, style: "italic", recognized: true });
  });

  it("accepts a numeric weight, alone or with a width", () => {
    expect(parse("600")).toMatchObject({ weight: 600, recognized: true });
    expect(parse("Condensed 700")).toMatchObject({ weight: 700, stretch: "75%" });
  });

  it("never throws on an unknown name: falls back to 400 and says it wasn't recognised", () => {
    expect(parse("Text")).toEqual({
      weight: 400,
      stretch: null,
      style: "normal",
      recognized: false,
    });
    expect(parse("")).toMatchObject({ weight: 400, recognized: false });
    expect(parse("Expanded Heavyish")).toMatchObject({ weight: 400, recognized: false });
    expect(parse("0")).toMatchObject({ recognized: false });
    expect(parse("1001")).toMatchObject({ recognized: false });
  });

  it("lets metadata.json's fontStyles override the parser, by exact or normalised name", () => {
    const overrides = {
      fontStyles: { "Ext Md": { weight: 500, stretch: "125%", style: "normal" as const } },
    };
    expect(parse("Ext Md", overrides)).toEqual({
      weight: 500,
      stretch: "125%",
      style: "normal",
      recognized: true,
    });
    expect(parse("ext-md", overrides)).toMatchObject({ weight: 500, stretch: "125%" });
  });

  it("fills a partial override from the parser, so only what's listed changes", () => {
    const overrides = { fontStyles: { "Expanded Medium": { stretch: "120%" } } };
    expect(parse("Expanded Medium", overrides)).toMatchObject({ weight: 500, stretch: "120%" });
  });

  it("lets fontStretchKeywords change a width's percentage, and a 100% keyword mean the default", () => {
    expect(parse("Expanded Medium", { stretchKeywords: { expanded: "120%" } }).stretch).toBe(
      "120%",
    );
    expect(parse("Expanded Medium", { stretchKeywords: { expanded: "100%" } }).stretch).toBeNull();
  });

  it("recognises a width keyword the project adds", () => {
    const o = { stretchKeywords: { wide: "140%" } };
    expect(parse("Wide Bold", o)).toMatchObject({ weight: 700, stretch: "140%", recognized: true });
  });
});
