/**
 * Shared icon set. Small inline SVGs instead of ad hoc unicode glyphs
 * (▼ ▶ ✓ ✕ ⟳ + − ~) so every icon has consistent stroke weight/size,
 * scales with font-size via `currentColor`, and carries an accessible label.
 */

import type { CSSProperties } from "react";

export interface IconProps {
  size?: number;
  style?: CSSProperties;
  label?: string;
}

function Svg({ size = 14, style, label, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: "block", ...style }}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

/** Chevron pointing right by default; rotate 90deg via `expanded` to point down. */
export function IconChevron({ expanded, ...props }: IconProps & { expanded?: boolean }) {
  return (
    <Svg
      {...props}
      style={{
        transition: "transform 120ms ease",
        transform: expanded ? "rotate(90deg)" : "none",
        ...props.style,
      }}
    >
      <path d="M6 3.5L11 8l-5 4.5" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.5 8a4.5 4.5 0 1 1-1.5-3.35" />
      <path d="M12.5 3.5v3h-3" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 8h9" />
    </Svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.5L5 8l5 4.5" />
    </Svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5L11 8l-5 4.5" />
    </Svg>
  );
}
