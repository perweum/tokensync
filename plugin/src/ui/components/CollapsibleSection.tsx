import type { ReactNode } from "react";
import { color, font, space } from "../theme";
import { IconChevron } from "../icons";

export type CollapsibleLevel = "section" | "category";

/**
 * Expand/collapse row shared by both diff views — collection-level sections
 * in Pull, category groupings in both Pull and Push. `level` controls
 * indent/typography so the two nesting depths stay visually distinct but
 * share one implementation.
 *
 * The row (not the toggle button) carries the padding/background/hover, and
 * `right` renders as the button's sibling rather than its child — a
 * checkbox or other interactive control nested inside a `<button>` is
 * invalid HTML and unpredictable for both click and keyboard activation.
 */
export function CollapsibleSection({
  level = "section",
  label,
  right,
  expanded,
  onToggle,
  children,
}: {
  level?: CollapsibleLevel;
  label: string;
  right?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const isCategory = level === "category";
  const padding = isCategory
    ? `${space.xs + 2}px ${space.lg}px ${space.xs + 2}px ${space.xxl + space.sm}px`
    : `${space.sm + 2}px ${space.lg}px`;

  return (
    <div>
      <div
        className={`ts-collapsible-row ts-collapsible-row--${level}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          padding,
          borderBottom: isCategory ? `1px solid ${color.border.subtle}` : "none",
        }}
      >
        <button
          type="button"
          className="ts-collapsible-trigger"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: 0,
            border: "none",
            background: "none",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <IconChevron
            expanded={expanded}
            size={isCategory ? 9 : 10}
            style={{ color: color.text.muted }}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: isCategory ? font.size.md : font.size.lg,
              fontWeight: 600,
              color: isCategory ? color.text.secondary : color.text.primary,
              textTransform: isCategory ? "capitalize" : "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
        </button>
        {right}
      </div>
      {expanded && children}
    </div>
  );
}
