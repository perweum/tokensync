import { describe, it, expect } from "vitest";
import {
  flattenTokens,
  resolveReference,
  resolveAllReferences,
  toCSSVar,
  toFigmaVarName,
  fromFigmaVarName,
  isTokenValue,
  isTokenTree,
} from "./token-format";
import type { TokenTree } from "./messages";

// ────────────────────────────────────────────────────────────────
// isTokenValue / isTokenTree
// ────────────────────────────────────────────────────────────────

describe("isTokenValue", () => {
  it("returns true when $value is present", () => {
    expect(isTokenValue({ $value: "#fff", $type: "color" })).toBe(true);
  });

  it("returns false for a tree node", () => {
    expect(isTokenValue({ brand: { $value: "#fff", $type: "color" } })).toBe(false);
  });

  it("returns false for null / primitives", () => {
    expect(isTokenValue(null)).toBe(false);
    expect(isTokenValue("string")).toBe(false);
  });
});

describe("isTokenTree", () => {
  it("returns true for a group with no $value", () => {
    expect(isTokenTree({ brand: { $value: "#fff", $type: "color" } })).toBe(true);
  });

  it("returns false when $value is present", () => {
    expect(isTokenTree({ $value: "#fff", $type: "color" })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// flattenTokens
// ────────────────────────────────────────────────────────────────

describe("flattenTokens", () => {
  const tree: TokenTree = {
    color: {
      brand: {
        600: { $type: "color", $value: "#1a52d8" },
        700: { $type: "color", $value: "#143fb5" },
      },
      white: {
        950: { $type: "color", $value: "#ffffff" },
      },
    },
  };

  it("flattens nested tree to dot-notation keys", () => {
    const flat = flattenTokens(tree);
    expect(flat).toHaveProperty("color.brand.600");
    expect(flat).toHaveProperty("color.brand.700");
    expect(flat).toHaveProperty("color.white.950");
  });

  it("preserves $value", () => {
    const flat = flattenTokens(tree);
    expect(flat["color.brand.600"].$value).toBe("#1a52d8");
  });

  it("preserves $type", () => {
    const flat = flattenTokens(tree);
    expect(flat["color.brand.600"].$type).toBe("color");
  });

  it("skips $-prefixed group-level fields", () => {
    const treeWithGroupType: TokenTree = {
      $type: "color" as any,
      brand: { 500: { $value: "#blue", $type: "color" } },
    };
    const flat = flattenTokens(treeWithGroupType);
    expect(flat).not.toHaveProperty("$type");
    expect(flat).toHaveProperty("brand.500");
  });

  it("propagates group-level $type to tokens without their own", () => {
    const tree2: TokenTree = {
      geometry: {
        $type: "dimension" as any,
        size: {
          sm: { $value: "8px", $type: "dimension" },
          md: { $value: "16px", $type: "dimension" },
        },
      } as any,
    };
    const flat = flattenTokens(tree2);
    expect(flat["geometry.size.sm"].$type).toBe("dimension");
  });

  it("returns empty object for empty tree", () => {
    expect(flattenTokens({})).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────
// resolveReference
// ────────────────────────────────────────────────────────────────

describe("resolveReference", () => {
  const flat = {
    "color.brand.600": { $type: "color", $value: "#1a52d8" },
    "color.brand.700": { $type: "color", $value: "#143fb5" },
    "color.alias": { $type: "color", $value: "{color.brand.600}" },
  };

  it("resolves a pure reference", () => {
    expect(resolveReference("{color.brand.600}", flat)).toBe("#1a52d8");
  });

  it("resolves a chained reference", () => {
    expect(resolveReference("{color.alias}", flat)).toBe("#1a52d8");
  });

  it("returns null for a missing pure reference", () => {
    expect(resolveReference("{color.does-not-exist}", flat)).toBeNull();
  });

  it("returns literal strings unchanged", () => {
    expect(resolveReference("#1a52d8", flat)).toBe("#1a52d8");
  });

  it("resolves embedded refs inside composite values (e.g. shadow)", () => {
    const shadow = flat as any;
    shadow["color.black.50"] = { $type: "color", $value: "rgba(0,0,0,0.05)" };
    const result = resolveReference("0 1px 2px {color.black.50}", shadow as any);
    expect(result).toBe("0 1px 2px rgba(0,0,0,0.05)");
  });

  it("leaves unresolvable embedded refs as-is", () => {
    const result = resolveReference("0 1px 2px {color.missing}", flat);
    expect(result).toBe("0 1px 2px {color.missing}");
  });
});

// ────────────────────────────────────────────────────────────────
// resolveAllReferences
// ────────────────────────────────────────────────────────────────

describe("resolveAllReferences", () => {
  it("resolves all references in a flat map", () => {
    const flat = {
      "color.brand.600": { $type: "color", $value: "#1a52d8" },
      "semantic.primary": { $type: "color", $value: "{color.brand.600}" },
    };
    const resolved = resolveAllReferences(flat);
    expect(resolved["semantic.primary"].$value).toBe("#1a52d8");
    expect(resolved["color.brand.600"].$value).toBe("#1a52d8");
  });

  it("leaves non-reference values unchanged", () => {
    const flat = {
      "color.brand.600": { $type: "color", $value: "#1a52d8" },
    };
    expect(resolveAllReferences(flat)["color.brand.600"].$value).toBe("#1a52d8");
  });

  it("leaves unresolvable references as-is", () => {
    const flat = {
      "semantic.unknown": { $type: "color", $value: "{color.missing}" },
    };
    const resolved = resolveAllReferences(flat);
    expect(resolved["semantic.unknown"].$value).toBe("{color.missing}");
  });

  it("preserves $type on resolved tokens", () => {
    const flat = {
      "color.brand.600": { $type: "color", $value: "#1a52d8" },
      "semantic.primary": { $type: "color", $value: "{color.brand.600}" },
    };
    expect(resolveAllReferences(flat)["semantic.primary"].$type).toBe("color");
  });
});

// ────────────────────────────────────────────────────────────────
// toCSSVar
// ────────────────────────────────────────────────────────────────

describe("toCSSVar", () => {
  it("converts dot-notation to CSS custom property", () => {
    expect(toCSSVar("color.base.brand.default")).toBe("--color-base-brand-default");
  });

  it("works for short paths", () => {
    expect(toCSSVar("radius.md")).toBe("--radius-md");
  });

  it("respects custom prefix", () => {
    expect(toCSSVar("color.brand", "--sys-")).toBe("--sys-color-brand");
  });
});

// ────────────────────────────────────────────────────────────────
// toFigmaVarName / fromFigmaVarName
// ────────────────────────────────────────────────────────────────

describe("toFigmaVarName", () => {
  it("converts dot-notation to slash-notation", () => {
    expect(toFigmaVarName("color.base.brand.default")).toBe("color/base/brand/default");
  });
});

describe("fromFigmaVarName", () => {
  it("converts slash-notation to dot-notation", () => {
    expect(fromFigmaVarName("color/base/brand/default")).toBe("color.base.brand.default");
  });

  it("roundtrips with toFigmaVarName", () => {
    const path = "color.base.brand.default";
    expect(fromFigmaVarName(toFigmaVarName(path))).toBe(path);
  });
});
