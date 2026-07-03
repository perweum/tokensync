import { describe, it, expect } from "vitest";
import { runTransformers } from "./index";
import { parseRepository } from "../token-merger";
import type { GitHubFile } from "../messages";
import { figmaToCollections, figmaToTokenFiles } from "../figma-to-tokens";

function file(path: string, content: object): GitHubFile {
  return { path, content: JSON.stringify(content), sha: "abc" };
}

const tokensPath = "tokens";

const primitiveColor = {
  color: {
    brand: {
      500: { $type: "color", $value: "#0142FE" },
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
  },
  dark: {
    background: {
      default: { $type: "color", $value: "{color.neutral.950}" },
    },
  },
};

const semanticLight = {
  background: {
    default: { $type: "color", $value: "{light.background.default}" },
  },
};

const semanticDark = {
  background: {
    default: { $type: "color", $value: "{dark.background.default}" },
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

describe("runTransformers", () => {
  it("generates separate JS/TS files when colorScheme is in the path", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light", "dark"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
      platforms: {
        js: { enabled: true, output: "dist/{colorScheme}.js" },
        ts: { enabled: true, output: "dist/{colorScheme}.ts" },
      },
    };

    const files = [...makeFiles(), file("tokens/metadata.json", meta)];

    const { collections, metadata } = parseRepository(files, tokensPath);
    const output = runTransformers(collections, metadata, tokensPath);

    const paths = output.map((f) => f.path);
    expect(paths).toContain("dist/light.js");
    expect(paths).toContain("dist/dark.js");
    expect(paths).toContain("dist/light.ts");
    expect(paths).toContain("dist/dark.ts");

    // Verify the split-mode content
    const lightJS = output.find((f) => f.path === "dist/light.js")!;
    expect(lightJS.content).toContain("export const primitives = {");
    expect(lightJS.content).toContain("export const tokens = {");
    expect(lightJS.content).toContain('default: "#ffffff"');
    expect(lightJS.content).not.toContain('default: "#0f172a"'); // dark value should not be in light.js

    const darkJS = output.find((f) => f.path === "dist/dark.js")!;
    expect(darkJS.content).toContain('default: "#0f172a"');
    expect(darkJS.content).not.toContain('default: "#ffffff"');

    // .js output must be valid JavaScript — no TypeScript syntax
    expect(lightJS.content).not.toContain("as const");
    expect(lightJS.content).not.toContain("export type");

    // .ts output keeps the TypeScript syntax
    const lightTS = output.find((f) => f.path === "dist/light.ts")!;
    expect(lightTS.content).toContain("as const");
  });

  it("generates a combined JS file when colorScheme is not in the path", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light", "dark"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
      platforms: {
        js: { enabled: true, output: "dist/tokens.js" },
      },
    };

    const files = [...makeFiles(), file("tokens/metadata.json", meta)];

    const { collections, metadata } = parseRepository(files, tokensPath);
    const output = runTransformers(collections, metadata, tokensPath);

    const paths = output.map((f) => f.path);
    expect(paths).toContain("dist/tokens.js");
    expect(paths).not.toContain("dist/light.js");

    const tokensJS = output.find((f) => f.path === "dist/tokens.js")!;
    expect(tokensJS.content).toContain("export const tokens = {");
    expect(tokensJS.content).toContain("light: {");
    expect(tokensJS.content).toContain("dark: {");

    // Combined .js output must also be valid JavaScript
    expect(tokensJS.content).not.toContain("as const");
    expect(tokensJS.content).not.toContain("export type");

    // Themes collection is included so multi-theme works outside CSS
    expect(tokensJS.content).toContain("export const themes = {");
    expect(tokensJS.content).toContain("default: {");
  });

  it("defaults combined output sibling to the tokens folder for all platforms", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light", "dark"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
      platforms: {
        css: { enabled: true },
        js: { enabled: true },
        swift: { enabled: true },
      },
    };

    const nestedPath = "design/tokens";
    const files = [
      file("design/tokens/primitives/color.json", primitiveColor),
      file("design/tokens/semantic/themes/default.json", defaultTheme),
      file("design/tokens/semantic/light.json", semanticLight),
      file("design/tokens/semantic/dark.json", semanticDark),
      file("design/tokens/metadata.json", meta),
    ];

    const { collections, metadata } = parseRepository(files, nestedPath);
    const output = runTransformers(collections, metadata, nestedPath);

    const paths = output.map((f) => f.path);
    expect(paths).toContain("design/dist/tokens.css");
    expect(paths).toContain("design/dist/tokens.js");
    expect(paths).toContain("design/ios/DesignTokens.swift");
  });

  it("generates split Dart files when colorScheme is in the path", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light", "dark"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
      platforms: {
        dart: { enabled: true, output: "lib/src/tokens/{colorScheme}.dart" },
      },
    };

    const files = [...makeFiles(), file("tokens/metadata.json", meta)];

    const { collections, metadata } = parseRepository(files, tokensPath);
    const output = runTransformers(collections, metadata, tokensPath);

    const paths = output.map((f) => f.path);
    expect(paths).toContain("lib/src/tokens/light.dart");
    expect(paths).toContain("lib/src/tokens/dark.dart");
    // The template placeholder must never survive into an output path
    expect(paths.some((p) => p.includes("{colorScheme}"))).toBe(false);

    const lightDart = output.find((f) => f.path === "lib/src/tokens/light.dart")!;
    expect(lightDart.content).toContain("class DesignTokensPrimitives {");
    expect(lightDart.content).toContain("class DesignTokens {");
    expect(lightDart.content).toContain("Color(0xFFFFFFFF)");
  });

  it("includes theme classes in combined Dart output", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light", "dark"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
      platforms: {
        dart: { enabled: true, output: "lib/src/design_tokens.dart" },
      },
    };

    const files = [...makeFiles(), file("tokens/metadata.json", meta)];

    const { collections, metadata } = parseRepository(files, tokensPath);
    const output = runTransformers(collections, metadata, tokensPath);

    const dart = output.find((f) => f.path === "lib/src/design_tokens.dart")!;
    expect(dart.content).toContain("class DesignTokensThemeDefault {");
    expect(dart.content).toContain("class DesignTokensLight {");
    expect(dart.content).toContain("class DesignTokensDark {");
  });

  it("reorders 8-digit hex to alpha-first for Swift Color(hex:)", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
      platforms: {
        swift: { enabled: true, output: "ios/tokens.swift" },
      },
    };

    const withAlpha = {
      color: {
        overlay: { $type: "color", $value: "#11223344" },
      },
    };

    const files = [
      file("tokens/primitives/color.json", withAlpha),
      file("tokens/semantic/light.json", semanticLight),
      file("tokens/metadata.json", meta),
    ];

    const { collections, metadata } = parseRepository(files, tokensPath);
    const output = runTransformers(collections, metadata, tokensPath);

    const swift = output.find((f) => f.path === "ios/tokens.swift")!;
    // #RRGGBBAA (CSS order) → #AARRGGBB (the order Color(hex:) parses)
    expect(swift.content).toContain('Color(hex: "#44112233")');
    expect(swift.content).not.toContain('Color(hex: "#11223344")');
  });

  it("uses dynamic custom collection names from metadata", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Core Primitives",
          global: "Shared Global",
          themes: "Theme Overrides",
          semantic: "App Semantic",
        },
      },
      platforms: {
        js: { enabled: true, output: "dist/tokens.js" },
      },
    };

    const collections = [
      {
        collectionName: "Core Primitives",
        modeName: "Value",
        tokens: {
          "color.brand": { $type: "color", $value: "#123456" },
        },
        rawTokens: {},
      },
      {
        collectionName: "Shared Global",
        modeName: "Value",
        tokens: {
          "spacing.md": { $type: "dimension", $value: "12px" },
        },
        rawTokens: {},
      },
      {
        collectionName: "App Semantic",
        modeName: "Light",
        tokens: {
          "background.default": { $type: "color", $value: "#ffffff" },
        },
        rawTokens: {},
      },
    ];

    const output = runTransformers(collections, meta as any, tokensPath);
    const tokensJS = output.find((f) => f.path === "dist/tokens.js")!;
    expect(tokensJS.content).toContain("export const primitives = {");
    expect(tokensJS.content).toContain('brand: "#123456"');
    expect(tokensJS.content).toContain("export const globalTokens = {");
    expect(tokensJS.content).toContain('md: "12px"');
  });

  it("generates Swift files in both combined and split mode", () => {
    const meta = {
      version: "1.0.0",
      themes: ["default"],
      colorSchemes: ["light", "dark"],
      figma: {
        fileKey: "abc123",
        collections: {
          primitives: "Primitives",
          global: "Global",
          themes: "Themes",
          semantic: "Semantic",
        },
      },
      platforms: {
        swift: { enabled: true, output: "ios/{colorScheme}.swift" },
      },
    };

    const files = [...makeFiles(), file("tokens/metadata.json", meta)];

    const { collections, metadata } = parseRepository(files, tokensPath);
    const output = runTransformers(collections, metadata, tokensPath);

    const paths = output.map((f) => f.path);
    expect(paths).toContain("ios/light.swift");
    expect(paths).toContain("ios/dark.swift");

    const lightSwift = output.find((f) => f.path === "ios/light.swift")!;
    expect(lightSwift.content).toContain("public struct DesignTokensPrimitives {");
    expect(lightSwift.content).toContain("public struct DesignTokens {");
    expect(lightSwift.content).toContain(
      'public static let backgroundDefault: Color = Color(hex: "#FFFFFF")',
    );
    expect(lightSwift.content).toContain("init(hex: String)"); // Contains helper extension
  });
});

describe("figmaToTokenFiles & figmaToCollections descriptions", () => {
  it("includes description fields when converting Figma variables to tokens and token files", () => {
    const figmaCollections = [
      {
        id: "c1",
        name: "Primitives",
        modes: [{ modeId: "m1", name: "Value" }],
        variableIds: ["v1"],
      },
    ];

    const figmaVariables = [
      {
        id: "v1",
        name: "color/brand/500",
        resolvedType: "COLOR" as const,
        valuesByMode: { m1: { r: 1, g: 0, b: 0 } },
        collectionId: "c1",
        collectionName: "Primitives",
        description: "Primary brand color seed",
      },
    ];

    const figmaCollectionNames = {
      primitives: "Primitives",
      global: "Global",
      themes: "Themes",
      semantic: "Semantic",
    };

    // 1. Check figmaToCollections
    const collections = figmaToCollections(figmaCollections, figmaVariables, figmaCollectionNames);
    const primCol = collections.find((c: any) => c.collectionName === "Primitives")!;
    expect(primCol.tokens["color.brand.500"].$description).toBe("Primary brand color seed");

    // 2. Check figmaToTokenFiles
    const files = figmaToTokenFiles(
      figmaCollections,
      figmaVariables,
      "tokens/",
      figmaCollectionNames,
    );
    const colorFile = files.find((f: any) => f.repoPath === "tokens/primitives/color.json")!;
    expect(colorFile.content).toContain('"$description": "Primary brand color seed"');
  });
});
