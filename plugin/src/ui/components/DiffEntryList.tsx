/**
 * Shared diff-row rendering for both Pull and Push views. The two flows
 * differ in how collections are browsed (Pull: stacked sections you apply
 * all at once; Push: tabs you can select per-collection for the PR) — that
 * difference is real and stays — but the rows themselves, their colors,
 * icons and spacing were previously two near-identical copies that had
 * quietly drifted apart. This is the one copy both use now.
 */
import { useState } from "react";
import type { DiffEntry, DiffStatus } from "../../shared/token-diff";
import { groupByCategory } from "../../shared/token-diff";
import { CollapsibleSection } from "./CollapsibleSection";
import { IconArrowRight, IconMinus, IconPlus } from "../icons";
import { color, font, space } from "../theme";

export function DiffEntryList({ entries }: { entries: DiffEntry[] }) {
  const grouped = groupByCategory(entries);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(category: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  return (
    <div>
      {[...grouped.entries()].map(([category, catEntries]) => (
        <CollapsibleSection
          key={category}
          level="category"
          label={category}
          expanded={!collapsed.has(category)}
          onToggle={() => toggle(category)}
          right={
            <span style={{ fontSize: font.size.sm, color: color.text.muted }}>
              {catEntries.length}
            </span>
          }
        >
          {catEntries.map((entry) => (
            <DiffRow key={entry.path} entry={entry} />
          ))}
        </CollapsibleSection>
      ))}
    </div>
  );
}

function DiffRow({ entry }: { entry: DiffEntry }) {
  const isColor = entry.type === "color";
  const label = entry.path.split(".").slice(1).join(".");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        padding: `${space.xs + 2}px ${space.lg}px ${space.xs + 2}px ${space.xxl + space.sm}px`,
        borderBottom: `1px solid ${color.border.subtler}`,
        background: rowBackground(entry.status),
      }}
    >
      <StatusIcon status={entry.status} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span
          style={ellipsis({
            fontSize: font.size.sm,
            color: color.text.primary,
            fontFamily: font.mono,
          })}
        >
          {label}
        </span>
        {entry.description && (
          <span style={ellipsis({ fontSize: font.size.xs, color: color.text.muted })}>
            {entry.description}
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
        {entry.figmaValue !== null && (
          <Value value={entry.figmaValue} isColor={isColor} faded={entry.status === "changed"} />
        )}
        {entry.status === "changed" && (
          <IconArrowRight size={11} style={{ color: color.text.faint }} />
        )}
        {entry.githubValue !== null && (
          <Value value={entry.githubValue} isColor={isColor} faded={false} />
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: DiffStatus }) {
  if (status === "added")
    return <IconPlus size={13} style={{ color: color.status.success.text }} />;
  if (status === "removed")
    return <IconMinus size={13} style={{ color: color.status.danger.text }} />;
  // "changed" — the row already shows old → new inline, so this is just an attention dot.
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color.accent.default,
        flexShrink: 0,
      }}
    />
  );
}

function Value({ value, isColor, faded }: { value: string; isColor: boolean; faded: boolean }) {
  const swatchColor = isColor && (isHex(value) || isRgba(value)) ? value : null;
  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: space.xs, opacity: faded ? 0.45 : 1 }}
    >
      {swatchColor && (
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            flexShrink: 0,
            display: "inline-block",
            background: swatchColor,
            border: `1px solid ${isHex(value) && isLightColor(value) ? "#dddddd" : "#e0e0e0"}`,
          }}
        />
      )}
      <span style={{ fontSize: font.size.sm, color: color.text.secondary, fontFamily: font.mono }}>
        {shortValue(value)}
      </span>
    </span>
  );
}

function rowBackground(status: DiffStatus): string | undefined {
  if (status === "added") return color.status.success.bg;
  if (status === "removed") return color.status.danger.bg;
  return undefined;
}

function ellipsis(style: React.CSSProperties): React.CSSProperties {
  return { ...style, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
}

function isHex(v: string) {
  return /^#[0-9a-f]{3,8}$/i.test(v);
}
function isRgba(v: string) {
  return /^rgba?\(/i.test(v);
}
function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 200;
}
function shortValue(v: string): string {
  return v.length > 20 ? v.slice(0, 18) + "…" : v;
}
