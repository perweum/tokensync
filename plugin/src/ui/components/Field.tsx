import { cloneElement, useId, type ReactElement, type InputHTMLAttributes } from "react";
import { color, font, radius, space } from "../theme";

export interface FieldProps {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string }>;
}

/** Labeled form field wrapper — associates the label with its input via `htmlFor`/id. */
export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs / 2 }}>
      <label
        htmlFor={id}
        style={{ fontSize: font.size.md, fontWeight: 500, color: color.text.primary }}
      >
        {label}
      </label>
      {hint && <span style={{ fontSize: font.size.sm, color: color.text.muted }}>{hint}</span>}
      {cloneElement(children, { id })}
    </div>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      // Deliberately no inline `outline` — .ts-input's :focus-visible rule
      // in index.css needs to own that property; an inline value (even
      // "none") always wins over a CSS rule for the same property, focused
      // or not, so the focus ring would otherwise be dead on arrival (same
      // reasoning as Button.tsx's hover/active states).
      className={["ts-input", className].filter(Boolean).join(" ")}
      style={{
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.sm,
        padding: `${space.xs + 2}px ${space.sm + 2}px`,
        fontSize: font.size.md,
        fontFamily: font.family,
        ...props.style,
      }}
    />
  );
}
