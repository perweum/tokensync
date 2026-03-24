"use strict";
/**
 * tokensync/v1 format utilities.
 * Shared between the plugin sandbox and the React UI — no Figma or browser APIs here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTokenValue = isTokenValue;
exports.isTokenTree = isTokenTree;
exports.flattenTokens = flattenTokens;
exports.resolveReference = resolveReference;
exports.resolveAllReferences = resolveAllReferences;
exports.toCSSVar = toCSSVar;
exports.toFigmaVarName = toFigmaVarName;
exports.fromFigmaVarName = fromFigmaVarName;
// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
function isTokenValue(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    return '$value' in value;
}
function isTokenTree(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    return !('$value' in value);
}
// ---------------------------------------------------------------------------
// Flatten / unflatten
// ---------------------------------------------------------------------------
/**
 * Flattens a nested TokenTree into dot-notation entries.
 *
 * { color: { brand: { 600: { $type: 'color', $value: '#1a52d8' } } } }
 * → { 'color.brand.600': { $type: 'color', $value: '#1a52d8' } }
 */
function flattenTokens(tree, prefix = '') {
    const result = {};
    for (const [key, value] of Object.entries(tree)) {
        if (key.startsWith('$'))
            continue; // skip $type, $description group-level fields
        const path = prefix ? `${prefix}.${key}` : key;
        if (isTokenValue(value)) {
            result[path] = value;
        }
        else if (isTokenTree(value)) {
            Object.assign(result, flattenTokens(value, path));
        }
    }
    return result;
}
/**
 * Resolve a reference like `{color.brand.600}` against a flat token map.
 * Returns the resolved $value string, or null if unresolvable.
 */
function resolveReference(ref, flat) {
    const match = ref.match(/^\{(.+)\}$/);
    if (!match)
        return ref; // not a reference — return as-is
    const path = match[1];
    const token = flat[path];
    if (!token)
        return null;
    // recurse if the resolved value is itself a reference
    if (token.$value.startsWith('{')) {
        return resolveReference(token.$value, flat);
    }
    return token.$value;
}
/**
 * Resolve all references in a flat token map.
 * Returns a new map with all $value fields fully resolved to raw values.
 * Unresolvable references are left as-is (they will fail validation).
 */
function resolveAllReferences(flat) {
    return Object.fromEntries(Object.entries(flat).map(([path, token]) => {
        const resolved = resolveReference(token.$value, flat);
        return [path, Object.assign(Object.assign({}, token), { $value: resolved !== null && resolved !== void 0 ? resolved : token.$value })];
    }));
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
function toCSSVar(path, prefix = '--') {
    return prefix + path.replace(/\./g, '-');
}
// ---------------------------------------------------------------------------
// Figma variable name conversion
// ---------------------------------------------------------------------------
/**
 * Converts a dot-notation token path to a Figma variable name (slash-separated).
 *
 * 'color.base.brand.default' → 'color/base/brand/default'
 */
function toFigmaVarName(path) {
    return path.replace(/\./g, '/');
}
/**
 * Converts a Figma variable name back to dot-notation path.
 *
 * 'color/base/brand/default' → 'color.base.brand.default'
 */
function fromFigmaVarName(name) {
    return name.replace(/\//g, '.');
}
