/**
 * Naming helpers shared by dart.ts and swift.ts — both languages have the
 * same identifier rules for what this project generates (camelCase fields,
 * PascalCase type names, a leading digit rejected but a mid-identifier one
 * fine). These used to be defined independently in each file
 * (toDartFieldName/toSwiftFieldName, dartClassName/swiftStructName) —
 * confirmed byte-identical but for their names, already patched together
 * once for the same live bug (a leading-digit path segment) with no shared
 * helper introduced at the time. One copy here means there's nothing left
 * to fall out of sync between the two platforms.
 */

/**
 * "color.brand.500" → "colorBrand500"
 *
 * A digit mid-identifier is fine ("colorBrand500"), but Dart and Swift both
 * reject one as the very first character. Found live: a Figma size step
 * literally named "2xl" (a common type-scale name alongside xs/sm/md/lg/xl)
 * produced "2xldisplayLetterspacing" — invalid in both languages, since the
 * *first* path segment starts with a digit.
 */
export function toFieldName(path: string): string {
  const name = path
    .split(".")
    .map((segment, i) =>
      i === 0
        ? segment.toLowerCase().replace(/[^a-z0-9]/g, "")
        : segment.charAt(0).toUpperCase() +
          segment
            .slice(1)
            .toLowerCase()
            .replace(/[^a-zA-Z0-9]/g, ""),
    )
    .join("");
  return /^\d/.test(name) ? `_${name}` : name;
}

/** "Light" → "Light", "Default/Light" → "Light", "Brand-A/Dark" → "BrandADark" */
export function toModeTypeName(modeName: string): string {
  return (
    modeName
      .split("/")
      .map((p) => p.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string) => (c ? c.toUpperCase() : "")))
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("")
      .replace("Default", "") || "Default"
  );
}

/**
 * Snaps a resolved font-weight number to the nearest 100-step (100-900) —
 * the shared part of dartFontWeight/swiftFontWeight's snapping logic. Each
 * platform still does its own final formatting from the snapped step
 * (Dart: `FontWeight.w${step}`; Swift: a named `Font.Weight` case), since
 * that part genuinely differs between the two languages.
 */
export function snapFontWeightStep(n: number): number {
  return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
}
