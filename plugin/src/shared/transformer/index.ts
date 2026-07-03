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
import { generateDart } from "./dart";
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

  const compileJsTs = (cfg: PlatformConfig, defaultFilename: string) => {
    const outputTemplate = cfg.output || defaultFilename;
    if (outputTemplate.includes("{colorScheme}")) {
      for (const scheme of metadata.colorSchemes) {
        const schemeCol = semantic.find((c) => c.modeName.toLowerCase() === scheme.toLowerCase());
        if (!schemeCol) continue;

        const output = generateSchemeJS(primitives, global, schemeCol);
        const resolvedPath = outputTemplate.replace("{colorScheme}", scheme.toLowerCase());
        const outPath = resolvePath(resolvedPath, tokensPath, resolvedPath);
        files.push({ path: outPath, content: output });
      }
    } else {
      const output = generateJS(collections, metadata);
      const outPath = resolvePath(outputTemplate, tokensPath, defaultFilename);
      files.push({ path: outPath, content: output });
    }
  };

  if (platforms.js?.enabled) {
    compileJsTs(platforms.js, "dist/tokens.js");
  }

  if (platforms.ts?.enabled) {
    compileJsTs(platforms.ts, "dist/tokens.ts");
  }

  if (platforms.dart?.enabled) {
    const output = generateDart(collections, metadata);
    const outPath = resolvePath(platforms.dart.output, tokensPath, "lib/src/design_tokens.dart");
    files.push({ path: outPath, content: output });
  }

  const compileSwift = (cfg: PlatformConfig, defaultFilename: string) => {
    const outputTemplate = cfg.output || defaultFilename;
    if (outputTemplate.includes("{colorScheme}")) {
      for (const scheme of metadata.colorSchemes) {
        const schemeCol = semantic.find((c) => c.modeName.toLowerCase() === scheme.toLowerCase());
        if (!schemeCol) continue;

        const output = generateSchemeSwift(primitives, global, schemeCol);
        const resolvedPath = outputTemplate.replace("{colorScheme}", scheme.toLowerCase());
        const outPath = resolvePath(resolvedPath, tokensPath, resolvedPath);
        files.push({ path: outPath, content: output });
      }
    } else {
      const output = generateSwift(collections, metadata);
      const outPath = resolvePath(outputTemplate, tokensPath, defaultFilename);
      files.push({ path: outPath, content: output });
    }
  };

  if (platforms.swift?.enabled) {
    compileSwift(platforms.swift, "ios/DesignTokens.swift");
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
