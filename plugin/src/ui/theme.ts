/**
 * Design tokens for the plugin UI. Single source of truth for color, spacing,
 * radius and type — every view/component should read from here instead of
 * hardcoding hex values or pixel sizes.
 *
 * Colors resolve to Figma's own --figma-color-* CSS variables (injected by
 * `figma.showUI(..., { themeColors: true })` in src/plugin/main.ts), which
 * follow Figma's light/dark theme automatically. Every reference carries our
 * previous hardcoded hex as a CSS fallback, so the UI still looks right
 * outside Figma — the dev preview (preview.tsx), or if themeColors is ever
 * unavailable — where those variables are never defined.
 *
 * https://developers.figma.com/docs/plugins/css-variables/
 */

/** `var(--figma-color-{name}, {fallback})` — see module doc above. */
function fig(name: string, fallback: string): string {
  return `var(--figma-color-${name}, ${fallback})`;
}

export const color = {
  text: {
    primary: fig("text", "#1a1a1a"),
    secondary: fig("text-secondary", "#555555"),
    muted: fig("text-tertiary", "#888888"),
    faint: fig("text-disabled", "#aaaaaa"),
  },
  border: {
    // Real outlines (inputs, buttons, icon buttons) — Figma's "strong" border role.
    default: fig("border-strong", "#dddddd"),
    // Divider lines (headers/footers/cards) — Figma's default border role.
    subtle: fig("border", "#eeeeee"),
    subtler: fig("border", "#f0f0f0"),
  },
  surface: {
    default: fig("bg", "#ffffff"),
    subtle: fig("bg-secondary", "#f8f8f8"),
    muted: fig("bg-tertiary", "#f0f0f0"),
  },
  accent: {
    default: fig("bg-brand", "#1a52d8"),
    hover: fig("bg-brand-hover", "#1547bd"),
    active: fig("bg-brand-pressed", "#123a99"),
    // Brand as text/border/icon color, not a background fill.
    text: fig("text-brand", "#1a52d8"),
    border: fig("border-brand", "#1a52d8"),
  },
  status: {
    // bg/border fallbacks stay as our own pastel tints deliberately — Figma's
    // confirmed --figma-color-bg-success/-warning/-danger are the same
    // saturation as their solid buttons (meant for toasts), not a soft banner
    // tint, and there's no confirmed lighter variant to reference instead.
    success: {
      text: fig("text-success", "#12702f"),
      bg: "#f0faf3",
      border: fig("border-success", "#b8e8c7"),
    },
    warning: {
      text: fig("text-warning", "#7a5c00"),
      bg: "#fff8e6",
      border: fig("border-warning", "#f0dca0"),
    },
    danger: {
      text: fig("text-danger", "#c00000"),
      bg: "#fff0f0",
      border: fig("border-danger-strong", "#f5c6c6"),
    },
    neutral: {
      text: fig("text-secondary", "#444444"),
      bg: fig("bg-secondary", "#f5f5f5"),
      border: fig("border", "#e0e0e0"),
    },
  },
  // Categorical (non-severity) colors for the primitives/global/themes/semantic/
  // sizes token roles — deliberately distinct hues from `status` above so a role
  // color is never mistaken for a success/warning/danger signal. Figma has no
  // equivalent variables for these (they're specific to this plugin's own
  // domain), so they stay plain hex rather than theme-following.
  role: {
    primitives: "#7c3aed",
    global: "#0d9488",
    themes: "#db2777",
    semantic: "#4f46e5",
    sizes: "#b45309",
    ignore: "#999999",
  },
} as const;

// 4px base scale — use these instead of arbitrary pixel values.
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radius = {
  // inputs, buttons, badges, chips
  sm: 6,
  // cards, panels, footers, larger containers
  md: 8,
} as const;

export const font = {
  family: "Inter, system-ui, -apple-system, sans-serif",
  mono: "monospace",
  size: {
    xs: 10,
    sm: 11,
    md: 12,
    lg: 13,
    xl: 14,
    xxl: 16,
  },
} as const;

export type Severity = "success" | "warning" | "danger" | "neutral";
