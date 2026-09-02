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
} from "../shared/text-style-figma-fields";
import { toFigmaVarName, fromFigmaVarName } from "../shared/token-format";
import { toFigmaValue } from "./figma-variables";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads every local Text Style and converts it to Token Sync's typography
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

function readLiteralField(style: TextStyle, field: TypographyField): string | null {
  switch (field) {
    case "fontFamily":
      return style.fontName.family;
    case "fontWeight":
      return style.fontName.style;
    case "fontSize":
      return String(style.fontSize);
    case "lineHeight":
      // "AUTO" has no numeric value. PERCENT vs PIXELS is not distinguished in
      // the emitted token — see the write-side note on the same assumption.
      return style.lineHeight.unit === "AUTO" ? null : String(style.lineHeight.value);
    case "letterSpacing":
      return "value" in style.letterSpacing ? String(style.letterSpacing.value) : null;
    case "paragraphSpacing":
      return String(style.paragraphSpacing);
    case "paragraphIndent":
      return String(style.paragraphIndent);
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
      applyOneStyle(style, typographyStyle, allVarsByName, resolvedFallback, errors);
      count++;
    } catch (err) {
      errors.push(`${figmaName}: ${String(err)}`);
    }
  }

  return { count, errors };
}

function applyOneStyle(
  style: TextStyle,
  typographyStyle: TypographyStyle,
  allVarsByName: Map<string, Variable>,
  resolvedFallback: Record<string, string>,
  errors: string[],
): void {
  // fontFamily and fontWeight combine into one fontName={family,style} property —
  // resolve both before assigning, and only override whichever half wasn't bound.
  let family: string | undefined;
  let weight: string | undefined;
  let familyBound = false;
  let weightBound = false;

  for (const field of TYPOGRAPHY_FIELDS) {
    const token = typographyStyle.fields[field];
    if (!token) continue;

    const bound = tryBind(style, field, token, allVarsByName);
    if (field === "fontFamily") familyBound = bound;
    if (field === "fontWeight") weightBound = bound;
    if (bound) continue;

    const literal = resolveLiteral(token, `${typographyStyle.path}.${field}`, resolvedFallback);
    if (literal === null) continue;

    switch (field) {
      case "fontFamily":
        family = literal;
        break;
      case "fontWeight":
        weight = literal;
        break;
      case "fontSize": {
        const n = toFigmaValue(literal, "FLOAT");
        if (typeof n === "number") style.fontSize = n;
        break;
      }
      case "lineHeight": {
        const n = toFigmaValue(literal, "FLOAT");
        // Assumed PERCENT — matches this repo's own convention (lineHeight
        // tokens store a percentage magnitude, e.g. "150" = 150%). A repo
        // storing lineHeight in absolute pixels would need this to be PIXELS
        // instead; not yet distinguished. See DECISIONS.md.
        if (typeof n === "number") style.lineHeight = { value: n, unit: "PERCENT" };
        break;
      }
      case "letterSpacing": {
        const n = toFigmaValue(literal, "FLOAT");
        if (typeof n === "number") style.letterSpacing = { value: n, unit: "PERCENT" };
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

  if ((family !== undefined || weight !== undefined) && !(familyBound && weightBound)) {
    style.fontName = {
      family: familyBound ? style.fontName.family : (family ?? style.fontName.family),
      style: weightBound ? style.fontName.style : (weight ?? style.fontName.style),
    };
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
