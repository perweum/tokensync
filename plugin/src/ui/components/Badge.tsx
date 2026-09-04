import { color, font } from "../theme";

export type BadgeTone = "changed" | "added" | "removed" | "neutral";

const toneColor: Record<BadgeTone, string> = {
  changed: color.accent.default,
  added: color.status.success.text,
  removed: color.status.danger.text,
  neutral: "#888888",
};

export function Badge({
  tone = "neutral",
  children,
  muted = false,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  /** Desaturated pill for a deselected/inactive context (e.g. an unchecked tab). */
  muted?: boolean;
}) {
  const c = muted ? "#aaaaaa" : toneColor[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        fontSize: font.size.xs,
        fontWeight: 500,
        padding: "2px 7px",
        borderRadius: 10,
        background: muted ? "#eeeeee" : `${c}18`,
        color: muted ? "#888888" : c,
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}
