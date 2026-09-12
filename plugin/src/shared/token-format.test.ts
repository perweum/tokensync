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
  isPureRef,
  filterByPaths,
  formatFigmaColor,
  slugifyModeName,
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
// isPureRef
// ────────────────────────────────────────────────────────────────

describe("isPureRef", () => {
  // The single shared copy — figma-variables.ts and figma-text-styles.ts
  // used to each define their own, and this one's regex had drifted from
  // theirs (greedy `.+`, which matches straight through a `}`). Two
  // independently-written copies agreeing on the stricter form was the
  // signal this one was the actual bug.
  it("is true for a single reference", () => {
    expect(isPureRef("{color.brand.600}")).toBe(true);
  });

  it("is false for a literal", () => {
    expect(isPureRef("16px")).toBe(false);
  });

  it("is false for a literal with an embedded ref", () => {
    expect(isPureRef("0 1px 2px {color.black.50}")).toBe(false);
  });

  it("is false for two concatenated refs — not one pure reference", () => {
    expect(isPureRef("{a}{b}")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// filterByPaths
// ────────────────────────────────────────────────────────────────

describe("filterByPaths", () => {
  it("keeps only the paths in the allowlist", () => {
    const flat = {
      "color.a": { $type: "color", $value: "#fff" },
      "color.b": { $type: "color", $value: "#000" },
    };
    expect(Object.keys(filterByPaths(flat, ["color.a"]))).toEqual(["color.a"]);
  });
});

// ────────────────────────────────────────────────────────────────
// formatFigmaColor
// ────────────────────────────────────────────────────────────────

describe("formatFigmaColor", () => {
  // The exact function whose two independently-hand-synced copies
  // (figma-to-tokens.ts push side, useFigmaValues.ts pull side) diverged
  // once already for alpha 0.025 — see figma-to-tokens.ts's DECISIONS.md
  // entry. One shared function now, so there's nothing left to drift.
  it("formats a fully opaque color as hex", () => {
    expect(formatFigmaColor(0, 0, 0, 1)).toBe("#000000");
  });

  it("formats a translucent color as rgba with a direct decimal alpha", () => {
    expect(formatFigmaColor(0, 0, 0, 0.025)).toBe("rgba(0, 0, 0, 0.03)");
  });
});

// ────────────────────────────────────────────────────────────────
// slugifyModeName
// ────────────────────────────────────────────────────────────────

describe("slugifyModeName", () => {
  // The single shared copy — was independently defined 3 times
  // (token-merger.ts, figma-to-tokens.ts, CollectionMapping.tsx). All three
  // must agree exactly, or a file written on push (using one copy) isn't
  // found again on pull/mapping lookups (using another) — the exact bug
  // shape behind the "Mode 1" fix.
  it("lowercases and replaces a space with a hyphen", () => {
    expect(slugifyModeName("Mode 1")).toBe("mode-1");
  });

  it("replaces a slash with a hyphen", () => {
    expect(slugifyModeName("Brand-A/Dark")).toBe("brand-a-dark");
  });

  it("is a no-op (beyond lowercasing) for a name with no space or slash", () => {
    expect(slugifyModeName("Vy")).toBe("vy");
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

describe("resolveReference — circular references", () => {
  // A circular alias (a -> b -> a) previously recursed unboundedly and
  // crashed the whole plugin with a stack overflow — no depth guard or
  // cycle detection at all. Found by comparing against a mature reference
  // implementation (a real Token Studio -> Dart codegen pipeline), which
  // explicitly detects this and reports the exact chain.
  it("returns null instead of recursing forever on a direct cycle (a -> b -> a)", () => {
    const flat = {
      "color.a": { $type: "color", $value: "{color.b}" },
      "color.b": { $type: "color", $value: "{color.a}" },
    };
    expect(resolveReference("{color.a}", flat)).toBeNull();
  });

  it("returns null on a longer cycle (a -> b -> c -> a)", () => {
    const flat = {
      "color.a": { $type: "color", $value: "{color.b}" },
      "color.b": { $type: "color", $value: "{color.c}" },
      "color.c": { $type: "color", $value: "{color.a}" },
    };
    expect(resolveReference("{color.a}", flat)).toBeNull();
  });

  it("leaves a cyclic embedded ref inside a composite value unresolved rather than crashing", () => {
    const flat = {
      "color.a": { $type: "color", $value: "{color.b}" },
      "color.b": { $type: "color", $value: "{color.a}" },
    };
    const result = resolveReference("0 1px 2px {color.a}", flat);
    expect(result).toBe("0 1px 2px {color.a}");
  });

  it("does not false-positive on the same token referenced twice in sibling (non-cyclic) chains", () => {
    // Two independent tokens both aliasing the same shared primitive is
    // normal and must resolve fine — only an actual loop should be rejected.
    const flat = {
      "color.brand.600": { $type: "color", $value: "#1a52d8" },
      "color.a": { $type: "color", $value: "{color.brand.600}" },
      "color.b": { $type: "color", $value: "{color.brand.600}" },
    };
    expect(resolveReference("{color.a}", flat)).toBe("#1a52d8");
    expect(resolveReference("{color.b}", flat)).toBe("#1a52d8");
  });
});

describe("resolveReference — malformed $value in real (uncontrolled) data", () => {
  // A referenced token's own $value can be anything a real Figma file
  // produces — found live testing a design system this project hadn't seen
  // before: a token somewhere in a resolution chain had a non-string $value,
  // and calling .match() on it crashed the whole plugin UI with an uncaught
  // TypeError and no visible error message at all.
  it("returns null instead of crashing when the top-level ref itself isn't a string", () => {
    expect(resolveReference(undefined as unknown as string, {})).toBeNull();
  });

  it("returns null instead of crashing when a referenced token's $value is undefined", () => {
    const flat = {
      "color.a": { $type: "color", $value: "{color.b}" },
      "color.b": { $type: "color", $value: undefined as unknown as string },
    };
    expect(resolveReference("{color.a}", flat)).toBeNull();
  });

  it("leaves an embedded ref unresolved rather than crashing when its target's $value is malformed", () => {
    const flat = {
      "color.a": { $type: "color", $value: null as unknown as string },
    };
    const result = resolveReference("0 1px 2px {color.a}", flat);
    expect(result).toBe("0 1px 2px {color.a}");
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
