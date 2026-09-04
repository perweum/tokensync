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

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.sm,
        padding: `${space.xs + 2}px ${space.sm + 2}px`,
        fontSize: font.size.md,
        outline: "none",
        fontFamily: font.family,
        ...props.style,
      }}
    />
  );
}
