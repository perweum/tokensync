/**
 * Detects and extracts "typography style" groups from a token tree — a group
 * explicitly marked `"$type": "typography"` whose direct children are individual
 * scalar sub-property tokens (fontFamily, fontWeight, fontSize, …).
 *
 * This is Token Sync's native composite typography shape: unlike DTCG's
 * single-object `typography` $value, or Token Studio's equivalent, values stay
 * decomposed into ordinary leaf tokens that already round-trip as Figma
 * Variables today (see tokens/semantic/global/typography.json). The group-level
 * marker is the ONLY new convention — it opts a group into also being synced as
 * a Figma Text Style, in addition to its children already syncing as Variables.
 * DTCG's own type-inheritance rule makes a group-level `$type` spec-legal.
 *
 * A source using a different shape (e.g. Token Studio's composite object) is
 * expanded into this same decomposed form by its own adapter before this ever
 * runs — this module only ever needs to understand the one canonical shape.
 * See docs/design/canonical-model.md.
 */

import type { TokenTree, TokenValue } from "./messages";

/**
 * Recognized sub-property fields. The first 8 map to Figma's
 * VariableBindableTextField (bindable to a Variable); textCase/textDecoration
 * are real TextStyle properties but Figma does not support binding them —
 * they can only ever be applied as literal values.
 */
export const TYPOGRAPHY_FIELDS = [
  "fontFamily",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
  "textCase",
  "textDecoration",
] as const;

export type TypographyField = (typeof TYPOGRAPHY_FIELDS)[number];

const FIELD_SET = new Set<string>(TYPOGRAPHY_FIELDS);

export interface TypographyStyle {
  /** Dot-path of the marked group, e.g. "text.heading.display" */
  path: string;
  /** Raw (ref-preserving) leaf token for each recognized field present in the group */
  fields: Partial<Record<TypographyField, TokenValue>>;
}

function isTokenValue(node: unknown): node is TokenValue {
  return typeof node === "object" && node !== null && "$value" in node;
}

function isPlainGroup(node: unknown): node is TokenTree {
  return typeof node === "object" && node !== null && !("$value" in node);
}

/**
 * Walk a token tree and collect every group marked `"$type": "typography"`.
 * Does not recurse into a marked group's own children looking for nested
 * marked groups — a typography style is a flat set of scalar fields, not a
 * nesting point. Ordinary (unmarked) groups are recursed into normally.
 */
export function extractTypographyStyles(tree: TokenTree, prefix = ""): TypographyStyle[] {
  const results: TypographyStyle[] = [];

  for (const [key, node] of Object.entries(tree)) {
    if (key.startsWith("$")) continue;
    const path = prefix ? `${prefix}.${key}` : key;

    if (isPlainGroup(node) && node.$type === "typography") {
      const fields: Partial<Record<TypographyField, TokenValue>> = {};
      for (const [fieldKey, fieldNode] of Object.entries(node)) {
        if (fieldKey.startsWith("$")) continue;
        if (FIELD_SET.has(fieldKey) && isTokenValue(fieldNode)) {
          fields[fieldKey as TypographyField] = fieldNode;
        }
      }
      results.push({ path, fields });
      continue;
    }

    if (isPlainGroup(node)) {
      results.push(...extractTypographyStyles(node, path));
    }
  }

  return results;
}
