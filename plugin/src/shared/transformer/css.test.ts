import { describe, it, expect } from "vitest";
import { generateCSS } from "./css";
import type { ResolvedCollection } from "../token-merger";
import type { Metadata } from "../token-merger";

const names = {
  primitives: "Primitives",
  global: "Global",
  themes: "Themes",
  semantic: "Semantic",
};
const metadata: Metadata = {
  version: "1.0.0",
  themes: ["default"],
  colorSchemes: ["light", "dark"],
  figma: { fileKey: "abc", collections: names },
};

function col(
  collectionName: string,
  modeName: string,
  tokens: ResolvedCollection["tokens"],
  rawTokens: ResolvedCollection["rawTokens"] = tokens,
): ResolvedCollection {
  return { collectionName, modeName, tokens, rawTokens, typographyStyles: [] };
}

describe("generateCSS — semantic light/dark deduplication", () => {
  it("hoists a value identical in both schemes into :root, and omits it from both scheme blocks", () => {
    const collections = [
      col(names.semantic, "Light", {
        "spacing.gap": { $type: "dimension", $value: "16px" },
      }),
      col(names.semantic, "Dark", {
        "spacing.gap": { $type: "dimension", $value: "16px" },
      }),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).toContain(":root {\n  --spacing-gap: 16px;\n}");
    expect(css).not.toMatch(/\[data-color-scheme="light"\][^}]*spacing-gap/s);
    expect(css).not.toMatch(/\[data-color-scheme="dark"\][^}]*spacing-gap/s);
  });

  it("keeps a value that genuinely differs between schemes in both scheme blocks, never in :root", () => {
    const collections = [
      col(names.semantic, "Light", {
        "color.danger": { $type: "color", $value: "#c00000" },
      }),
      col(names.semantic, "Dark", {
        "color.danger": { $type: "color", $value: "#ff6b6b" },
      }),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).toContain('[data-color-scheme="light"] {\n  --color-danger: #c00000;\n}');
    expect(css).toContain('[data-color-scheme="dark"] {\n  --color-danger: #ff6b6b;\n}');
    expect(css).not.toContain(":root {\n  --color-danger");
  });

  it("never hoists a theme-aliased ({light.*}/{dark.*}) token, even if it happens to resolve to the same hex", () => {
    // Both schemes point at a primitive that happens to be the same colour —
    // the raw ref still differs (light.* vs dark.*), so it must never collapse.
    const collections = [
      col(
        names.semantic,
        "Light",
        { "background.default": { $type: "color", $value: "#ffffff" } },
        { "background.default": { $type: "color", $value: "{light.background.default}" } },
      ),
      col(
        names.semantic,
        "Dark",
        { "background.default": { $type: "color", $value: "#ffffff" } },
        { "background.default": { $type: "color", $value: "{dark.background.default}" } },
      ),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).toContain("var(--light-background-default)");
    expect(css).toContain("var(--dark-background-default)");
    expect(css).not.toContain(":root {\n  --background-default");
  });
});

describe("generateCSS — non-default theme deduplication", () => {
  it("omits a non-default theme override when it matches the default theme", () => {
    const collections = [
      col(names.themes, "Default", {
        "color.primary": { $type: "color", $value: "#0142fe" },
      }),
      col(names.themes, "BrandB", {
        "color.primary": { $type: "color", $value: "#0142fe" },
      }),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).toContain(":root {\n  --color-primary: #0142fe;\n}");
    expect(css).not.toMatch(/\[data-theme="brandb"\][^}]*color-primary/s);
  });

  it("only the theme that actually differs gets an override — identical-to-default is never treated as global by accident", () => {
    // 3 themes: BrandB matches Default, BrandC does not. BrandB must stay
    // silent (inherits from :root); BrandC must get its own override.
    const collections = [
      col(names.themes, "Default", { "color.accent": { $type: "color", $value: "#111111" } }),
      col(names.themes, "BrandB", { "color.accent": { $type: "color", $value: "#111111" } }),
      col(names.themes, "BrandC", { "color.accent": { $type: "color", $value: "#222222" } }),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).toContain(":root {\n  --color-accent: #111111;\n}");
    expect(css).not.toMatch(/\[data-theme="brandb"\][^}]*color-accent/s);
    expect(css).toContain('[data-theme="brandc"] {\n  --color-accent: #222222;\n}');
  });

  it("does not hoist a value two non-default themes happen to share with each other but not the default", () => {
    // Known scope boundary: dedup only compares each theme against the
    // default, not every theme against every other. BrandB and BrandC both
    // legitimately get their own (matching) override rather than being
    // collapsed into one — correct, just not maximally deduplicated.
    const collections = [
      col(names.themes, "Default", { "color.accent": { $type: "color", $value: "#111111" } }),
      col(names.themes, "BrandB", { "color.accent": { $type: "color", $value: "#333333" } }),
      col(names.themes, "BrandC", { "color.accent": { $type: "color", $value: "#333333" } }),
    ];

    const css = generateCSS(collections, metadata);

    // :root always carries the default theme's own value, unaffected by this case.
    expect(css).toContain(":root {\n  --color-accent: #111111;\n}");
    // Both non-default themes independently get their own (matching) override —
    // not incorrectly collapsed into one, and not left out of either block.
    expect(css).toContain('[data-theme="brandb"] {\n  --color-accent: #333333;\n}');
    expect(css).toContain('[data-theme="brandc"] {\n  --color-accent: #333333;\n}');
  });
});
