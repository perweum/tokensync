import { describe, it, expect } from "vitest";
import { parseRepository } from "./token-merger";
import type { GitHubFile } from "./messages";

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function file(path: string, content: object): GitHubFile {
  return { path, content: JSON.stringify(content), sha: "abc" };
}

const tokensPath = "tokens";

// Minimal valid repository layout
const primitiveColor = {
  color: {
    brand: {
      500: { $type: "color", $value: "#0142FE" },
      600: { $type: "color", $value: "#003ee0" },
    },
    neutral: {
      50: { $type: "color", $value: "#f8fafc" },
      950: { $type: "color", $value: "#0f172a" },
    },
    white: { 950: { $type: "color", $value: "#ffffff" } },
    black: { 950: { $type: "color", $value: "#000000" } },
  },
};

const defaultTheme = {
  light: {
    background: {
      default: { $type: "color", $value: "{color.white.950}" },
    },
    text: {
      default: { $type: "color", $value: "{color.neutral.950}" },
    },
  },
  dark: {
    background: {
      default: { $type: "color", $value: "{color.neutral.950}" },
    },
    text: {
      default: { $type: "color", $value: "{color.neutral.50}" },
    },
  },
};

const semanticLight = {
  background: {
    default: { $type: "color", $value: "{light.background.default}" },
  },
  text: {
    default: { $type: "color", $value: "{light.text.default}" },
  },
};

const semanticDark = {
  background: {
    default: { $type: "color", $value: "{dark.background.default}" },
  },
  text: {
    default: { $type: "color", $value: "{dark.text.default}" },
  },
};

function makeFiles(extra: GitHubFile[] = []): GitHubFile[] {
  return [
    file("tokens/primitives/color.json", primitiveColor),
    file("tokens/semantic/themes/default.json", defaultTheme),
    file("tokens/semantic/light.json", semanticLight),
    file("tokens/semantic/dark.json", semanticDark),
    ...extra,
  ];
}

// ────────────────────────────────────────────────────────────────
// parseRepository — metadata
// ────────────────────────────────────────────────────────────────

describe("parseRepository — metadata", () => {
  it("uses DEFAULT_METADATA when metadata.json is absent", () => {
    const { metadata } = parseRepository(makeFiles(), tokensPath);
    expect(metadata.themes).toEqual(["default"]);
    expect(metadata.colorSchemes).toEqual(["light", "dark"]);
  });

  it("reads themes and colorSchemes from metadata.json", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default", "christmas"],
      colorSchemes: ["light", "dark", "contrast"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
    };
    const { metadata } = parseRepository(
      [
        ...makeFiles(),
        file("tokens/metadata.json", meta),
        file("tokens/semantic/themes/christmas.json", defaultTheme),
      ],
      tokensPath,
    );
    expect(metadata.themes).toEqual(["default", "christmas"]);
    expect(metadata.colorSchemes).toEqual(["light", "dark", "contrast"]);
  });

  it("supports legacy 'brands' field as alias for 'themes'", () => {
    const legacyMeta = { brands: ["classic", "modern"] };
    const { metadata } = parseRepository(
      [...makeFiles(), file("tokens/metadata.json", legacyMeta)],
      tokensPath,
    );
    expect(metadata.themes).toEqual(["classic", "modern"]);
  });

  it("reads ignoredCollections from metadata.json", () => {
    const meta = {
      ignoredCollections: ["primitives", "global"],
    };
    const { metadata } = parseRepository(
      [...makeFiles(), file("tokens/metadata.json", meta)],
      tokensPath,
    );
    expect(metadata.ignoredCollections).toEqual(["primitives", "global"]);
  });

  it("migrates a legacy bare-string figma.collections role into a single-element list", () => {
    // figma.collections.X used to be a plain string, before a role could be
    // backed by more than one physical Figma collection. A repo written
    // before that change must not silently break every `.includes()` check.
    const legacyMeta = {
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
    };
    const { metadata } = parseRepository(
      [...makeFiles(), file("tokens/metadata.json", legacyMeta)],
      tokensPath,
    );
    expect(metadata.figma.collections.primitives).toEqual(["Primitives"]);
    expect(metadata.figma.collections.themes).toEqual(["Themes"]);
    expect(metadata.figma.collections.sizes).toEqual([]);
  });

  it("preserves multiple configured names for one role", () => {
    // The whole point of the list shape: Figma's one-mode-axis-per-collection
    // limit can force one logical role across several physical collections.
    const meta = {
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: ["Primitives"],
          global: ["Global"],
          themes: ["Themes", "Main Color", "Support Color"],
          semantic: ["Semantic"],
          sizes: ["Size"],
        },
      },
    };
    const { metadata } = parseRepository(
      [...makeFiles(), file("tokens/metadata.json", meta)],
      tokensPath,
    );
    expect(metadata.figma.collections.themes).toEqual(["Themes", "Main Color", "Support Color"]);
    expect(metadata.figma.collections.sizes).toEqual(["Size"]);
  });
});

// ────────────────────────────────────────────────────────────────
// parseRepository — collections emitted
// ────────────────────────────────────────────────────────────────

describe("parseRepository — collections emitted", () => {
  it("emits Primitives, Themes, Semantic collections (in that order)", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const names = collections.map((c) => c.collectionName);
    expect(names).toContain("Primitives");
    expect(names).toContain("Themes");
    expect(names).toContain("Semantic");
    // Primitives must come before Themes which must come before Semantic
    expect(names.indexOf("Primitives")).toBeLessThan(names.indexOf("Themes"));
    expect(names.indexOf("Themes")).toBeLessThan(names.indexOf("Semantic"));
  });

  it("emits one Themes mode per theme file", () => {
    const files = [...makeFiles(), file("tokens/semantic/themes/christmas.json", defaultTheme)];
    const { collections } = parseRepository(files, tokensPath);
    const themeCollections = collections.filter((c) => c.collectionName === "Themes");
    expect(themeCollections.length).toBe(2);
    const modeNames = themeCollections.map((c) => c.modeName);
    expect(modeNames).toContain("Default");
    expect(modeNames).toContain("Christmas");
  });

  it("emits one Semantic mode per color scheme", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const semanticCollections = collections.filter((c) => c.collectionName === "Semantic");
    expect(semanticCollections.length).toBe(2);
    const modeNames = semanticCollections.map((c) => c.modeName);
    expect(modeNames).toContain("Light");
    expect(modeNames).toContain("Dark");
  });
});

// ────────────────────────────────────────────────────────────────
// parseRepository — Size axis on Primitives
// ────────────────────────────────────────────────────────────────

describe("parseRepository — Size axis on Primitives", () => {
  const meta = {
    version: "1.0.0",
    sizes: ["mobile", "desktop"],
    sizeBreakpoints: { desktop: 768 },
    figma: {
      fileKey: "abc123",
      collections: {
        primitives: ["Primitives"],
        global: ["Global"],
        themes: ["Themes"],
        semantic: ["Semantic"],
        sizes: ["Size"],
      },
    },
  };

  const mobileSize = {
    "font-size": { 1: { $type: "dimension", $value: "11px" } },
  };
  const desktopSize = {
    "font-size": { 1: { $type: "dimension", $value: "12px" } },
  };

  function filesWithSizes(extra: GitHubFile[] = []): GitHubFile[] {
    return [
      ...makeFiles(),
      file("tokens/metadata.json", meta),
      file("tokens/primitives/sizes/mobile.json", mobileSize),
      file("tokens/primitives/sizes/desktop.json", desktopSize),
      ...extra,
    ];
  }

  it("emits one Primitives collection per size mode instead of a single 'Value' mode", () => {
    const { collections } = parseRepository(filesWithSizes(), tokensPath);
    const primitivesCollections = collections.filter((c) => c.collectionName === "Primitives");
    expect(primitivesCollections.length).toBe(2);
    const modeNames = primitivesCollections.map((c) => c.modeName);
    expect(modeNames).toContain("Mobile");
    expect(modeNames).toContain("Desktop");
  });

  it("each size mode carries both its own size-specific value and the shared (size-invariant) primitives", () => {
    const { collections } = parseRepository(filesWithSizes(), tokensPath);
    const mobile = collections.find(
      (c) => c.collectionName === "Primitives" && c.modeName === "Mobile",
    )!;
    const desktop = collections.find(
      (c) => c.collectionName === "Primitives" && c.modeName === "Desktop",
    )!;

    expect(mobile.tokens["font-size.1"].$value).toBe("11px");
    expect(desktop.tokens["font-size.1"].$value).toBe("12px");
    // Shared, size-invariant primitive (from primitives/color.json) present in both.
    expect(mobile.tokens["color.brand.500"].$value).toBe("#0142FE");
    expect(desktop.tokens["color.brand.500"].$value).toBe("#0142FE");
  });

  it("falls back to a single 'Value' mode when no Size axis is configured — no behavior change", () => {
    // The exact same shared primitives file, but no primitives/sizes/*.json files
    // and no metadata.sizes — must produce exactly what it always has.
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const primitivesCollections = collections.filter((c) => c.collectionName === "Primitives");
    expect(primitivesCollections.length).toBe(1);
    expect(primitivesCollections[0].modeName).toBe("Value");
  });
});

// ────────────────────────────────────────────────────────────────
// parseRepository — platforms (output format config)
// ────────────────────────────────────────────────────────────────

describe("parseRepository — platforms", () => {
  it("round-trips platforms config from metadata.json unchanged", () => {
    const meta = {
      platforms: {
        css: { enabled: true, output: "dist/tokens.css" },
        js: { enabled: false },
      },
    };
    const { metadata } = parseRepository(
      [...makeFiles(), file("tokens/metadata.json", meta)],
      tokensPath,
    );
    expect(metadata.platforms?.css).toEqual({ enabled: true, output: "dist/tokens.css" });
    expect(metadata.platforms?.js).toEqual({ enabled: false });
    expect(metadata.platforms?.ts).toBeUndefined();
  });

  it("is undefined (not an empty object) when metadata.json has no platforms key at all", () => {
    const { metadata } = parseRepository(makeFiles(), tokensPath);
    expect(metadata.platforms).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// parseRepository — resolution
// ────────────────────────────────────────────────────────────────

describe("parseRepository — token resolution", () => {
  it("Primitives collection has fully resolved values", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const prim = collections.find((c) => c.collectionName === "Primitives")!;
    expect(prim.tokens["color.brand.500"].$value).toBe("#0142FE");
  });

  it("Themes rawTokens keep unresolved {color.*} refs", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const themes = collections.find(
      (c) => c.collectionName === "Themes" && c.modeName === "Default",
    )!;
    // raw value should still contain the {color.*} ref
    expect(themes.rawTokens["light.background.default"].$value).toBe("{color.white.950}");
  });

  it("Themes tokens map resolves {color.*} refs to hex", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const themes = collections.find(
      (c) => c.collectionName === "Themes" && c.modeName === "Default",
    )!;
    expect(themes.tokens["light.background.default"].$value).toBe("#ffffff");
  });

  it("Semantic rawTokens keep unresolved {light.*}/{dark.*} refs", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const semanticLight = collections.find(
      (c) => c.collectionName === "Semantic" && c.modeName === "Light",
    )!;
    // {light.background.default} should remain as a literal in rawTokens
    expect(semanticLight.rawTokens["background.default"].$value).toBe("{light.background.default}");
  });

  it("Semantic tokens resolve through theme to primitive hex", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const semanticLight = collections.find(
      (c) => c.collectionName === "Semantic" && c.modeName === "Light",
    )!;
    // {light.background.default} → {color.white.950} → #ffffff
    expect(semanticLight.tokens["background.default"].$value).toBe("#ffffff");
  });

  it("Dark Semantic tokens resolve through dark theme values", () => {
    const { collections } = parseRepository(makeFiles(), tokensPath);
    const semanticDark = collections.find(
      (c) => c.collectionName === "Semantic" && c.modeName === "Dark",
    )!;
    // dark.background.default → {color.neutral.950} → #0f172a
    expect(semanticDark.tokens["background.default"].$value).toBe("#0f172a");
  });
});

// ────────────────────────────────────────────────────────────────
// parseRepository — tokensPath stripping
// ────────────────────────────────────────────────────────────────

describe("parseRepository — tokensPath prefix stripping", () => {
  it("ignores files outside the tokensPath prefix", () => {
    const files = [
      ...makeFiles(),
      file("other/color.json", { color: { ignored: { $value: "#abc" } } }),
    ];
    const { collections } = parseRepository(files, tokensPath);
    const prim = collections.find((c) => c.collectionName === "Primitives")!;
    expect(Object.keys(prim.tokens)).not.toContain("color.ignored");
  });

  it("works with trailing slash on tokensPath", () => {
    const { collections } = parseRepository(makeFiles(), "tokens/");
    expect(collections.some((c) => c.collectionName === "Primitives")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// parseRepository — multiple primitive files deep-merged
// ────────────────────────────────────────────────────────────────

describe("parseRepository — deep merge of primitives", () => {
  it("merges multiple primitive files into one Primitives collection", () => {
    const geometry = {
      geometry: {
        radius: { sm: { $type: "dimension", $value: "4px" } },
      },
    };
    const files = [...makeFiles(), file("tokens/primitives/geometry.json", geometry)];
    const { collections } = parseRepository(files, tokensPath);
    const prim = collections.find((c) => c.collectionName === "Primitives")!;
    expect(prim.tokens).toHaveProperty("color.brand.500");
    expect(prim.tokens).toHaveProperty("geometry.radius.sm");
  });
});
