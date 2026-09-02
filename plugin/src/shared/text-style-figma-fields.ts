/**
 * Translates between Token Sync's typography field vocabulary and Figma's own
 * — field names Figma actually binds variables to, and the literal enum
 * values Figma expects for textCase/textDecoration (which can never be
 * variable-bound, per the Figma API — see shared/typography-styles.ts).
 *
 * Kept separate from typography-styles.ts, which is deliberately Figma-agnostic.
 */

import type { TypographyField } from "./typography-styles";

/**
 * Canonical field → the exact Figma VariableBindableTextField name to bind
 * through. Verified against a real Figma file (docs/design/text-styles-stage0-spike.md):
 * a fontWeight token holds a literal style name ("SemiBold") and MUST bind
 * through Figma's "fontStyle" field — Figma's own "fontWeight" field only
 * accepts a numeric weight-axis variable and rejects STRING outright
 * ("variable of resolved type 'STRING' cannot be bound to 'fontWeight'").
 * Every other field maps 1:1. textCase/textDecoration are intentionally
 * absent — Figma does not support binding them to a variable at all.
 */
export const FIGMA_BINDABLE_FIELD: Partial<Record<TypographyField, string>> = {
  fontFamily: "fontFamily",
  fontWeight: "fontStyle",
  fontSize: "fontSize",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  paragraphSpacing: "paragraphSpacing",
  paragraphIndent: "paragraphIndent",
};

export type FigmaTextCase =
  | "ORIGINAL"
  | "UPPER"
  | "LOWER"
  | "TITLE"
  | "SMALL_CAPS"
  | "SMALL_CAPS_FORCED";
export type FigmaTextDecoration = "NONE" | "UNDERLINE" | "STRIKETHROUGH";

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TEXT_CASE_ALIASES: Record<string, FigmaTextCase> = {
  none: "ORIGINAL",
  original: "ORIGINAL",
  uppercase: "UPPER",
  upper: "UPPER",
  lowercase: "LOWER",
  lower: "LOWER",
  capitalize: "TITLE",
  title: "TITLE",
  titlecase: "TITLE",
  smallcaps: "SMALL_CAPS",
  smallcapsforced: "SMALL_CAPS_FORCED",
};

const TEXT_DECORATION_ALIASES: Record<string, FigmaTextDecoration> = {
  none: "NONE",
  underline: "UNDERLINE",
  strikethrough: "STRIKETHROUGH",
  linethrough: "STRIKETHROUGH", // CSS text-decoration: line-through
};

/** Accepts CSS-familiar spellings ("uppercase") as well as Figma's own ("UPPER"). Null if unrecognized. */
export function resolveTextCase(value: string): FigmaTextCase | null {
  return TEXT_CASE_ALIASES[normalizeKey(value)] ?? null;
}

/** Accepts CSS-familiar spellings ("line-through") as well as Figma's own ("STRIKETHROUGH"). Null if unrecognized. */
export function resolveTextDecoration(value: string): FigmaTextDecoration | null {
  return TEXT_DECORATION_ALIASES[normalizeKey(value)] ?? null;
}
