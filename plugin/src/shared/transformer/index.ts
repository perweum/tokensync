/**
 * Platform transformer orchestrator.
 *
 * Reads the platform output config from metadata and runs enabled transformers,
 * returning additional files to include in the GitHub PR commit alongside
 * the token JSON files.
 */

import type { ResolvedCollection, Metadata } from "../token-merger";
import { generateCSS } from "./css";
import { generateJS, generateSchemeJS } from "./js";
import { generateDart, generateSchemeDart } from "./dart";
import { generateSwift, generateSchemeSwift } from "./swift";

export interface TransformedFile {
  path: string;
  content: string;
}

export function runTransformers(
  collections: ResolvedCollection[],
  metadata: Metadata,
  tokensPath: string,
): TransformedFile[] {
  const files: TransformedFile[] = [];

  const platforms = (metadata as MetadataWithPlatforms).platforms;
  if (!platforms) return files;

  const names = metadata.figma.collections;
  const primitives = collections.find((c) => c.collectionName === names.primitives);
  const global = collections.find((c) => c.collectionName === names.global);
  const semantic = collections.filter((c) => c.collectionName === names.semantic);

  if (platforms.css?.enabled) {
    const output = generateCSS(collections, metadata);
    const outPath = resolvePath(platforms.css.output, tokensPath, "dist/tokens.css");
    files.push({ path: outPath, content: output });
  }

  /**
   * Split mode: `{colorScheme}` in the output path → one file per color scheme.
   * Combined mode: a single file with all collections, defaulting sibling to tokensPath.
   */
  const compileSplit = (
    cfg: PlatformConfig,
    defaultFilename: string,
    generateScheme: (schemeCol: ResolvedCollection) => string,
    generateCombined: () => string,
  ) => {
    const outputTemplate = cfg.output || defaultFilename;
    if (outputTemplate.includes("{colorScheme}")) {
      for (const scheme of metadata.colorSchemes) {
        const schemeCol = semantic.find((c) => c.modeName.toLowerCase() === scheme.toLowerCase());
        if (!schemeCol) continue;

        const outPath = outputTemplate.replace("{colorScheme}", scheme.toLowerCase());
        files.push({ path: outPath, content: generateScheme(schemeCol) });
      }
    } else {
      const outPath = resolvePath(cfg.output, tokensPath, defaultFilename);
      files.push({ path: outPath, content: generateCombined() });
    }
  };

  if (platforms.js?.enabled) {
    compileSplit(
      platforms.js,
      "dist/tokens.js",
      (col) => generateSchemeJS(primitives, global, col, { typescript: false }),
      () => generateJS(collections, metadata, { typescript: false }),
    );
  }

  if (platforms.ts?.enabled) {
    compileSplit(
      platforms.ts,
      "dist/tokens.ts",
      (col) => generateSchemeJS(primitives, global, col, { typescript: true }),
      () => generateJS(collections, metadata, { typescript: true }),
    );
  }

  if (platforms.dart?.enabled) {
    compileSplit(
      platforms.dart,
      "lib/src/design_tokens.dart",
      (col) => generateSchemeDart(primitives, global, col),
      () => generateDart(collections, metadata),
    );
  }

  if (platforms.swift?.enabled) {
    compileSplit(
      platforms.swift,
      "ios/DesignTokens.swift",
      (col) => generateSchemeSwift(primitives, global, col),
      () => generateSwift(collections, metadata),
    );
  }

  return files;
}

// ---------------------------------------------------------------------------
// Types — metadata.platforms is not in the base Metadata type yet
// ---------------------------------------------------------------------------

interface PlatformConfig {
  enabled: boolean;
  output?: string; // metadata.json uses "output"
}

interface MetadataWithPlatforms extends Metadata {
  platforms?: {
    css?: PlatformConfig;
    js?: PlatformConfig;
    ts?: PlatformConfig;
    dart?: PlatformConfig;
    swift?: PlatformConfig;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(configured: string | undefined, tokensPath: string, fallback: string): string {
  if (configured) return configured;
  // Default: sibling to tokens folder
  const base = tokensPath.replace(/\/$/, "").split("/").slice(0, -1).join("/");
  return base ? `${base}/${fallback}` : fallback;
}
