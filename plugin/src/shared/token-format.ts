/**
 * tokenspark/v1 format utilities.
 * Shared between the plugin sandbox and the React UI — no Figma or browser APIs here.
 */

import type { TokenTree, TokenValue } from "./messages";

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTokenValue(value: unknown): value is TokenValue {
  if (typeof value !== "object" || value === null) return false;
  return "$value" in value;
}

export function isTokenTree(value: unknown): value is TokenTree {
  if (typeof value !== "object" || value === null) return false;
  return !("$value" in value);
}

/**
 * True for a value that is *only* a reference (e.g. "{color.brand.600}"),
 * as opposed to a literal or a composite string with an embedded ref (e.g.
 * "0 1px 2px {color.black.50}") — same pure-ref pattern resolveReference
 * below special-cases. Used to decide whether a Text-Style-derived
 * typography field is safe to overlay onto a Variable-derived one: a real
 * ref should always win, but an unbound literal must not silently clobber
 * an existing alias (see injectTypographyStyles in figma-to-tokens.ts).
 *
 * The single shared copy — figma-variables.ts and figma-text-styles.ts used
 * to each define their own, and this one's regex had drifted from theirs
 * (`.+`, greedy — matches straight through a `}`, so "{a}{b}" counted as one
 * pure ref) while the other two independently agreed on the stricter
 * `[^}]+` (correctly rejecting it as two concatenated refs, not one).
 * Consolidated here with the stricter form both plugin-sandbox copies
 * already used, so there's exactly one definition to keep correct.
 */
export function isPureRef(value: string): boolean {
  return typeof value === "string" && /^\{[^}]+\}$/.test(value);
}

// ---------------------------------------------------------------------------
// Flatten / unflatten
// ---------------------------------------------------------------------------

/**
 * DTCG allows a numeric or boolean `$value` (`"$value": 16`, `true`), and
 * repo JSON is hand-editable, so one can appear. Everything downstream —
 * diffing, the transformers, Figma apply — assumes a string `$value` (every
 * value Figma-side is already stringified), so a raw number crashed
 * `.trim()`/`.startsWith()`/`.match()` well past the parse step. Coerced
 * once, at the point repo JSON enters the system, rather than defended
 * against at each of those call sites. Returns a copy; leaves objects/arrays
 * (composite values) untouched — those aren't supported yet and are a
 * separate, larger gap (see the Token Studio adapter in DECISIONS.md).
 */
export function coerceScalarValues(tree: TokenTree): TokenTree {
  const result: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(tree)) {
    if (key.startsWith("$")) {
      result[key] = node;
    } else if (isTokenValue(node)) {
      const v = node.$value as unknown;
      result[key] =
        typeof v === "number" || typeof v === "boolean" ? { ...node, $value: String(v) } : node;
    } else if (isTokenTree(node)) {
      result[key] = coerceScalarValues(node);
    } else {
      result[key] = node;
    }
  }
  return result as TokenTree;
}

/**
 * Flattens a nested TokenTree into dot-notation entries.
 *
 * { color: { brand: { 600: { $type: 'color', $value: '#1a52d8' } } } }
 * → { 'color.brand.600': { $type: 'color', $value: '#1a52d8' } }
 */
export function flattenTokens(
  tree: TokenTree,
  prefix = "",
  inheritedType = "",
): Record<string, TokenValue> {
  const result: Record<string, TokenValue> = {};
  const groupType = (tree as Record<string, unknown>)["$type"] as string | undefined;
  const effectiveType = groupType ?? inheritedType;

  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith("$")) continue; // skip $type, $description group-level fields
    const path = prefix ? `${prefix}.${key}` : key;

    if (isTokenValue(value)) {
      // Propagate group-level $type if the token doesn't have its own
      result[path] = value.$type ? value : { ...value, $type: effectiveType };
    } else if (isTokenTree(value)) {
      Object.assign(result, flattenTokens(value, path, effectiveType));
    }
  }

  return result;
}

/**
 * Resolve a reference (or embedded references) against a flat token map.
 *
 * Handles two cases:
 *   Pure ref:     "{color.brand.600}"          → resolves to a single value
 *   Embedded ref: "0 1px 2px {color.black.50}" → each {ref} is substituted inline
 *
 * Returns the resolved string, or null if a pure ref target is missing or a
 * circular reference is detected (a token whose resolution chain loops back
 * on itself, e.g. a aliases b aliases a — otherwise unbounded recursion,
 * which previously crashed the whole plugin with an unhelpful stack
 * overflow instead of a clear, targeted warning).
 *
 * `chain` tracks the paths visited so far in the current resolution — not
 * meant to be passed by external callers, only threaded through recursion.
 */
export function resolveReference(
  ref: string,
  flat: Record<string, TokenValue>,
  chain: readonly string[] = [],
): string | null {
  // A referenced token's own $value can be malformed (not a string) in real,
  // live data this code doesn't control — found live testing a design system
  // whose Figma structure this project hadn't seen before: a token somewhere
  // in the resolution chain had a non-string $value, crashing the whole plugin
  // UI with an unhandled TypeError and no visible error (see handlePushCollectionsLoaded's
  // try/catch in Sync.tsx). Same "missing target" fallback as an unresolvable path.
  if (typeof ref !== "string") return null;
  // `[^{}]+`, not `.+` — greedy `.+` matches straight through a `}`, so a
  // composite like "{a} solid {b}" would count as ONE ref whose path is
  // "a} solid {b" and never reach the embedded-ref branch below. Same
  // definition as isPureRef above.
  const match = ref.match(/^\{([^{}]+)\}$/);
  if (match) {
    // Pure reference — look up and recurse
    const path = match[1];
    if (chain.includes(path)) {
      console.warn(`[TokenSpark] Circular token reference: ${[...chain, path].join(" -> ")}`);
      return null;
    }
    const token = flat[path];
    if (!token) return null;
    return resolveReference(token.$value, flat, [...chain, path]);
  }

  // Embedded references inside a composite value (e.g. shadow strings)
  if (ref.includes("{")) {
    return ref.replace(/\{([^}]+)\}/g, (_match, refPath: string) => {
      if (chain.includes(refPath)) {
        console.warn(`[TokenSpark] Circular token reference: ${[...chain, refPath].join(" -> ")}`);
        return _match;
      }
      const token = flat[refPath];
      if (!token) return _match;
      const resolved = resolveReference(token.$value, flat, [...chain, refPath]);
      return resolved ?? _match;
    });
  }

  return ref; // not a reference — return as-is
}

/**
 * Resolve all references in a flat token map.
 * Returns a new map with all $value fields fully resolved to raw values.
 * Unresolvable references are left as-is (they will fail validation).
 */
export function resolveAllReferences(flat: Record<string, TokenValue>): Record<string, TokenValue> {
  return Object.fromEntries(
    Object.entries(flat).map(([path, token]) => {
      const resolved = resolveReference(token.$value, flat);
      return [path, { ...token, $value: resolved ?? token.$value }];
    }),
  );
}

/**
 * Keep only the paths that appear in the allowlist — e.g. restricting a
 * resolved-against-shared-context flat map back to just the paths one
 * layer (a theme, a color scheme) actually owns. Was defined identically
 * in figma-to-tokens.ts (push) and token-merger.ts (pull) — one shared
 * copy so the two directions can't independently drift on this.
 */
export function filterByPaths(
  flat: Record<string, TokenValue>,
  paths: string[],
): Record<string, TokenValue> {
  const set = new Set(paths);
  return Object.fromEntries(Object.entries(flat).filter(([k]) => set.has(k)));
}

// ---------------------------------------------------------------------------
// Color formatting
// ---------------------------------------------------------------------------

/**
 * Formats a Figma RGBA color (each channel 0-1) as a token $value string —
 * hex for fully opaque, otherwise a decimal `rgba(r, g, b, a)` string with
 * alpha kept as a direct float, never quantized through an 8-bit byte first.
 *
 * The single shared copy of what figma-to-tokens.ts (push) and
 * useFigmaValues.ts (pull) used to each maintain independently — confirmed
 * identical by hand after they'd already drifted once: pull's own copy
 * quantized alpha via `Math.round(a * 255)` before converting back, which
 * agreed with push's direct `a.toFixed(2)` for almost every value except
 * 0.025 (rounds to "0.03" one way, "0.02" the other) — a permanent false
 * "changed" diff on every pull, for that one alpha value, until both sides
 * were manually re-synced. One shared function means there's nothing left
 * to keep in sync.
 */
export function formatFigmaColor(r: number, g: number, b: number, a: number): string {
  const hex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  if (Math.round(a * 255) === 255) return `#${hex(r)}${hex(g)}${hex(b)}`;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// CSS variable name conversion
// ---------------------------------------------------------------------------

/**
 * Converts a dot-notation token path to a CSS custom property name.
 *
 * 'color.base.brand.default' → '--color-base-brand-default'
 * 'radius.md'               → '--radius-md'
 */
export function toCSSVar(path: string, prefix = "--"): string {
  return prefix + path.replace(/\./g, "-");
}

// ---------------------------------------------------------------------------
// Figma variable name conversion
// ---------------------------------------------------------------------------

/**
 * Converts a dot-notation token path to a Figma variable name (slash-separated).
 *
 * 'color.base.brand.default' → 'color/base/brand/default'
 */
export function toFigmaVarName(path: string): string {
  return path.replace(/\./g, "/");
}

/**
 * Converts a Figma variable name back to dot-notation path.
 *
 * 'color/base/brand/default' → 'color.base.brand.default'
 */
export function fromFigmaVarName(name: string): string {
  return name.replace(/\//g, ".");
}

/**
 * Turns a real Figma mode name into a filename-safe slug — lowercase,
 * spaces/slashes to hyphens. Was independently defined 3 times
 * (token-merger.ts, figma-to-tokens.ts, CollectionMapping.tsx) — all three
 * must agree exactly for a file written on push to be found again on pull/
 * mapping lookups. See token-merger.ts's findCaseInsensitive doc comment
 * for the live bug (a real mode name containing a space) this class of
 * inconsistency caused.
 */
export function slugifyModeName(name: string): string {
  return name.toLowerCase().replace(/[\s/]+/g, "-");
}

/**
 * The one definition of "these two names are the same mode". A mode name
 * reaches the code in three spellings — the real Figma name ("Mode 1"),
 * metadata.json's entry for it (a real name, or a legacy filename slug like
 * "mode-1"), and the capitalised filename-derived form ("Mode-1") — and plain
 * `.toLowerCase()` equality only bridges the first of those gaps. Comparing
 * slugs bridges all of them, and is exactly how a mode's file is named on
 * disk, so two names this treats as the same could not have coexisted there
 * anyway.
 *
 * Only for *matching*. Output naming (CSS selectors, JS keys, Dart/Swift
 * identifiers) is a separate contract with downstream code and is
 * deliberately not routed through here.
 */
export function sameMode(a: string, b: string): boolean {
  return slugifyModeName(a) === slugifyModeName(b);
}

/**
 * The default among `candidates`: the first name in `configured` (config
 * order — metadata.themes/sizes/colorSchemes) that matches a candidate, else
 * the first candidate. Config order, not candidate order, decides — the
 * candidates arrive in GitHub tree order or Figma's own mode order, neither
 * of which is guaranteed to put the configured default first.
 *
 * Was independently re-implemented in figma-to-tokens.ts, token-merger.ts,
 * css.ts and sync-logic.ts, with slightly different matching rules and (in
 * parseRepository's theme lookup) no fallback at all — see DECISIONS.md's
 * default-theme-selection entries for the bugs that drift caused.
 */
export function pickDefaultMode<T>(
  configured: readonly string[],
  candidates: readonly T[],
  modeNameOf: (candidate: T) => string,
): T | undefined {
  for (const name of configured) {
    const match = candidates.find((c) => sameMode(modeNameOf(c), name));
    if (match !== undefined) return match;
  }
  return candidates[0];
}
