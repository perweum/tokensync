/**
 * CSS transformer — generates CSS custom properties.
 *
 * Output structure (Primitives → Themes → Semantic):
 *   :root { ... }                              ← primitives + global + default theme + any
 *                                                 semantic value identical across every scheme
 *   [data-theme="zero"] { ... }                ← non-default theme — only vars that differ
 *                                                 from the default theme
 *   [data-size="desktop"] { ... }              ← non-default size mode — explicit pin,
 *                                                 only vars that differ from the default size
 *   @media (min-width: …) { :root { ... } }    ← same size-mode override, applied
 *                                                 automatically by viewport — unconditional,
 *                                                 no wrapper attribute needed (unlike
 *                                                 [data-color-scheme="auto"] below: a
 *                                                 breakpoint is something you're always
 *                                                 crossing, not an opt-in preference)
 *   [data-color-scheme="light"] { ... }        ← semantic roles that differ between schemes
 *   [data-color-scheme="dark"] { ... }         ← (same, dark)
 *   [data-color-scheme="auto"] + @media        ← follows OS preference
 *
 * A semantic token whose CSS output is identical in both light and dark (a
 * dimension token with no real scheme variance, e.g.) is hoisted into :root
 * instead of being repeated in both scheme blocks — determined purely by
 * comparing the two schemes' resolved values, not by any authoring convention
 * or token metadata. A var(--*) reference is never equal to its counterpart
 * by construction when the two schemes point at different paths, so
 * genuinely theme-aware tokens are never hoisted this way. Likewise, a
 * non-default theme only emits the variables that actually differ from the
 * default theme — anything identical is already covered by :root via the
 * cascade.
 *
 * Theme switching cascades automatically: changing [data-theme] on any ancestor
 * updates every CSS var a Theme mode owns, which Semantic selectors pick up
 * through the var(--*) references built by resolveSemanticValue below.
 *
 * Primitives is a genuine second axis, not just a single flat set of values:
 * Size (mobile/desktop breakpoints, e.g.) can vary specific primitives —
 * font-size, dimension — the same way Themes/Semantic already vary along
 * their own axes. It reuses exactly the same diffTokens/override mechanism,
 * just with a viewport-driven selector pair instead of an attribute-only one.
 * See docs/design/size-axis.md.
 */

import type { ResolvedCollection, Metadata } from "../token-merger";
import { findGlobalCollection } from "../token-merger";
import type { TokenValue } from "../messages";
import { resolveFontWeightNumber, DEFAULT_FONT_WEIGHT } from "../font-weight";
import type { FontStyleOverrides } from "../font-weight";
import type { TypographyField } from "../typography-styles";
import { toCSSVar, sameMode, pickDefaultMode, themeSearchOrder } from "../token-format";
import { formatTypographyField, fontStyleSiblings, typographyFieldIndex } from "./typography-css";

/**
 * What the value formatter needs beyond the token itself: which paths are a
 * marked typography group's fields (a bare lineHeight there means percent),
 * and the project's own font style name overrides from metadata.json.
 */
interface FormatContext {
  typographyFields: Map<string, TypographyField>;
  fontOverrides: FontStyleOverrides | undefined;
  /** metadata.remTokens, compiled — null when the option isn't set. */
  rem: { matchers: RegExp[]; base: number } | null;
}

/** A dot-path pattern: `*` is one path segment, `**` is anything, everything else literal. */
function pathPattern(pattern: string): RegExp {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^.]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
}

export function generateCSS(collections: ResolvedCollection[], metadata: Metadata): string {
  const blocks: string[] = [cssHeader()];

  const ctx: FormatContext = {
    typographyFields: typographyFieldIndex(collections),
    fontOverrides:
      metadata.fontStyles || metadata.fontStretchKeywords
        ? { fontStyles: metadata.fontStyles, stretchKeywords: metadata.fontStretchKeywords }
        : undefined,
    rem: metadata.remTokens?.length
      ? { matchers: metadata.remTokens.map(pathPattern), base: metadata.remBase ?? 16 }
      : null,
  };

  const names = metadata.figma.collections;
  const primitivesCols = collections.filter((c) => names.primitives.includes(c.collectionName));
  const global = findGlobalCollection(collections, names);
  const themeCols = collections.filter((c) => names.themes.includes(c.collectionName));
  const semanticCols = collections.filter((c) => names.semantic.includes(c.collectionName));

  // Config order (metadata.sizes) decides which primitives mode is the base —
  // written straight into :root — the same way metadata.themes[0]/colorSchemes
  // already decide the default theme/scheme. Falls back to the first mode
  // found when sizes isn't configured to match (or primitives has exactly one
  // mode, the common case with no Size axis at all).
  const defaultPrimitives = pickDefaultMode(metadata.sizes, primitivesCols, (c) => c.modeName);
  const nonDefaultPrimitives = primitivesCols.filter((c) => c !== defaultPrimitives);

  // Same reasoning as defaultPrimitives just above — config order decides the
  // default, not whatever order themeCols happened to arrive in (GitHub tree
  // order, or Figma's own mode order on the push side, neither of which is
  // guaranteed to put metadata.themes[0] first).
  const defaultTheme = pickDefaultMode(themeSearchOrder(metadata), themeCols, (c) => c.modeName);
  const nonDefaultThemes = themeCols.filter((c) => c !== defaultTheme);

  // Every path that will actually get its own `--var: value;` declaration in
  // :root (or under a per-theme/per-size override) — i.e. every ref a semantic
  // token could point at and have it resolve to something real at runtime. A
  // ref is only converted to var(--*) when its target is a member of this
  // set; this is what replaces "does the ref start with light./dark." — a
  // semantic alias can be nested arbitrarily ({color.light.X}, not just
  // {light.X}), and the correct test isn't the ref's spelling, it's whether
  // the thing it points at is really there. Every primitives mode's paths are
  // included, not just the default's — a typography token referencing a
  // size-varying primitive must still resolve to var(--*), or it would never
  // pick up the live size-switching cascade at all.
  const referenceableCSSVars = new Set([
    ...primitivesCols.flatMap((c) => Object.keys(c.tokens)),
    ...Object.keys(global?.tokens ?? {}),
    ...Object.keys(defaultTheme?.tokens ?? {}),
  ]);

  const lightCol = semanticCols.find((c) => sameMode(c.modeName, "light"));
  const darkCol = semanticCols.find((c) => sameMode(c.modeName, "dark"));
  const {
    shared: sharedSemantic,
    light: lightOnly,
    dark: darkOnly,
  } = splitSharedSemanticTokens(lightCol, darkCol, referenceableCSSVars, ctx);

  // Global: emit var(--*) for any ref whose target is a real CSS var — e.g. a
  // typography field referencing a theme-scoped font choice ({font-family.display})
  // or a size-varying primitive ({primitive.font-size.11}) — a resolved literal
  // for everything else. Same mechanism semantic tokens already use (below);
  // without it, a typography field's *resolved* value was baked in from
  // whichever theme/size happened to be "default" at generation time, with no
  // way to ever reflect a different theme or size — found live: switching
  // brand or viewport correctly re-colored everything but never changed a
  // single typeface, size, or weight.
  const globalExtra: Record<string, string> = {};
  if (global) {
    for (const [path, token] of Object.entries(global.tokens)) {
      if (token.$type === "boolean") continue;
      const rawValue = global.rawTokens[path]?.$value;
      const themeAware = resolveSemanticValue(token.$value, rawValue, referenceableCSSVars);
      for (const [declPath, value] of declarations(path, token, themeAware, ctx, false)) {
        globalExtra[declPath] = value;
      }
    }
  }

  // :root — the default primitives mode, the default theme's complete vars,
  // Global (as var()-aware entries, see globalExtra above), and any semantic
  // value that's identical across every color scheme (see
  // splitSharedSemanticTokens — those come back as already-final CSS value
  // strings too, not TokenValue, so they're appended rather than merged into
  // the formatCSSValue path below).
  const rootTokens: Record<string, TokenValue> = {
    ...defaultPrimitives?.tokens,
    ...defaultTheme?.tokens,
  };
  const rootBlock = cssBlockWithExtra(
    ":root",
    rootTokens,
    { ...globalExtra, ...sharedSemantic },
    ctx,
    false,
  );
  if (rootBlock) {
    blocks.push(rootBlock);
  }

  // Non-default themes — only the vars that actually differ from the default theme.
  // A value identical to the default needs no override: [data-theme] elements
  // already inherit it from :root via the cascade.
  for (const col of nonDefaultThemes) {
    const themeSlug = col.modeName.toLowerCase().replace(/\s+/g, "-");
    const overrides = diffTokens(col.tokens, defaultTheme?.tokens ?? {});
    blocks.push(cssBlock(`[data-theme="${themeSlug}"]`, overrides, ctx));
  }

  // Non-default size modes — explicit [data-size="…"] pin, always diffed
  // against the base mode: setting the attribute directly is a complete
  // override, independent of whatever any @media query elsewhere happens to
  // also match.
  for (const col of nonDefaultPrimitives) {
    const sizeSlug = col.modeName.toLowerCase().replace(/\s+/g, "-");
    const overrides = diffTokens(col.tokens, defaultPrimitives?.tokens ?? {});
    blocks.push(cssBlock(`[data-size="${sizeSlug}"]`, overrides, ctx));
  }

  // Responsive @media (min-width) cascade — only for modes with a configured
  // breakpoint, applied smallest-first. min-width queries aren't mutually
  // exclusive (a wide viewport matches every smaller breakpoint's query too),
  // so with 3+ tiers each block must state only what's *new* relative to the
  // tier immediately below it, not always the base — otherwise a property
  // that changes at one tier and reverts at a later one stays stuck at the
  // earlier tier's value once both queries match. Same "small, then medium,
  // then large" source-order rule Coop's own build tool encodes for exactly
  // this reason. Two tiers (one non-default mode) can never hit this — there's
  // nothing to stack — but it's real from three tiers on.
  const responsiveTiers = nonDefaultPrimitives
    .map((col) => {
      const sizeSlug = col.modeName.toLowerCase().replace(/\s+/g, "-");
      const breakpoint =
        metadata.sizeBreakpoints?.[sizeSlug] ?? metadata.sizeBreakpoints?.[col.modeName];
      return breakpoint === undefined ? null : { col, breakpoint };
    })
    .filter((t): t is { col: ResolvedCollection; breakpoint: number } => t !== null)
    .sort((a, b) => a.breakpoint - b.breakpoint);

  let previousTierTokens = defaultPrimitives?.tokens ?? {};
  for (const { col, breakpoint } of responsiveTiers) {
    const overrides = diffTokens(col.tokens, previousTierTokens);
    blocks.push(sizeMediaBlock(breakpoint, overrides, ctx));
    previousTierTokens = col.tokens;
  }

  // Semantic: Light/Dark modes — emit var(--*) for any alias whose target is a real
  // CSS var (theme-aliased tokens, but also e.g. a severity color aliasing a
  // primitive directly), resolved literals for anything else; entries identical in
  // both schemes were already hoisted into :root above and are absent here.
  if (lightOnly) {
    blocks.push(semanticBlock('[data-color-scheme="light"]', lightOnly, referenceableCSSVars, ctx));
    blocks.push(semanticBlock('[data-color-scheme="auto"]', lightOnly, referenceableCSSVars, ctx));
  }
  if (darkOnly) {
    blocks.push(semanticBlock('[data-color-scheme="dark"]', darkOnly, referenceableCSSVars, ctx));
    blocks.push(
      semanticMediaBlock(
        "(prefers-color-scheme: dark)",
        '[data-color-scheme="auto"]',
        darkOnly,
        referenceableCSSVars,
        ctx,
      ),
    );
  }

  return blocks.filter(Boolean).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

/**
 * Semantic block: emits var(--*) for a raw ref whose target is a real CSS var,
 * so theme/scheme switching cascades automatically, and a formatted literal
 * for everything else.
 */
function semanticBlock(
  selector: string,
  col: ResolvedCollection,
  referenceableCSSVars: Set<string>,
  ctx: FormatContext,
): string {
  const entries = Object.entries(col.tokens).filter(([, t]) => t.$type !== "boolean");
  if (entries.length === 0) return "";

  // A colour-scheme block is an override of :root, so a font style that's
  // plainer than the base must say so (explicit defaults) — see declarations().
  const lines = entries.flatMap(([path, token]) =>
    semanticDeclarations(col, path, token, referenceableCSSVars, ctx, true).map(
      ([declPath, value]) => `  ${toCSSVar(declPath)}: ${value};`,
    ),
  );

  return `${selector} {\n${lines.join("\n")}\n}`;
}

function semanticMediaBlock(
  query: string,
  selector: string,
  col: ResolvedCollection,
  referenceableCSSVars: Set<string>,
  ctx: FormatContext,
): string {
  const inner = semanticBlock(selector, col, referenceableCSSVars, ctx);
  if (!inner) return "";
  const indented = inner
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return `@media ${query} {\n${indented}\n}`;
}

/** Wraps a size mode's overrides in an unconditional @media (min-width) block
 * targeting :root — see the file header for why this is unconditional rather
 * than gated behind a wrapper attribute the way color-scheme's "auto" is. */
function sizeMediaBlock(
  minWidthPx: number,
  overrides: Record<string, TokenValue>,
  ctx: FormatContext,
): string {
  const inner = cssBlock(":root", overrides, ctx);
  if (!inner) return "";
  const indented = inner
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return `@media (min-width: ${minWidthPx}px) {\n${indented}\n}`;
}

/** A block that overrides :root (a non-default theme or size) — so explicit font-style defaults. */
function cssBlock(
  selector: string,
  tokens: Record<string, TokenValue>,
  ctx: FormatContext,
): string {
  return cssBlockWithExtra(selector, tokens, {}, ctx, true);
}

/**
 * Like cssBlock, but also appends already-final CSS value strings (from
 * splitSharedSemanticTokens — a var(--*) reference or a pre-formatted
 * literal) without running them through formatCSSValue a second time, which
 * would be wrong for a var() reference and could double-convert a fontWeight.
 */
function cssBlockWithExtra(
  selector: string,
  tokens: Record<string, TokenValue>,
  extra: Record<string, string>,
  ctx: FormatContext,
  explicitFontDefaults: boolean,
): string {
  const entries = Object.entries(tokens).filter(([, t]) => t.$type !== "boolean");
  const lines = entries.flatMap(([path, token]) =>
    declarations(path, token, null, ctx, explicitFontDefaults).map(
      ([declPath, value]) => `  ${toCSSVar(declPath)}: ${value};`,
    ),
  );
  const extraLines = Object.entries(extra).map(([path, value]) => `  ${toCSSVar(path)}: ${value};`);
  const allLines = [...lines, ...extraLines];
  if (allLines.length === 0) return "";
  return `${selector} {\n${allLines.join("\n")}\n}`;
}

function cssHeader(): string {
  return `/**\n * Design tokens — generated by Token Spark\n * Do not edit manually.\n */`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The final CSS value for one semantic entry. The single authoritative
 * computation, used both to decide what's shared across schemes and to
 * render the final declaration, so the two can never disagree.
 */
function semanticDeclarations(
  col: ResolvedCollection,
  path: string,
  token: TokenValue,
  referenceableCSSVars: Set<string>,
  ctx: FormatContext,
  explicitFontDefaults: boolean,
): Array<[string, string]> {
  const rawValue = col.rawTokens[path]?.$value;
  const themeAware = resolveSemanticValue(token.$value, rawValue, referenceableCSSVars);
  return declarations(path, token, themeAware, ctx, explicitFontDefaults);
}

/**
 * Splits light/dark semantic tokens into what's identical between the two schemes
 * (hoist to :root) and what genuinely differs (stays per-scheme). Two var(--*)
 * references pointing at different targets (e.g. --color-light-X vs
 * --color-dark-X) are never equal by construction, so this can never
 * accidentally hoist a genuinely theme-aware token — only tokens whose actual
 * CSS output happens to be byte-identical in both schemes.
 */
function splitSharedSemanticTokens(
  lightCol: ResolvedCollection | undefined,
  darkCol: ResolvedCollection | undefined,
  referenceableCSSVars: Set<string>,
  ctx: FormatContext,
): {
  /** Already-final CSS value strings — may be a var(--*) reference, so these
   * must never be re-run through formatCSSValue (see cssBlockWithExtra). */
  shared: Record<string, string>;
  light: ResolvedCollection | undefined;
  dark: ResolvedCollection | undefined;
} {
  if (!lightCol || !darkCol) {
    return { shared: {}, light: lightCol, dark: darkCol };
  }

  const shared: Record<string, string> = {};
  const lightTokens: Record<string, TokenValue> = {};
  const darkTokens: Record<string, TokenValue> = {};

  const allPaths = new Set([...Object.keys(lightCol.tokens), ...Object.keys(darkCol.tokens)]);

  for (const path of allPaths) {
    const lightToken = lightCol.tokens[path];
    const darkToken = darkCol.tokens[path];
    // Never emitted as CSS either way (see cssBlock/semanticBlock's own
    // filter) — omit entirely rather than hoisting a bogus --var: true;.
    if (lightToken?.$type === "boolean" || darkToken?.$type === "boolean") continue;

    if (lightToken && darkToken) {
      // Every declaration the token produces (its value, plus a font style's
      // stretch/italic siblings) must match, not just the primary one — else a
      // token whose width differs by scheme would be hoisted and lose it.
      const lightDecls = semanticDeclarations(
        lightCol,
        path,
        lightToken,
        referenceableCSSVars,
        ctx,
        false,
      );
      const darkDecls = semanticDeclarations(
        darkCol,
        path,
        darkToken,
        referenceableCSSVars,
        ctx,
        false,
      );
      if (JSON.stringify(lightDecls) === JSON.stringify(darkDecls)) {
        // The computed value IS the final declaration text (var() reference
        // or already-formatted literal) — storing the original TokenValue
        // here instead would silently discard the var() form and re-bake a
        // resolved literal once this reaches :root.
        for (const [declPath, value] of lightDecls) shared[declPath] = value;
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
 * Convert a pure {ref} into a var(--*) reference to its target — but only when
 * the target is actually going to exist as its own CSS declaration
 * (`referenceableCSSVars`, built by the caller from primitives + global + the
 * default theme). This is not a pattern match on the ref's spelling: Coop's
 * real data aliases through {color.light.X} / {color.dark.X}, one segment
 * deeper than this project's own {light.X} / {dark.X} convention, and there's
 * no reliable spelling rule that covers every real-world naming scheme without
 * risking a false match on an unrelated token whose path happens to contain
 * "light" or "dark". Checking the target actually resolves to something real
 * is both more general and strictly safer: a var() reference is only ever
 * emitted when it's guaranteed to resolve.
 *
 * This also means a severity token that aliases a primitive directly (not
 * theme-dependent at all) gets the same var(--*) treatment — correct: if the
 * primitive's value ever changes, the semantic role should reflect it too,
 * the same way it would if written by hand in CSS.
 */
function resolveSemanticValue(
  resolvedValue: string,
  rawValue: string | undefined,
  referenceableCSSVars: Set<string>,
): string {
  if (rawValue && /^\{[^}]+\}$/.test(rawValue)) {
    const refPath = rawValue.slice(1, -1);
    if (referenceableCSSVars.has(refPath)) {
      return `var(${toCSSVar(refPath)})`;
    }
  }
  return resolvedValue;
}

/** Whether a token carries a Figma font style name (a `fontWeight`), by its type or as a typography field. */
function isFontStyleToken(path: string, $type: string, ctx: FormatContext): boolean {
  return $type === "fontWeight" || ctx.typographyFields.get(path) === "fontWeight";
}

/**
 * A literal token value as CSS wants it.
 *
 * `fontWeight` tokens hold Figma's named font style ("SemiBold",
 * "Expanded Medium") — CSS `font-weight` only accepts `normal`/`bold` or a
 * number, so the weight is read out of the name, falling back to
 * DEFAULT_FONT_WEIGHT (with a warning) rather than emitting an invalid
 * declaration. A marked typography group's lineHeight / letterSpacing /
 * textCase / textDecoration are translated too (see typography-css.ts).
 * Everything else passes through.
 */
function formatCSSValue(path: string, $type: string, value: string, ctx: FormatContext): string {
  return toRem(path, formatBaseCSSValue(path, $type, value, ctx), ctx);
}

/** A px value as rem — only for the tokens `remTokens` names, and only a plain px number. */
function toRem(path: string, value: string, ctx: FormatContext): string {
  if (!ctx.rem || !ctx.rem.matchers.some((m) => m.test(path))) return value;
  const m = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  return m ? `${Number((Number(m[1]) / ctx.rem.base).toFixed(4))}rem` : value;
}

function formatBaseCSSValue(
  path: string,
  $type: string,
  value: string,
  ctx: FormatContext,
): string {
  if (isFontStyleToken(path, $type, ctx)) {
    const resolved = resolveFontWeightNumber(value, ctx.fontOverrides);
    if (resolved === null) {
      console.warn(
        `[TokenSpark] Unrecognized font weight "${value}" — using ${DEFAULT_FONT_WEIGHT}`,
      );
    }
    return String(resolved ?? DEFAULT_FONT_WEIGHT);
  }
  const field = ctx.typographyFields.get(path);
  return field ? formatTypographyField(field, value) : value;
}

/**
 * Every CSS declaration one token produces, as (token path, value) pairs — a
 * path, not a variable name, so everything goes through toCSSVar the same way.
 *
 * The first pair is the token itself. A font style name additionally yields
 * `font-stretch` / `font-style` siblings when it's wide or italic (see
 * fontStyleSiblings). `themeAware`, when given, is the already-computed value
 * of a semantic or global entry: a `var(--*)` reference is emitted as it is
 * (never reformatted — the variable it points at holds the formatted value),
 * but its siblings are still worked out from the token's resolved value,
 * since a reference can't carry them.
 *
 * `explicitFontDefaults` is for blocks that override :root (non-default
 * themes, sizes and colour schemes): a style plainer than the base has to say
 * "100%" / "normal" instead of leaving the base's width to leak through.
 */
function declarations(
  path: string,
  token: TokenValue,
  themeAware: string | null,
  ctx: FormatContext,
  explicitFontDefaults: boolean,
): Array<[string, string]> {
  const primary =
    themeAware !== null && themeAware.startsWith("var(")
      ? themeAware
      : formatCSSValue(path, token.$type, themeAware ?? token.$value, ctx);
  const out: Array<[string, string]> = [[path, primary]];
  if (isFontStyleToken(path, token.$type, ctx)) {
    out.push(...fontStyleSiblings(path, token.$value, ctx.fontOverrides, explicitFontDefaults));
  }
  return out;
}
