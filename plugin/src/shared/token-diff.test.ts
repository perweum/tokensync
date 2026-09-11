import { describe, it, expect } from "vitest";
import { diffTokens, buildCollectionDiff, groupByCategory } from "./token-diff";
import type { TokenValue } from "./messages";

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

function tok(value: string, type = "color"): TokenValue {
  return { $type: type, $value: value };
}

// ────────────────────────────────────────────────────────────────
// diffTokens — status derivation
// ────────────────────────────────────────────────────────────────

describe("diffTokens — status derivation", () => {
  it("marks tokens present in github but absent in figma as added", () => {
    const github = { "color.brand.600": tok("#1a52d8") };
    const figma = {};
    const entries = diffTokens(github, figma);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("added");
  });

  it("marks tokens absent in github but present in figma as removed", () => {
    const github = {};
    const figma = { "color.brand.600": "#1a52d8" };
    const entries = diffTokens(github, figma);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("removed");
  });

  it("marks tokens with identical values as unchanged (excluded from result)", () => {
    const github = { "color.brand.600": tok("#1a52d8") };
    const figma = { "color.brand.600": "#1a52d8" };
    const entries = diffTokens(github, figma);
    expect(entries).toHaveLength(0);
  });

  it("marks tokens with different values as changed", () => {
    const github = { "color.brand.600": tok("#1a52d8") };
    const figma = { "color.brand.600": "#ff0000" };
    const entries = diffTokens(github, figma);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("changed");
  });

  it("handles multiple tokens in a single diff", () => {
    const github = {
      "color.brand.600": tok("#1a52d8"),
      "color.brand.700": tok("#143fb5"),
      "color.removed": tok("#aaa"),
    };
    const figma = {
      "color.brand.600": "#ff0000",
      "color.brand.700": "#143fb5",
      "color.figmaOnly": "#bbb",
    };
    const entries = diffTokens(github, figma);
    const statuses = Object.fromEntries(entries.map((e) => [e.path, e.status]));
    expect(statuses["color.brand.600"]).toBe("changed");
    expect(statuses["color.removed"]).toBe("added");
    expect(statuses["color.figmaOnly"]).toBe("removed");
    expect(statuses["color.brand.700"]).toBeUndefined(); // unchanged
  });
});

// ────────────────────────────────────────────────────────────────
// diffTokens — colour normalisation
// ────────────────────────────────────────────────────────────────

describe("diffTokens — colour normalisation", () => {
  it("treats hex case-insensitively as unchanged", () => {
    const github = { "color.brand.600": tok("#1A52D8") };
    const figma = { "color.brand.600": "#1a52d8" };
    expect(diffTokens(github, figma)).toHaveLength(0);
  });

  it("normalises rgba() and #rrggbb to the same representation", () => {
    // rgba(255,0,0,1) === #ff0000
    const github = { "color.bg": tok("rgba(255, 0, 0, 1)") };
    const figma = { "color.bg": "#ff0000" };
    expect(diffTokens(github, figma)).toHaveLength(0);
  });

  it("treats rgba with near-1 alpha as opaque hex", () => {
    const github = { "color.bg": tok("rgba(255, 0, 0, 0.9999)") };
    const figma = { "color.bg": "#ff0000" };
    expect(diffTokens(github, figma)).toHaveLength(0);
  });

  it("rounds alpha to 2dp to absorb float precision drift", () => {
    // 229/255 ≈ 0.898…  should round to 0.9 and match
    const github = { "color.overlay": tok("rgba(0,0,0,0.9)") };
    const figma = { "color.overlay": "#000000e5" }; // e5 = 229/255 ≈ 0.898
    expect(diffTokens(github, figma)).toHaveLength(0);
  });

  it("detects genuinely different colours as changed", () => {
    const github = { "color.bg": tok("#ff0000") };
    const figma = { "color.bg": "#0000ff" };
    expect(diffTokens(github, figma)[0].status).toBe("changed");
  });
});

// ────────────────────────────────────────────────────────────────
// diffTokens — dimension normalisation
// ────────────────────────────────────────────────────────────────

describe("diffTokens — dimension normalisation", () => {
  it("treats 16.00px and 16px as unchanged", () => {
    const github = { "size.md": tok("16.00px", "dimension") };
    const figma = { "size.md": "16px" };
    expect(diffTokens(github, figma)).toHaveLength(0);
  });

  it("detects genuine size changes", () => {
    const github = { "size.md": tok("16px", "dimension") };
    const figma = { "size.md": "8px" };
    expect(diffTokens(github, figma)[0].status).toBe("changed");
  });
});

// ────────────────────────────────────────────────────────────────
// diffTokens — rawTokens parameter
// ────────────────────────────────────────────────────────────────

describe("diffTokens — rawTokens", () => {
  it("exposes githubRawValue from rawTokens when provided", () => {
    const github = { "semantic.primary": tok("#1a52d8") };
    const raw = { "semantic.primary": tok("{color.brand.600}") };
    const figma = { "semantic.primary": "#ff0000" };
    const [entry] = diffTokens(github, figma, raw);
    expect(entry.githubRawValue).toBe("{color.brand.600}");
  });

  it("falls back githubRawValue to resolved value when no rawTokens", () => {
    const github = { "semantic.primary": tok("#1a52d8") };
    const figma = { "semantic.primary": "#ff0000" };
    const [entry] = diffTokens(github, figma);
    expect(entry.githubRawValue).toBe("#1a52d8");
  });
});

// ────────────────────────────────────────────────────────────────
// diffTokens — raw-based comparison (figmaRawValues)
// ────────────────────────────────────────────────────────────────

describe("diffTokens — comparison is based on raw values, not resolved ones", () => {
  // Reproduces a real UX problem found live: editing one primitive
  // (color.blue.300) made every theme token that referenced it show as
  // "changed" too — dozens of entries across every brand, for one edit.
  // Comparing raw (one-hop) values instead of fully-resolved ones means a
  // token whose own {ref} definition didn't change stays "unchanged," even
  // though its effective resolved value shifted along with the primitive.
  it("stays unchanged when both sides reference the same {ref}, even if that ref's resolved value differs", () => {
    const github = { "theme.border": tok("{color.blue.300}") };
    const rawTokens = { "theme.border": tok("{color.blue.300}") };
    // Figma's resolved value has already changed (e.g. blue.300 was edited),
    // but the token's own definition — the alias itself — never did.
    const figma = { "theme.border": "#ff00ff" };
    const figmaRawValues = { "theme.border": "{color.blue.300}" };

    const entries = diffTokens(github, figma, rawTokens, figmaRawValues);
    expect(entries).toHaveLength(0);
  });

  it("shows changed, with the raw {ref} strings, when the alias target itself changes", () => {
    const github = { "theme.border": tok("{color.blue.600}") };
    const rawTokens = { "theme.border": tok("{color.blue.600}") };
    const figma = { "theme.border": "#0059b2" }; // resolved color.blue.600
    const figmaRawValues = { "theme.border": "{color.blue.500}" }; // Figma still points at .500

    const [entry] = diffTokens(github, figma, rawTokens, figmaRawValues);
    expect(entry.status).toBe("changed");
    expect(entry.githubRawValue).toBe("{color.blue.600}");
    expect(entry.figmaRawValue).toBe("{color.blue.500}");
  });

  it("still shows changed for a genuine literal value edit, with no ref involved", () => {
    const github = { "color.blue.300": tok("#ff00ff") };
    const figma = { "color.blue.300": "#57abff" };
    const figmaRawValues = { "color.blue.300": "#57abff" };

    const [entry] = diffTokens(github, figma, undefined, figmaRawValues);
    expect(entry.status).toBe("changed");
    expect(entry.githubRawValue).toBe("#ff00ff");
    expect(entry.figmaRawValue).toBe("#57abff");
  });
});

// ────────────────────────────────────────────────────────────────
// diffTokens — sorting
// ────────────────────────────────────────────────────────────────

describe("diffTokens — sort order", () => {
  it("sorts changed before added before removed", () => {
    const github = {
      "a.changed": tok("#new"),
      "b.added": tok("#added"),
    };
    const figma = {
      "a.changed": "#old",
      "c.removed": "#removed",
    };
    const entries = diffTokens(github, figma);
    const statuses = entries.map((e) => e.status);
    const firstChanged = statuses.indexOf("changed");
    const firstAdded = statuses.indexOf("added");
    const firstRemoved = statuses.indexOf("removed");
    expect(firstChanged).toBeLessThan(firstAdded);
    expect(firstAdded).toBeLessThan(firstRemoved);
  });
});

// ────────────────────────────────────────────────────────────────
// buildCollectionDiff
// ────────────────────────────────────────────────────────────────

describe("buildCollectionDiff", () => {
  it("returns correct counts", () => {
    const github = {
      "color.a": tok("#new"),
      "color.b": tok("#same"),
      "color.c": tok("#added"),
    };
    const figma = {
      "color.a": "#old",
      "color.b": "#same",
      "color.removed": "#removed",
    };
    const diff = buildCollectionDiff("Primitives", "Value", github, figma);
    expect(diff.counts.changed).toBe(1);
    expect(diff.counts.added).toBe(1);
    expect(diff.counts.removed).toBe(1);
    expect(diff.counts.total).toBe(3);
  });

  it("attaches collectionName and modeName", () => {
    const diff = buildCollectionDiff("Primitives", "Value", {}, {});
    expect(diff.collectionName).toBe("Primitives");
    expect(diff.modeName).toBe("Value");
  });
});

// ────────────────────────────────────────────────────────────────
// groupByCategory
// ────────────────────────────────────────────────────────────────

describe("groupByCategory", () => {
  it("groups by first path segment", () => {
    const github = {
      "background.default": tok("#fff"),
      "background.subtle": tok("#f8f8f8"),
      "text.default": tok("#000"),
    };
    const figma = {
      "background.default": "#old",
      "background.subtle": "#oldf",
      "text.default": "#oldblack",
    };
    const entries = diffTokens(github, figma);
    const grouped = groupByCategory(entries);
    expect(grouped.has("background")).toBe(true);
    expect(grouped.has("text")).toBe(true);
    expect(grouped.get("background")?.length).toBe(2);
    expect(grouped.get("text")?.length).toBe(1);
  });
});
