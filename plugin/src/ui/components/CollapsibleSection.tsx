import type { ReactNode } from "react";
import { color, font, listSlot, space } from "../theme";
import { IconChevron } from "../icons";

export type CollapsibleLevel = "section" | "category";

/**
 * Expand/collapse row shared by both diff views — collection-level sections
 * in Pull, category groupings in both Pull and Push. `level` controls
 * typography/background so the two nesting depths stay visually distinct,
 * but both share the same left padding and the same `listSlot` column
 * widths for `left`/chevron — a category row has no `left` control, but
 * still reserves `listSlot.lead` for it, so its chevron (and everything
 * that follows) lines up with a section row's chevron rather than sitting
 * further left. Same reasoning connects this to DiffEntryList's entry rows,
 * one level deeper still: they reuse these exact slot widths so a diff
 * entry's icon and label land on the same two columns too.
 *
 * The row (not the toggle button) carries the padding/background/hover, and
 * `left`/`right` render as the button's siblings rather than its children —
 * a checkbox or other interactive control nested inside a `<button>` is
 * invalid HTML and unpredictable for both click and keyboard activation.
 */
export function CollapsibleSection({
  level = "section",
  label,
  left,
  right,
  expanded,
  onToggle,
  children,
}: {
  level?: CollapsibleLevel;
  label: string;
  /** e.g. an "include this in the PR/apply" checkbox — kept separate from
   * the toggle button so it has its own, unambiguous click target instead
   * of competing with "click to expand" for the same gesture. */
  left?: ReactNode;
  right?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const isCategory = level === "category";
  const padding = isCategory
    ? `${space.xs + 2}px ${space.lg}px`
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
        <span style={s.leadSlot}>{left}</span>
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
          <span style={s.iconSlot}>
            <IconChevron
              expanded={expanded}
              size={isCategory ? 9 : 10}
              style={{ color: color.text.muted }}
            />
          </span>
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

const s: Record<string, React.CSSProperties> = {
  leadSlot: {
    width: listSlot.lead,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  iconSlot: {
    width: listSlot.icon,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
};
