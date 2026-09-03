/**
 * CSS transformer — generates CSS custom properties.
 *
 * Output structure (Primitives → Themes → Semantic):
 *   :root { ... }                              ← primitives + global + default theme + any
 *                                                 semantic value identical across every scheme
 *   [data-theme="zero"] { ... }                ← non-default theme — only vars that differ
 *                                                 from the default theme
 *   [data-color-scheme="light"] { ... }        ← semantic roles that differ between schemes
 *   [data-color-scheme="dark"] { ... }         ← (same, dark)
 *   [data-color-scheme="auto"] + @media        ← follows OS preference
 *
 * A semantic token whose CSS output is identical in both light and dark (a
 * dimension token with no real scheme variance, e.g.) is hoisted into :root
 * instead of being repeated in both scheme blocks — determined purely by
 * comparing the two schemes' resolved values, not by any authoring convention
 * or token metadata. A var(--light-*)/var(--dark-*) reference is never equal
 * to its counterpart by construction, so genuinely theme-aware tokens are
 * never hoisted this way. Likewise, a non-default theme only emits the
 * variables that actually differ from the default theme — anything identical
 * is already covered by :root via the cascade.
 *
 * Theme switching cascades automatically: changing [data-theme] on any ancestor
 * updates all --light-* and --dark-* CSS vars, which Semantic selectors pick up.
 */

import type { ResolvedCollection, Metadata } from "../token-merger";
import type { TokenValue } from "../messages";
import { resolveFontWeightNumber, DEFAULT_FONT_WEIGHT } from "../font-weight";

export function generateCSS(collections: ResolvedCollection[], metadata: Metadata): string {
  const blocks: string[] = [cssHeader()];

  const names = metadata.figma.collections;
  const primitives = collections.find((c) => c.collectionName === names.primitives);
  const global = collections.find((c) => c.collectionName === names.global);
  const themeCols = collections.filter((c) => c.collectionName === names.themes);
  const semanticCols = collections.filter((c) => c.collectionName === names.semantic);

  const defaultTheme = themeCols[0];
  const lightCol = semanticCols.find((c) => c.modeName.toLowerCase() === "light");
  const darkCol = semanticCols.find((c) => c.modeName.toLowerCase() === "dark");
  const {
    shared: sharedSemantic,
    light: lightOnly,
    dark: darkOnly,
  } = splitSharedSemanticTokens(lightCol, darkCol);

  // :root — primitives, global, the default theme's complete vars, and any semantic
  // value that's identical across every color scheme (see splitSharedSemanticTokens).
  const rootTokens: Record<string, TokenValue> = {
    ...primitives?.tokens,
    ...global?.tokens,
    ...defaultTheme?.tokens,
    ...sharedSemantic,
  };
  if (Object.keys(rootTokens).length > 0) {
    blocks.push(cssBlock(":root", rootTokens));
  }

  // Non-default themes — only the vars that actually differ from the default theme.
  // A value identical to the default needs no override: [data-theme] elements
  // already inherit it from :root via the cascade.
  for (const col of themeCols.slice(1)) {
    const themeSlug = col.modeName.toLowerCase().replace(/\s+/g, "-");
    const overrides = diffTokens(col.tokens, defaultTheme?.tokens ?? {});
    blocks.push(cssBlock(`[data-theme="${themeSlug}"]`, overrides));
  }

  // Semantic: Light/Dark modes — emit var(--light-*) / var(--dark-*) for theme-aliased
  // tokens, resolved literals for the rest; entries identical in both schemes were
  // already hoisted into :root above and are absent from lightOnly/darkOnly.
  if (lightOnly) {
    blocks.push(semanticBlock('[data-color-scheme="light"]', lightOnly));
    blocks.push(semanticBlock('[data-color-scheme="auto"]', lightOnly));
  }
  if (darkOnly) {
    blocks.push(semanticBlock('[data-color-scheme="dark"]', darkOnly));
    blocks.push(
      semanticMediaBlock("(prefers-color-scheme: dark)", '[data-color-scheme="auto"]', darkOnly),
    );
  }

  return blocks.filter(Boolean).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

/**
 * Semantic block: emits var(--light-*) / var(--dark-*) for {light.*} / {dark.*} raw refs
 * so theme switching cascades automatically, and resolved hex for all other tokens.
 */
function semanticBlock(selector: string, col: ResolvedCollection): string {
  const entries = Object.entries(col.tokens).filter(([, t]) => t.$type !== "boolean");
  if (entries.length === 0) return "";

  const lines = entries.map(([path, token]) => {
    const value = semanticCSSValue(col, path, token);
    return `  ${toCSSVar(path)}: ${value};`;
  });

  return `${selector} {\n${lines.join("\n")}\n}`;
}

function semanticMediaBlock(query: string, selector: string, col: ResolvedCollection): string {
  const inner = semanticBlock(selector, col);
  if (!inner) return "";
  const indented = inner
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return `@media ${query} {\n${indented}\n}`;
}

function cssBlock(selector: string, tokens: Record<string, TokenValue>): string {
  const entries = Object.entries(tokens).filter(([, t]) => t.$type !== "boolean");
  if (entries.length === 0) return "";
  const lines = entries.map(
    ([path, token]) => `  ${toCSSVar(path)}: ${formatCSSValue(token.$type, token.$value)};`,
  );
  return `${selector} {\n${lines.join("\n")}\n}`;
}

function cssHeader(): string {
  return `/**\n * Design tokens — generated by Token Sync\n * Do not edit manually.\n */`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The final CSS value for one semantic entry — var(--light-*)/var(--dark-*) for a
 * {light.X}/{dark.X} raw ref, or the formatted literal otherwise. The single
 * authoritative computation, used both to decide what's shared across schemes
 * and to render the final declaration, so the two can never disagree.
 */
function semanticCSSValue(col: ResolvedCollection, path: string, token: TokenValue): string {
  const rawValue = col.rawTokens[path]?.$value;
  const themeAware = toThemeAwareValue(token.$value, rawValue);
  return themeAware.startsWith("var(") ? themeAware : formatCSSValue(token.$type, themeAware);
}

/**
 * Splits light/dark semantic tokens into what's identical between the two schemes
 * (hoist to :root) and what genuinely differs (stays per-scheme). A ref-based value
 * (var(--light-*) vs var(--dark-*)) is never equal to its counterpart by construction,
 * so this can never accidentally hoist a genuinely theme-aware token — only tokens
 * whose actual CSS output happens to be byte-identical in both schemes.
 */
function splitSharedSemanticTokens(
  lightCol: ResolvedCollection | undefined,
  darkCol: ResolvedCollection | undefined,
): {
  shared: Record<string, TokenValue>;
  light: ResolvedCollection | undefined;
  dark: ResolvedCollection | undefined;
} {
  if (!lightCol || !darkCol) {
    return { shared: {}, light: lightCol, dark: darkCol };
  }

  const shared: Record<string, TokenValue> = {};
  const lightTokens: Record<string, TokenValue> = {};
  const darkTokens: Record<string, TokenValue> = {};

  const allPaths = new Set([...Object.keys(lightCol.tokens), ...Object.keys(darkCol.tokens)]);

  for (const path of allPaths) {
    const lightToken = lightCol.tokens[path];
    const darkToken = darkCol.tokens[path];

    if (lightToken && darkToken) {
      const lightValue = semanticCSSValue(lightCol, path, lightToken);
      const darkValue = semanticCSSValue(darkCol, path, darkToken);
      if (lightValue === darkValue) {
        shared[path] = lightToken;
        continue;
      }
    }
    if (lightToken) lightTokens[path] = lightToken;
    if (darkToken) darkTokens[path] = darkToken;
  }

  return {
    shared,
    light: { ...lightCol, tokens: lightTokens },
    dark: { ...darkCol, tokens: darkTokens },
  };
}

/** Entries in `tokens` whose value differs from (or is absent from) `baseline`. */
function diffTokens(
  tokens: Record<string, TokenValue>,
  baseline: Record<string, TokenValue>,
): Record<string, TokenValue> {
  const result: Record<string, TokenValue> = {};
  for (const [path, token] of Object.entries(tokens)) {
    if (baseline[path]?.$value !== token.$value) {
      result[path] = token;
    }
  }
  return result;
}

/**
 * Convert a {light.X} or {dark.X} raw ref to var(--light-X) / var(--dark-X) for the CSS cascade.
 * All other values are returned as-is (resolved hex, dimension, etc.).
 */
function toThemeAwareValue(resolvedValue: string, rawValue: string | undefined): string {
  if (rawValue && /^\{(light|dark)\.[^}]+\}$/.test(rawValue)) {
    // "{light.background.brand}" → "var(--light-background-brand)"
    return `var(${toCSSVar(rawValue.slice(1, -1))})`;
  }
  return resolvedValue;
}

function toCSSVar(path: string): string {
  return "--" + path.replace(/\./g, "-");
}

/**
 * `fontWeight` tokens hold Figma's named font style ("SemiBold") — CSS `font-weight`
 * only accepts `normal`/`bold` or a number 100-900, so this converts via the DTCG
 * alias table, falling back to DEFAULT_FONT_WEIGHT (with a warning) rather than
 * emitting an invalid declaration.
 */
function formatCSSValue($type: string, value: string): string {
  if ($type === "fontWeight") {
    const resolved = resolveFontWeightNumber(value);
    if (resolved === null) {
      console.warn(
        `[TokenSync] Unrecognized font weight "${value}" — using ${DEFAULT_FONT_WEIGHT}`,
      );
    }
    return String(resolved ?? DEFAULT_FONT_WEIGHT);
  }
  return value;
}
