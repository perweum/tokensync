import { describe, it, expect } from "vitest";
import {
  FIGMA_BINDABLE_FIELD,
  resolveTextCase,
  resolveTextDecoration,
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
