/**
 * Typography values as CSS wants them.
 *
 * What's *stored* in a token file stays exactly what Figma holds — a font
 * style name ("Expanded Medium Italic"), a line height as a bare number that
 * means percent ("140"), letter spacing the same way, text case as one of
 * Figma's words ("upper"). That's what keeps Figma <-> repo sync lossless. But
 * dropped straight into CSS most of those are wrong or lossy: `line-height: 140`
 * is 140x the font size, `text-transform: upper` is invalid, and a font style
 * name can't be a `font-weight` at all. Everything here is a one-way, output-
 * only translation — nothing in this file is ever read back.
 *
 * Only applied to tokens that belong to a marked typography group (see
 * typographyFieldIndex): there, a bare number means percent by this repo's own
 * convention. A free-standing number named lineHeight is just a number.
 */

import type { ResolvedCollection } from "../token-merger";
import type { TypographyField } from "../typography-styles";
import { parseFontStyleName, type FontStyleOverrides } from "../font-weight";
import { resolveTextCase, resolveTextDecoration } from "../text-style-figma-fields";

/** Rounds to at most `decimals` places — and drops the float noise `String()` would show. */
function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/** A percent as a plain ratio: 150 -> 1.5. The percent is rounded first (Figma stores 130% as 129.99999523162842). */
function percentToRatio(percent: number): string {
  return String(Number((roundTo(percent, 3) / 100).toFixed(5)));
}

const NUMBER_WITH_UNIT = /^(-?\d*\.?\d+)(%|px|em|rem)?$/;

/**
 * Line height. A bare number (or "%") is a percent -> the unitless ratio CSS
 * expects (150 -> 1.5). A px value stays px. Anything else — "normal", calc(),
 * a var() — is left alone.
 */
export function formatLineHeightCSS(value: string): string {
  const m = NUMBER_WITH_UNIT.exec(value.trim());
  if (!m) return value;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === undefined || unit === "%") return percentToRatio(n);
  return `${roundTo(n, 3)}${unit}`;
}

/** Letter spacing. A bare number (or "%") is a percent -> em (4 -> 0.04em). px/em stay as they are. */
export function formatLetterSpacingCSS(value: string): string {
  const m = NUMBER_WITH_UNIT.exec(value.trim());
  if (!m) return value;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === undefined || unit === "%") return `${percentToRatio(n)}em`;
  return `${roundTo(n, 3)}${unit}`;
}

const TEXT_CASE_CSS: Record<string, string> = {
  UPPER: "uppercase",
  LOWER: "lowercase",
  TITLE: "capitalize",
  ORIGINAL: "none",
};

/** `text-transform` value for Figma's textCase. Small caps has no text-transform form, so it (and anything unknown) is left as it was. */
export function formatTextCaseCSS(value: string): string {
  const resolved = resolveTextCase(value);
  return (resolved && TEXT_CASE_CSS[resolved]) ?? value;
}

const TEXT_DECORATION_CSS: Record<string, string> = {
  NONE: "none",
  UNDERLINE: "underline",
  STRIKETHROUGH: "line-through",
};

/** `text-decoration` value for Figma's textDecoration. */
export function formatTextDecorationCSS(value: string): string {
  const resolved = resolveTextDecoration(value);
  return (resolved && TEXT_DECORATION_CSS[resolved]) ?? value;
}

/** The CSS form of one typography field's stored value. Fields with nothing to translate pass through. */
export function formatTypographyField(field: TypographyField, value: string): string {
  switch (field) {
    case "lineHeight":
      return formatLineHeightCSS(value);
    case "letterSpacing":
      return formatLetterSpacingCSS(value);
    case "textCase":
      return formatTextCaseCSS(value);
    case "textDecoration":
      return formatTextDecorationCSS(value);
    default:
      return value;
  }
}

/**
 * `${typography group path}.${field}` -> field, for every marked typography
 * group in any collection. This is what tells the formatter that
 * `typography.body.lineHeight` is a Text Style's line height (a percent) and
 * not just some number that happens to be called that.
 */
export function typographyFieldIndex(
  collections: ResolvedCollection[],
): Map<string, TypographyField> {
  const index = new Map<string, TypographyField>();
  for (const collection of collections) {
    for (const style of collection.typographyStyles) {
      for (const field of Object.keys(style.fields)) {
        index.set(`${style.path}.${field}`, field as TypographyField);
      }
    }
  }
  return index;
}

/**
 * The sibling declarations a font style name needs beyond `font-weight`:
 * `font-stretch` and `font-style`, as (token path, value) pairs — paths so
 * they go through the same variable-naming as every other token.
 *
 * Only the non-default ones are emitted ("Regular" needs neither) — unless
 * `explicitDefaults`, used in override blocks (a non-default theme or colour
 * scheme), where a style that's *less* expanded than the base has to say so
 * rather than inherit the base's value.
 *
 * Naming: for a typography field called `fontWeight`, the sibling replaces
 * that segment (`typography.action.fontStretch`); for any other fontWeight
 * token it's appended (`font-weight.display.bold-fontStretch`).
 */
export function fontStyleSiblings(
  path: string,
  resolvedValue: string,
  overrides: FontStyleOverrides | undefined,
  explicitDefaults: boolean,
): Array<[string, string]> {
  const parsed = parseFontStyleName(resolvedValue, overrides);
  if (!parsed.recognized) return [];

  const siblingPath = (name: string) =>
    path.endsWith(".fontWeight") || path === "fontWeight"
      ? `${path.slice(0, path.length - "fontWeight".length)}${name}`
      : `${path}-${name}`;

  const out: Array<[string, string]> = [];
  if (parsed.stretch !== null || explicitDefaults) {
    out.push([siblingPath("fontStretch"), parsed.stretch ?? "100%"]);
  }
  if (parsed.style !== "normal" || explicitDefaults) {
    out.push([siblingPath("fontStyle"), parsed.style]);
  }
  return out;
}
