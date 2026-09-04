import type { ButtonHTMLAttributes, ReactNode } from "react";
import { font, radius, space } from "../theme";

export type ButtonVariant = "primary" | "secondary" | "danger" | "dangerFilled" | "ghost";
export type ButtonSize = "standard" | "compact";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Icon rendered before the label. */
  icon?: ReactNode;
  type?: "button" | "submit" | "reset";
}

export function Button({
  children,
  variant = "secondary",
  size = "standard",
  fullWidth = false,
  icon,
  disabled = false,
  type = "button",
  className,
  style,
  ...rest
}: ButtonProps) {
  const isCompact = size === "compact" || variant === "ghost";

  // Deliberately no color/background/border-color here — those live only in
  // index.css (.ts-btn--*) so :hover/:active/:focus-visible can actually
  // take effect. An inline style always wins over an external stylesheet
  // rule for the same property, hover or not, so setting them here would
  // silently make every interactive state dead on arrival.
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    width: fullWidth ? "100%" : undefined,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    cursor: disabled ? "not-allowed" : "pointer",
    padding: isCompact ? `${space.xs}px ${space.sm}px` : `${space.xs + 2}px ${space.md}px`,
    fontFamily: font.family,
    fontWeight: 500,
    fontSize: isCompact ? font.size.sm : font.size.md,
    lineHeight: 1.3,
    whiteSpace: "nowrap",
    userSelect: "none",
    opacity: disabled ? 0.45 : 1,
    boxSizing: "border-box",
  };

  return (
    <button
      type={type}
      disabled={disabled}
      className={["ts-btn", `ts-btn--${variant}`, className].filter(Boolean).join(" ")}
      style={{ ...base, ...style }}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
