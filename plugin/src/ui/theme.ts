/**
 * Design tokens for the plugin UI. Single source of truth for color, spacing,
 * radius and type — every view/component should read from here instead of
 * hardcoding hex values or pixel sizes.
 */

export const color = {
  text: {
    primary: "#1a1a1a",
    secondary: "#555555",
    muted: "#888888",
    faint: "#aaaaaa",
  },
  border: {
    default: "#dddddd",
    subtle: "#eeeeee",
    subtler: "#f0f0f0",
  },
  surface: {
    default: "#ffffff",
    subtle: "#f8f8f8",
    muted: "#f0f0f0",
  },
  accent: {
    default: "#1a52d8",
    hover: "#1547bd",
    active: "#123a99",
  },
  status: {
    success: { text: "#12702f", bg: "#f0faf3", border: "#b8e8c7" },
    warning: { text: "#7a5c00", bg: "#fff8e6", border: "#f0dca0" },
    danger: { text: "#c00000", bg: "#fff0f0", border: "#f5c6c6" },
    neutral: { text: "#444444", bg: "#f5f5f5", border: "#e0e0e0" },
  },
  // Categorical (non-severity) colors for the primitives/global/themes/semantic/
  // sizes token roles — deliberately distinct hues from `status` above so a role
  // color is never mistaken for a success/warning/danger signal.
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
