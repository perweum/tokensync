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
    // A real Themes collection, so light.background.default / dark.background.default
    // actually exist as referenceable vars — required for the ref to be treated as
    // one at all (see resolveSemanticValue: verified against real targets, not spelling).
    const collections = [
      col(names.themes, "Default", {
        "light.background.default": { $type: "color", $value: "#ffffff" },
        "dark.background.default": { $type: "color", $value: "#ffffff" },
      }),
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
    // :root only ever gets the theme's own vars (--light-*/--dark-*) — the
    // semantic role itself (--background-default) is never independently
    // hoisted there as a plain value; every scheme block still references it.
    expect(css).not.toMatch(/:root \{[^}]*--background-default:/s);
    expect(css).toContain('[data-color-scheme="light"] {\n  --background-default: var(');
  });

  it("generalizes beyond the {light.X}/{dark.X} prefix — a nested alias ({color.light.X}) still becomes var(--*) as long as the target is real", () => {
    // Reproduces Coop's actual shape: the light/dark segment is nested one
    // level deeper than this project's own convention. A plain regex on the
    // ref's spelling would miss this; checking the target actually resolves
    // to a real CSS var does not.
    const collections = [
      col(names.themes, "Default", {
        "color.light.accent.background-default": { $type: "color", $value: "#0552ff" },
        "color.dark.accent.background-default": { $type: "color", $value: "#87a9ff" },
      }),
      col(
        names.semantic,
        "Light",
        { "background.default": { $type: "color", $value: "#0552ff" } },
        {
          "background.default": {
            $type: "color",
            $value: "{color.light.accent.background-default}",
          },
        },
      ),
      col(
        names.semantic,
        "Dark",
        { "background.default": { $type: "color", $value: "#87a9ff" } },
        {
          "background.default": {
            $type: "color",
            $value: "{color.dark.accent.background-default}",
          },
        },
      ),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).toContain("var(--color-light-accent-background-default)");
    expect(css).toContain("var(--color-dark-accent-background-default)");
    expect(css).not.toContain("{color.light.accent.background-default}");
    expect(css).not.toContain("{color.dark.accent.background-default}");
  });

  it("never emits var(--*) for a ref whose target doesn't actually exist — falls back to the resolved literal instead of broken CSS", () => {
    const collections = [
      // No Themes collection at all — {light.background.default} has nothing to point at.
      col(
        names.semantic,
        "Light",
        { "background.default": { $type: "color", $value: "#ffffff" } },
        { "background.default": { $type: "color", $value: "{light.background.default}" } },
      ),
      col(
        names.semantic,
        "Dark",
        { "background.default": { $type: "color", $value: "#111111" } },
        { "background.default": { $type: "color", $value: "{dark.background.default}" } },
      ),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).not.toContain("var(");
    expect(css).not.toContain("{light.background.default}");
    expect(css).toContain('[data-color-scheme="light"] {\n  --background-default: #ffffff;\n}');
    expect(css).toContain('[data-color-scheme="dark"] {\n  --background-default: #111111;\n}');
  });

  it("gives a severity token that aliases a primitive directly the same var(--*) treatment", () => {
    // A severity color that's theme-invariant but still genuinely differs
    // between light/dark should reference the primitive, not bake in a
    // resolved snapshot — same reasoning as the theme-aware case.
    const collections = [
      col(names.primitives, "Value", {
        "color.red.600": { $type: "color", $value: "#c00000" },
        "color.red.400": { $type: "color", $value: "#ff6b6b" },
      }),
      col(
        names.semantic,
        "Light",
        { "color.danger": { $type: "color", $value: "#c00000" } },
        { "color.danger": { $type: "color", $value: "{color.red.600}" } },
      ),
      col(
        names.semantic,
        "Dark",
        { "color.danger": { $type: "color", $value: "#ff6b6b" } },
        { "color.danger": { $type: "color", $value: "{color.red.400}" } },
      ),
    ];

    const css = generateCSS(collections, metadata);

    expect(css).toContain("var(--color-red-600)");
    expect(css).toContain("var(--color-red-400)");
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
