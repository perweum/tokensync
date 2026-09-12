/**
 * Figma Text Styles API helpers — the write/read counterpart to
 * figma-variables.ts for composite typography, following the same patterns
 * (find-or-create by name, VariableAlias resolution, non-fatal error
 * collection). Runs in the Figma plugin sandbox.
 *
 * Only styles whose path corresponds to a group marked "$type": "typography"
 * (see shared/typography-styles.ts) ever reach this file — detection and the
 * canonical shape live entirely in the Figma-agnostic shared layer.
 */

import type { TokenValue } from "../shared/messages";
import type { TypographyStyle, TypographyField } from "../shared/typography-styles";
import { TYPOGRAPHY_FIELDS, TYPOGRAPHY_FIELD_TOKEN_TYPE } from "../shared/typography-styles";
import {
  FIGMA_BINDABLE_FIELD,
  resolveTextCase,
  resolveTextDecoration,
  formatUnitValue,
  unitFromLiteral,
} from "../shared/text-style-figma-fields";
import { toFigmaVarName, fromFigmaVarName } from "../shared/token-format";
import { toFigmaValue } from "./figma-variables";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads every local Text Style and converts it to Token Spark's typography
 * style shape. A bound field becomes a {ref} pointing at the bound variable's
 * dot-path; an unbound field becomes its current literal value.
 */
export async function getLocalTypographyStyles(): Promise<TypographyStyle[]> {
  const styles = await figma.getLocalTextStylesAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();
  const varsById = new Map(allVars.map((v) => [v.id, v]));

  return styles.map((style) => {
    const path = fromFigmaVarName(style.name);
    const fields: Partial<Record<TypographyField, TokenValue>> = {};

    for (const field of TYPOGRAPHY_FIELDS) {
      const figmaField = FIGMA_BINDABLE_FIELD[field];
      const bound = figmaField
        ? style.boundVariables?.[figmaField as VariableBindableTextField]
        : undefined;

      if (bound) {
        const targetVar = varsById.get(bound.id);
        if (targetVar) {
          fields[field] = {
            $type: TYPOGRAPHY_FIELD_TOKEN_TYPE[field],
            $value: `{${fromFigmaVarName(targetVar.name)}}`,
          };
          continue;
        }
      }

      const literal = readLiteralField(style, field);
      if (literal !== null) {
        fields[field] = { $type: TYPOGRAPHY_FIELD_TOKEN_TYPE[field], $value: literal };
      }
    }

    return { path, fields };
  });
}

export function readLiteralField(style: TextStyle, field: TypographyField): string | null {
  switch (field) {
    case "fontFamily":
      return style.fontName.family;
    case "fontWeight":
      return style.fontName.style;
    case "fontSize":
      // $type "dimension" (see TYPOGRAPHY_FIELD_TOKEN_TYPE) — needs the "px"
      // every other dimension token in this codebase carries. Found live: a
      // bare "48" produced `--typography-h1-fontsize: 48;`, invalid CSS for
      // a font-size (formatCSSValue does no unit fallback for "dimension").
      // Safe to add unconditionally — the write side's toFigmaValue/
      // parseDimension already strips a "px" suffix before parsing back to
      // a float, unlike lineHeight below, where the suffix is a meaningful
      // PIXELS-vs-PERCENT marker, not just formatting.
      return `${style.fontSize}px`;
    case "lineHeight":
      return style.lineHeight.unit === "AUTO" ? null : formatUnitValue(style.lineHeight);
    case "letterSpacing":
      return formatUnitValue(style.letterSpacing);
    case "paragraphSpacing":
      // Same fix as fontSize just above — same $type "dimension", same
      // missing unit, same safe round-trip via parseDimension.
      return `${style.paragraphSpacing}px`;
    case "paragraphIndent":
      return `${style.paragraphIndent}px`;
    case "textCase":
      return style.textCase.toLowerCase();
    case "textDecoration":
      return style.textDecoration.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Applies typography styles to Figma: finds or creates a Text Style per
 * `path`, binding each field to a Variable where the token is a resolvable
 * {ref}, falling back to a literal value otherwise (or when Figma rejects
 * the bind — e.g. wrong resolved type).
 *
 * `resolvedFallback` mirrors applyTokensToCollection's `resolvedValues`
 * parameter: a flat `${path}.${field}` → resolved-value map (the caller
 * already has this — it's a subset of the collection's own resolved
 * `tokens` map) used when a ref can't be bound and the raw {ref} string
 * itself isn't a usable literal.
 *
 * Deliberately does not delete styles removed from the source repo — no diff
 * view exists yet for typography styles to make a deletion reviewable before
 * it happens (see DECISIONS.md).
 */
export async function applyTypographyStyles(
  styles: TypographyStyle[],
  resolvedFallback: Record<string, string> = {},
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  let count = 0;

  const allVars = await figma.variables.getLocalVariablesAsync();
  const allVarsByName = new Map(allVars.map((v) => [v.name, v]));

  const existing = await figma.getLocalTextStylesAsync();
  const stylesByName = new Map(existing.map((s) => [s.name, s]));

  for (const typographyStyle of styles) {
    const figmaName = toFigmaVarName(typographyStyle.path);
    try {
      let style = stylesByName.get(figmaName);
      if (!style) {
        style = figma.createTextStyle();
        style.name = figmaName;
        stylesByName.set(figmaName, style);
      }
      // Only count a style as applied if none of its own fields errored —
      // applyOneStyle pushes into the shared errors array rather than
      // throwing, so a per-field failure (an unrecognized textCase, e.g.)
      // wouldn't otherwise be reflected in the count at all.
      const errorsBefore = errors.length;
      await applyOneStyle(style, typographyStyle, allVarsByName, resolvedFallback, errors);
      if (errors.length === errorsBefore) count++;
    } catch (err) {
      errors.push(`${figmaName}: ${String(err)}`);
    }
  }

  return { count, errors };
}

/**
 * figma.loadFontAsync's own rejection is Figma-internal ("Cannot find font
 * ...") and unclear to a non-developer reading the apply-errors banner.
 * Reports a plain, actionable message instead: the font/style combination
 * needs to actually exist in this Figma file (installed locally, or a team
 * library font already used somewhere) before Token Spark can apply it.
 */
async function loadFontOrThrowClearError(fontName: FontName): Promise<void> {
  try {
    await figma.loadFontAsync(fontName);
  } catch {
    throw new Error(
      `Font "${fontName.family}" (${fontName.style}) isn't available in this file — ` +
        `install it, or check the name/style match exactly what Figma expects.`,
    );
  }
}

/**
 * Figma requires the font a TextStyle currently resolves to be loaded (via
 * figma.loadFontAsync) before *any* of its text properties can be written —
 * not just fontName itself. fontFamily/fontWeight are resolved and applied
 * (bind or literal) up front, before anything else touches the style, so
 * that whatever font ends up "current" is loaded exactly once before the
 * remaining fields (fontSize, lineHeight, …) are ever written.
 */
async function applyOneStyle(
  style: TextStyle,
  typographyStyle: TypographyStyle,
  allVarsByName: Map<string, Variable>,
  resolvedFallback: Record<string, string>,
  errors: string[],
): Promise<void> {
  const familyToken = typographyStyle.fields.fontFamily;
  const weightToken = typographyStyle.fields.fontWeight;

  const familyBound = familyToken
    ? tryBind(style, "fontFamily", familyToken, allVarsByName)
    : false;
  const weightBound = weightToken
    ? tryBind(style, "fontWeight", weightToken, allVarsByName)
    : false;

  const family =
    familyToken && !familyBound
      ? resolveLiteral(familyToken, `${typographyStyle.path}.fontFamily`, resolvedFallback)
      : undefined;
  const weight =
    weightToken && !weightBound
      ? resolveLiteral(weightToken, `${typographyStyle.path}.fontWeight`, resolvedFallback)
      : undefined;

  if ((family !== null && family !== undefined) || (weight !== null && weight !== undefined)) {
    if (!(familyBound && weightBound)) {
      const targetFontName: FontName = {
        family: familyBound ? style.fontName.family : (family ?? style.fontName.family),
        style: weightBound ? style.fontName.style : (weight ?? style.fontName.style),
      };
      await loadFontOrThrowClearError(targetFontName);
      style.fontName = targetFontName;
    }
  }

  // Whatever style.fontName resolves to now (via bind above or the literal
  // assignment just made) must be loaded before touching any other field —
  // fontSize/lineHeight/letterSpacing/etc. all require it, confirmed live
  // (Cannot write to node with unloaded font "Coop Sans Bold").
  await loadFontOrThrowClearError(style.fontName);

  for (const field of TYPOGRAPHY_FIELDS) {
    if (field === "fontFamily" || field === "fontWeight") continue;
    const token = typographyStyle.fields[field];
    if (!token) continue;

    const literal = resolveLiteral(token, `${typographyStyle.path}.${field}`, resolvedFallback);
    if (literal === null) continue;

    switch (field) {
      case "fontSize": {
        const n = toFigmaValue(literal, "FLOAT");
        if (typeof n === "number") style.fontSize = n;
        break;
      }
      case "lineHeight": {
        const n = toFigmaValue(literal, "FLOAT");
        // A bare number means PERCENT (this repo's own convention — "150" =
        // 150%); an explicit "px" suffix means PIXELS. See formatUnitValue's
        // read-side comment for why this string doubles as the unit marker.
        if (typeof n === "number") style.lineHeight = { value: n, unit: unitFromLiteral(literal) };
        break;
      }
      case "letterSpacing": {
        const n = toFigmaValue(literal, "FLOAT");
        if (typeof n === "number")
          style.letterSpacing = { value: n, unit: unitFromLiteral(literal) };
        break;
      }
      case "paragraphSpacing": {
        const n = toFigmaValue(literal, "FLOAT");
        if (typeof n === "number") style.paragraphSpacing = n;
        break;
      }
      case "paragraphIndent": {
        const n = toFigmaValue(literal, "FLOAT");
        if (typeof n === "number") style.paragraphIndent = n;
        break;
      }
      case "textCase": {
        const resolved = resolveTextCase(literal);
        if (resolved) style.textCase = resolved;
        else errors.push(`${style.name}: unrecognized textCase "${literal}"`);
        break;
      }
      case "textDecoration": {
        const resolved = resolveTextDecoration(literal);
        if (resolved) style.textDecoration = resolved;
        else errors.push(`${style.name}: unrecognized textDecoration "${literal}"`);
        break;
      }
    }
  }
}

/** Binds `token` to a Variable if it's a resolvable {ref} and Figma accepts the field. Returns whether it bound. */
function tryBind(
  style: TextStyle,
  field: TypographyField,
  token: TokenValue,
  allVarsByName: Map<string, Variable>,
): boolean {
  const figmaField = FIGMA_BINDABLE_FIELD[field];
  if (!figmaField) return false; // textCase/textDecoration — Figma cannot bind these
  if (!isPureRef(token.$value)) return false;

  const targetVar = allVarsByName.get(toFigmaVarName(extractRef(token.$value)));
  if (!targetVar) return false;

  try {
    style.setBoundVariable(figmaField as VariableBindableTextField, targetVar);
    return true;
  } catch {
    return false; // e.g. resolved type mismatch — fall through to literal
  }
}

/** A literal value, or an unresolvable ref's caller-supplied resolved fallback. */
function resolveLiteral(
  token: TokenValue,
  flatPath: string,
  resolvedFallback: Record<string, string>,
): string | null {
  if (!isPureRef(token.$value)) return token.$value;
  return resolvedFallback[flatPath] ?? null;
}

function isPureRef(value: string): boolean {
  return /^\{[^}]+\}$/.test(value);
}

function extractRef(value: string): string {
  return value.slice(1, -1);
}
