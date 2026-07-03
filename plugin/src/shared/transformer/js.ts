/**
 * JS/TS transformer — generates ES module with token constants.
 *
 * Output:
 *   export const primitives = { color: { brand: { 500: '#...' } } }
 *   export const themes = { original: { ... }, christmas: { ... } }
 *   export const tokens = { light: { ... }, dark: { ... } }
 *   export type Theme = keyof typeof tokens          (TypeScript only)
 *
 * TypeScript-only syntax (`as const`, type exports) is gated behind
 * opts.typescript so the js platform emits valid plain JavaScript.
 */

import type { ResolvedCollection, Metadata } from "../token-merger";
import type { TokenValue } from "../messages";

export interface JsOptions {
  /** Emit TypeScript syntax (`as const`, type exports). Must be false for .js output. */
  typescript: boolean;
}

export function generateSchemeJS(
  primitivesCol: ResolvedCollection | undefined,
  globalCol: ResolvedCollection | undefined,
  schemeCol: ResolvedCollection,
  opts: JsOptions,
): string {
  const asConst = opts.typescript ? " as const" : "";
  const blocks: string[] = [jsHeader()];

  if (primitivesCol) {
    blocks.push(`export const primitives = ${flatToNested(primitivesCol.tokens)}${asConst}`);
  }

  const mergedTokens: Record<string, TokenValue> = {
    ...globalCol?.tokens,
    ...schemeCol.tokens,
  };

  blocks.push(`export const tokens = ${flatToNested(mergedTokens)}${asConst}`);

  return blocks.join("\n\n") + "\n";
}

export function generateJS(
  collections: ResolvedCollection[],
  metadata: Metadata,
  opts: JsOptions,
): string {
  const asConst = opts.typescript ? " as const" : "";
  const blocks: string[] = [jsHeader()];

  const names = metadata.figma.collections;
  const primitives = collections.find((c) => c.collectionName === names.primitives);
  const global = collections.find((c) => c.collectionName === names.global);
  const themes = collections.filter((c) => c.collectionName === names.themes);
  const semantic = collections.filter((c) => c.collectionName === names.semantic);

  if (primitives) {
    blocks.push(`export const primitives = ${flatToNested(primitives.tokens)}${asConst}`);
  }

  if (global) {
    blocks.push(`export const globalTokens = ${flatToNested(global.tokens)}${asConst}`);
  }

  if (themes.length > 0) {
    const themeEntries = themes
      .map((col) => `  ${modeKey(col.modeName)}: ${flatToNested(col.tokens)}`)
      .join(",\n");
    blocks.push(`export const themes = {\n${themeEntries}\n}${asConst}`);
  }

  if (semantic.length > 0) {
    const modeEntries = semantic
      .map((col) => {
        const key = modeKey(col.modeName);
        return `  ${key}: ${flatToNested(col.tokens)}`;
      })
      .join(",\n");

    blocks.push(`export const tokens = {\n${modeEntries}\n}${asConst}`);
    if (opts.typescript) {
      blocks.push(`export type Theme = keyof typeof tokens`);
    }
  }

  return blocks.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert flat token map to nested JS object literal string */
function flatToNested(tokens: Record<string, TokenValue>): string {
  const nested: Record<string, unknown> = {};

  for (const [path, token] of Object.entries(tokens)) {
    const keys = path.split(".");
    // Boolean tokens are stored as "true"/"false" strings in JSON — convert to JS boolean
    const value = token.$type === "boolean" ? token.$value === "true" : token.$value;
    setNested(nested, keys, value);
  }

  return serialize(nested, 0);
}

function setNested(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof current[k] !== "object" || current[k] === null) {
      current[k] = {};
    }
    current = current[k] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function serialize(obj: unknown, indent: number): string {
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "boolean") return String(obj);
  if (typeof obj !== "object" || obj === null) return String(obj);

  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return "{}";

  const lines = entries.map(([k, v]) => {
    const key = /^\d/.test(k) ? `"${k}"` : k;
    return `${pad}${key}: ${serialize(v, indent + 1)}`;
  });

  return `{\n${lines.join(",\n")}\n${closePad}}`;
}

function modeKey(modeName: string): string {
  // "Light" → "light", "Default/Light" → "light", "Brand-A/Dark" → "brandA_dark"
  const parts = modeName.split("/");
  if (parts.length === 1) return parts[0].toLowerCase();

  const brand = parts[0].toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c: string) => c.toUpperCase());
  const theme = parts[1].toLowerCase();
  return brand === "default" ? theme : `${brand}_${theme}`;
}

function jsHeader(): string {
  return `/**\n * Design tokens — generated by Token Sync\n * Do not edit manually.\n */`;
}
