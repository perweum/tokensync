/**
 * Platform transformer orchestrator.
 *
 * Reads the platform output config from metadata and runs enabled transformers,
 * returning additional files to include in the GitHub PR commit alongside
 * the token JSON files.
 */

import type { ResolvedCollection, Metadata } from '../token-merger'
import { generateCSS } from './css'
import { generateJS } from './js'
import { generateDart } from './dart'

export interface TransformedFile {
  path: string
  content: string
}

export function runTransformers(
  collections: ResolvedCollection[],
  metadata: Metadata,
  tokensPath: string,
): TransformedFile[] {
  const files: TransformedFile[] = []

  const platforms = (metadata as MetadataWithPlatforms).platforms
  if (!platforms) return files

  if (platforms.css?.enabled) {
    const output = generateCSS(collections)
    const outPath = resolvePath(platforms.css.output, tokensPath, 'dist/tokens.css')
    files.push({ path: outPath, content: output })
  }

  if (platforms.js?.enabled) {
    const output = generateJS(collections)
    const outPath = resolvePath(platforms.js.output, tokensPath, 'dist/tokens.ts')
    files.push({ path: outPath, content: output })
  }

  if (platforms.dart?.enabled) {
    const output = generateDart(collections)
    const outPath = resolvePath(platforms.dart.output, tokensPath, 'lib/src/design_tokens.dart')
    files.push({ path: outPath, content: output })
  }

  return files
}

// ---------------------------------------------------------------------------
// Types — metadata.platforms is not in the base Metadata type yet
// ---------------------------------------------------------------------------

interface PlatformConfig {
  enabled: boolean
  output?: string  // metadata.json uses "output"
}

interface MetadataWithPlatforms extends Metadata {
  platforms?: {
    css?: PlatformConfig
    js?: PlatformConfig
    dart?: PlatformConfig
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(configured: string | undefined, tokensPath: string, fallback: string): string {
  if (configured) return configured
  // Default: sibling to tokens folder
  const base = tokensPath.replace(/\/$/, '').split('/').slice(0, -1).join('/')
  return base ? `${base}/${fallback}` : fallback
}
