import type { ReactNode } from "react";
import { color, font, radius, space } from "../theme";
import { IconCheck, IconClose, IconRefresh } from "../icons";

export type StatusTone = "loading" | "success" | "warning" | "danger" | "neutral";

const toneStyle: Record<StatusTone, { text: string; bg: string; border: string }> = {
  loading: color.status.neutral,
  success: color.status.success,
  warning: color.status.warning,
  danger: color.status.danger,
  neutral: color.status.neutral,
};

function ToneIcon({ tone }: { tone: StatusTone }) {
  const size = 13;
  if (tone === "loading") {
    return <IconRefresh size={size} style={{ animation: "spin 1s linear infinite" }} />;
  }
  if (tone === "success") return <IconCheck size={size} />;
  if (tone === "danger") return <IconClose size={size} />;
  // warning / neutral share a simple filled dot — no icon overstates a low-severity notice
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "currentColor",
        flexShrink: 0,
      }}
    />
  );
}

/**
 * Severity-coded message banner — the single component for status text
 * across the plugin (loading/success/warning/error). Used both as the
 * persistent status line on the Sync screen and as inline notices in the
 * diff views.
 */
export function StatusBanner({
  tone,
  children,
  detail,
  action,
  title,
}: {
  tone: StatusTone;
  children: ReactNode;
  /** Optional technical detail (e.g. the raw error), shown smaller/muted below the message. */
  detail?: string;
  action?: ReactNode;
  /** Native tooltip — use for elaboration that doesn't need to cost permanent vertical space. */
  title?: string;
}) {
  const t = toneStyle[tone];
  return (
    <div
      title={title}
      style={{
        display: "flex",
        alignItems: detail ? "flex-start" : "center",
        gap: space.sm,
        fontSize: font.size.md,
        lineHeight: 1.4,
        padding: `${space.sm + 2}px ${space.md + 2}px`,
        borderRadius: radius.md,
        border: `1px solid ${t.border}`,
        background: t.bg,
        color: t.text,
      }}
    >
      <span style={{ marginTop: detail ? 2 : 0 }}>
        <ToneIcon tone={tone} />
      </span>
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span>{children}</span>
        {detail && (
          <span style={{ fontSize: font.size.sm, opacity: 0.7, fontFamily: font.mono }}>
            {detail}
          </span>
        )}
      </span>
      {action}
    </div>
  );
}
