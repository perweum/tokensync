import type { ButtonHTMLAttributes, ReactNode } from "react";
import { radius, space } from "../theme";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — IconButton has no visible text, so this is its only accessible name. */
  label: string;
  children: ReactNode;
}

/** Small square icon-only control (refresh, add, close, …). Always labeled for a11y. */
export function IconButton({ label, children, disabled, style, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="ts-icon-btn"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: 24,
        height: 24,
        padding: 0,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderStyle: "solid",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        gap: space.xs,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
