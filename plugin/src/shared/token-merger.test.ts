import { describe, it, expect } from "vitest";
import { parseRepository, findGlobalCollection, selectDefaultPrimitives } from "./token-merger";
import type { GitHubFile, TokenValue } from "./messages";
import type { ResolvedCollection, Metadata } from "./token-merger";

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
// parseRepository — theme/colorScheme name resolution is case-insensitive
// ────────────────────────────────────────────────────────────────

describe("parseRepository — theme/colorScheme lookup is case-insensitive", () => {
  // The default fixture's theme file happens to be named "default.json",
  // coincidentally matching defaultMetadata()'s own placeholder theme name
  // ("default") — which is exactly how this class of bug stayed invisible: a
  // real theme is essentially never actually going to be named "default".
  // These tests use a realistic name instead, with metadata.json casing that
  // deliberately doesn't match the file, since metadata.json is hand-editable
  // (docs/principles/no-lock-in.md) and a casing slip must not silently
  // resolve against an empty tree.
  const originalTheme = {
    light: { background: { default: { $type: "color", $value: "{color.white.950}" } } },
    dark: { background: { default: { $type: "color", $value: "{color.neutral.950}" } } },
  };

  it("resolves the default theme even when metadata.themes' casing differs from the real file name", () => {
    const meta = { themes: ["Original"], colorSchemes: ["light", "dark"] };
    const files = [
      file("tokens/primitives/color.json", primitiveColor),
      file("tokens/semantic/themes/original.json", originalTheme),
      file(
        "tokens/semantic/light.json",
        { background: { default: { $type: "color", $value: "{light.background.default}" } } },
      ),
      file("tokens/metadata.json", meta),
    ];

    const { collections } = parseRepository(files, tokensPath);
    const semantic = collections.find(
      (c) => c.collectionName === "Semantic" && c.modeName === "Light",
    )!;

    // If the default-theme lookup silently missed (case-sensitive bug),
    // this resolves to nothing and the alias is left dangling/unresolved.
    expect(semantic.tokens["background.default"].$value).toBe("#ffffff");
  });

  it("reads a color scheme file even when metadata.colorSchemes' casing differs from the real file name", () => {
    const meta = { themes: ["original"], colorSchemes: ["Light"] };
    const files = [
      file("tokens/primitives/color.json", primitiveColor),
      file("tokens/semantic/themes/original.json", originalTheme),
      file(
        "tokens/semantic/light.json",
        { background: { default: { $type: "color", $value: "{light.background.default}" } } },
      ),
      file("tokens/metadata.json", meta),
    ];

    const { collections } = parseRepository(files, tokensPath);
    const semanticCollections = collections.filter((c) => c.collectionName === "Semantic");

    // Case-sensitive lookup would silently skip light.json entirely (schemeTree
    // undefined -> continue), producing zero Semantic collections.
    expect(semanticCollections).toHaveLength(1);
    expect(semanticCollections[0].modeName).toBe("Light");
  });
});

describe("parseRepository — a real mode name containing a space", () => {
  // Reproduces a real bug found live on the single-theme-stresstest system:
  // Figma's own unrenamed default mode is literally "Mode 1" (with a space).
  // Writing it to a filename sanitizes spaces to hyphens ("mode-1.json") —
  // CollectionMapping.tsx used to store that *same sanitized slug* in
  // metadata.json too, which parseRepository could then only reconstruct as
  // "Mode-1" (capitalise() only touches the first character; it never turns
  // a hyphen back into a space). "Mode-1" != Figma's real live "Mode 1", so
  // every single pull showed the whole collection as newly "added", forever,
  // no matter how many times it had already been pushed and pulled.
  //
  // These tests use metadata.json entries with the *real* name (spaces
  // intact) — what CollectionMapping.tsx stores after its own fix — proving
  // parseRepository reconstructs "Mode 1", not "Mode-1".
  it("reconstructs a semantic mode's real spaced name from its sanitized filename", () => {
    const meta = { themes: ["original"], colorSchemes: ["Mode 1"] };
    const files = [
      file("tokens/primitives/color.json", primitiveColor),
      file("tokens/semantic/themes/original.json", defaultTheme),
      file("tokens/semantic/mode-1.json", semanticLight),
      file("tokens/metadata.json", meta),
    ];

    const { collections } = parseRepository(files, tokensPath);
    const semanticCollections = collections.filter((c) => c.collectionName === "Semantic");
    expect(semanticCollections).toHaveLength(1);
    expect(semanticCollections[0].modeName).toBe("Mode 1");
  });

  it("reconstructs a theme mode's real spaced name from its sanitized filename", () => {
    const meta = { themes: ["Brand A"], colorSchemes: ["light"] };
    const files = [
      file("tokens/primitives/color.json", primitiveColor),
      file("tokens/semantic/themes/brand-a.json", defaultTheme),
      file("tokens/semantic/light.json", semanticLight),
      file("tokens/metadata.json", meta),
    ];

    const { collections } = parseRepository(files, tokensPath);
    const themeCollections = collections.filter((c) => c.collectionName === "Themes");
    expect(themeCollections).toHaveLength(1);
    expect(themeCollections[0].modeName).toBe("Brand A");
  });

  it("reconstructs a size mode's real spaced name from its sanitized filename", () => {
    const meta = {
      version: "1.0.0",
      sizes: ["Small Screen", "desktop"],
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
    const files = [
      ...makeFiles(),
      file("tokens/metadata.json", meta),
      file("tokens/primitives/sizes/small-screen.json", {
        "font-size": { 1: { $type: "dimension", $value: "11px" } },
      }),
      file("tokens/primitives/sizes/desktop.json", {
        "font-size": { 1: { $type: "dimension", $value: "12px" } },
      }),
    ];

    const { collections } = parseRepository(files, tokensPath);
    const primitivesCollections = collections.filter((c) => c.collectionName === "Primitives");
    const modeNames = primitivesCollections.map((c) => c.modeName);
    expect(modeNames).toContain("Small Screen");
  });

  it("still capitalises a legacy lowercase metadata entry that predates this fix", () => {
    // A metadata.json written before CollectionMapping.tsx's own fix would
    // still have the old sanitized-slug form ("original", not "Original") —
    // must keep displaying capitalised, not regress to showing it verbatim.
    const meta = { themes: ["original"], colorSchemes: ["light"] };
    const files = [
      file("tokens/primitives/color.json", primitiveColor),
      file("tokens/semantic/themes/original.json", defaultTheme),
      file("tokens/semantic/light.json", semanticLight),
      file("tokens/metadata.json", meta),
    ];

    const { collections } = parseRepository(files, tokensPath);
    const semantic = collections.find((c) => c.collectionName === "Semantic")!;
    expect(semantic.modeName).toBe("Light");
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

// ────────────────────────────────────────────────────────────────
// parseRepository — a theme/global/semantic file sharing a top-level key
// with Primitives must not blot out the rest of that Primitives group
// ────────────────────────────────────────────────────────────────

describe("parseRepository — theme file reuses Primitives' top-level key", () => {
  // Reproduces a real bug found live: a theme file (e.g. semantic/themes/
  // masterbrand.json) commonly nests its light/dark groups under a "color"
  // key, the same top-level key primitives/color.json uses. The merge that
  // builds each theme's resolution context used to be a *shallow* merge
  // (mergeTrees) — the theme's own "color" key completely replaced
  // Primitives' "color" key instead of merging into it, silently dropping
  // every other primitive color from scope. A ref like {color.blue.950}
  // then failed to resolve and stayed as the literal unresolved string,
  // even though color.blue.950 is a real, correctly-defined primitive.
  it("resolves a primitive ref even when the theme's own top-level key is also \"color\"", () => {
    const files = [
      file("tokens/primitives/color.json", {
        color: { blue: { 950: { $type: "color", $value: "#001224" } } },
      }),
      file("tokens/semantic/themes/masterbrand.json", {
        color: {
          dark: {
            accent: {
              "background-default": { $type: "color", $value: "{color.blue.950}" },
            },
          },
        },
      }),
      file("tokens/semantic/light.json", semanticLight),
      file("tokens/semantic/dark.json", semanticDark),
    ];
    const { collections } = parseRepository(files, tokensPath);
    const theme = collections.find((c) => c.collectionName === "Themes" && c.modeName === "Masterbrand")!;
    expect(theme.tokens["color.dark.accent.background-default"].$value).toBe("#001224");
  });
});

describe("parseRepository — Global resolves refs into a theme-scoped group", () => {
  // Reproduces a real bug found live: Figma's own structure for type styles
  // is fontFamily/fontWeight (Primitives) → Theme (e.g. Masterbrand) → type
  // styles — the theme layer picks a named font/weight per its own brand,
  // and the type style itself (written to semantic/global/typography.json,
  // the "Global" role) references that theme-scoped choice, not Primitives
  // directly. Global's resolution context used to merge only Primitives +
  // its own tree — never any theme — so a ref like {font-family.display}
  // (defined only inside a theme file) had nothing to resolve against and
  // silently stayed as the literal unresolved string on every read.
  it("resolves a Global token's ref into the default theme's own group", () => {
    const files = [
      file("tokens/primitives/fontFamily.json", {
        fontFamily: { "coop-sans": { $type: "fontFamily", $value: "Coop Sans" } },
      }),
      file("tokens/semantic/themes/default.json", {
        "font-family": {
          display: { $type: "fontFamily", $value: "{fontFamily.coop-sans}" },
        },
      }),
      file("tokens/semantic/global/typography.json", {
        typography: {
          banner: { fontFamily: { $type: "fontFamily", $value: "{font-family.display}" } },
        },
      }),
      file("tokens/semantic/light.json", semanticLight),
      file("tokens/semantic/dark.json", semanticDark),
    ];
    const { collections } = parseRepository(files, tokensPath);
    const global = collections.find((c) => c.collectionName === "Global")!;
    expect(global.tokens["typography.banner.fontFamily"].$value).toBe("Coop Sans");
    // rawTokens must stay unresolved — this is what Figma alias creation reads.
    expect(global.rawTokens["typography.banner.fontFamily"].$value).toBe("{font-family.display}");
  });
});

// ────────────────────────────────────────────────────────────────
// parseRepository — Global collection name falls back when no role is mapped
// ────────────────────────────────────────────────────────────────

describe("parseRepository — Global collection falls back to a real name when nothing is mapped to that role", () => {
  // Reproduces a real bug found live: a Token Studio migration typically has
  // figma.collections.global === [] (composite typography lives only in
  // token files, never as a Figma variable — docs/interop/token-studio.md).
  // Before the fix, collectionName came out `undefined` here — not just a
  // blank pull-diff tab label, but the exact value handleApplyAll sends as
  // `collectionId` to APPLY_TOKENS, which would reach
  // figma.variables.createVariableCollection(undefined) on apply.
  const meta = {
    version: "1.0.0",
    themes: ["default"],
    colorSchemes: ["light", "dark"],
    figma: {
      fileKey: "abc123",
      collections: { primitives: "Primitives", global: [], themes: "Themes", semantic: "Semantic" },
    },
  };
  const typography = {
    text: {
      heading: {
        caption: {
          $type: "typography",
          fontSize: { $type: "dimension", $value: "16px" },
          textCase: { $type: "string", $value: "uppercase" },
        },
      },
    },
  };

  it("names the collection \"Global\" instead of leaving it undefined", () => {
    const files = [
      ...makeFiles(),
      file("tokens/metadata.json", meta),
      file("tokens/semantic/global/typography.json", typography),
    ];
    const { collections } = parseRepository(files, tokensPath);

    expect(collections.some((c) => c.collectionName === "Global")).toBe(true);
    expect(collections.some((c) => c.collectionName === undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// findGlobalCollection / selectDefaultPrimitives — output-generator-only
// helpers, additive and separate from collectionKind()/sync-logic.ts
// ────────────────────────────────────────────────────────────────

function baseNames() {
  return {
    primitives: ["Primitives"],
    global: [] as string[],
    themes: ["Themes"],
    semantic: ["Semantic"],
    sizes: ["Size"],
  };
}

function resolvedCol(collectionName: string, modeName: string): ResolvedCollection {
  const tokens: Record<string, TokenValue> = { "a.b": { $type: "color", $value: "#fff" } };
  return { collectionName, modeName, tokens, rawTokens: tokens, typographyStyles: [] };
}

function testMetadata(sizes: string[], collections: ReturnType<typeof baseNames>): Metadata {
  return {
    version: "1.0.0",
    themes: ["default"],
    colorSchemes: ["light", "dark"],
    sizes,
    figma: { fileKey: "abc", collections },
  };
}

describe("findGlobalCollection", () => {
  // Reproduces a real bug found live: every transformer (css.ts/js.ts/
  // dart.ts/swift.ts) located Global via `names.global.includes(name)` —
  // always false when nothing is mapped to the role (this project's real,
  // documented config for a Text-Style-only typography source), even
  // though parseRepository/figmaToCollections still build a real Global
  // collection under a fallback name. The real committed dist/tokens.css
  // confirmed this: zero typography output despite 27 real Text Styles
  // being correctly synced.
  it("finds the fallback-named Global collection when nothing is mapped to that role", () => {
    const collections = [resolvedCol("Global", "Value"), resolvedCol("Themes", "Masterbrand")];
    const found = findGlobalCollection(collections, baseNames());
    expect(found?.collectionName).toBe("Global");
  });

  it("still finds Global normally when a real collection is mapped to the role", () => {
    const names = { ...baseNames(), global: ["Spacing"] };
    const collections = [resolvedCol("Spacing", "Value"), resolvedCol("Themes", "Masterbrand")];
    const found = findGlobalCollection(collections, names);
    expect(found?.collectionName).toBe("Spacing");
  });

  it("returns undefined when there's genuinely no Global data at all", () => {
    const collections = [resolvedCol("Themes", "Masterbrand")];
    expect(findGlobalCollection(collections, baseNames())).toBeUndefined();
  });
});

describe("selectDefaultPrimitives", () => {
  // Reproduces a real bug found live: js.ts/dart.ts/swift.ts picked
  // Primitives via a plain .find() — whichever mode is first in array
  // order — not the deliberately configured default (metadata.sizes[0]),
  // unlike css.ts (already fixed for this during the Size axis work).
  // parseRepository always happens to order primitives collections by
  // metadata.sizes already, which masks this — the real exposure is
  // figmaToCollections' push-time data, whose mode order instead follows
  // whatever order Figma itself returns modes in. Constructing the
  // collections array out of config order directly (Desktop before
  // Mobile) reproduces that live scenario.
  it("picks the configured default mode even when it's not first in the collections array", () => {
    const collections = [resolvedCol("Primitives", "Desktop"), resolvedCol("Primitives", "Mobile")];
    const metadata = testMetadata(["mobile", "desktop"], baseNames());
    const result = selectDefaultPrimitives(collections, metadata);
    expect(result?.modeName).toBe("Mobile");
  });

  it("falls back to the first mode found when metadata.sizes doesn't match any real mode", () => {
    const collections = [resolvedCol("Primitives", "Desktop"), resolvedCol("Primitives", "Mobile")];
    const metadata = testMetadata(["tablet"], baseNames());
    const result = selectDefaultPrimitives(collections, metadata);
    expect(result?.modeName).toBe("Desktop");
  });

  it("finds the fallback-named Primitives collection when nothing is mapped to that role", () => {
    const names = { ...baseNames(), primitives: [] as string[] };
    const collections = [resolvedCol("Primitives", "Value")];
    const metadata = testMetadata([], names);
    const result = selectDefaultPrimitives(collections, metadata);
    expect(result?.collectionName).toBe("Primitives");
  });
});
