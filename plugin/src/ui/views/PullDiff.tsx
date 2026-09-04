/**
 * Pull diff view.
 * Shows what will change in Figma if the user applies the GitHub tokens.
 * Collections are displayed as vertically stacked expandable sections, each
 * with its own include checkbox — mirrors Push's per-collection selection,
 * so accepting a branch's changes doesn't have to be all-or-nothing.
 */

import { useState } from "react";
import type { CollectionDiff } from "../../shared/token-diff";
import { diffLabel } from "../../shared/token-diff";
import { Button } from "../components/Button";
import { CollapsibleSection } from "../components/CollapsibleSection";
import { Badge } from "../components/Badge";
import { DiffEntryList } from "../components/DiffEntryList";
import { DiffOverview } from "../components/DiffOverview";
import { StatusBanner } from "../components/StatusBanner";
import { ViewHeader } from "../components/ViewHeader";
import { IconCheck } from "../icons";
import { color, font, radius, space } from "../theme";
import type { DescribedError } from "../errors";

interface Props {
  diffs: CollectionDiff[];
  onApply: (selectedKeys: Set<string>) => void;
  onCleanApply: () => void;
  onBack: () => void;
  applying: boolean;
  error?: DescribedError;
}

export function PullDiff({ diffs, onApply, onCleanApply, onBack, applying, error }: Props) {
  const [confirmClean, setConfirmClean] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(diffs.map((d) => `${d.collectionName}/${d.modeName}`)),
  );

  // Selective apply — all collections included by default, mirrors PushDiff.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(diffs.map((d) => `${d.collectionName}/${d.modeName}`)),
  );

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelected(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasDiffs = diffs.some((d) => d.counts.total > 0);
  const selectedChanges = diffs
    .filter((d) => selectedKeys.has(`${d.collectionName}/${d.modeName}`))
    .reduce((n, d) => n + d.counts.total, 0);

  return (
    <div style={s.container}>
      <div style={s.header}>
        <ViewHeader title="Pull from GitHub" onBack={onBack} />
      </div>

      {!hasDiffs ? (
        <div style={s.empty}>
          <IconCheck size={26} style={{ color: color.status.success.text }} />
          <div style={s.emptyText}>Figma is up to date with GitHub</div>
          <div style={s.emptySubtext}>No token changes detected</div>
        </div>
      ) : (
        <>
          <DiffOverview diffs={diffs} unitLabel="collection" />

          <div style={s.body}>
            {diffs.map((diff) => {
              const key = `${diff.collectionName}/${diff.modeName}`;
              const label = diffLabel(diff);
              return (
                <div key={key} style={s.section}>
                  <CollapsibleSection
                    level="section"
                    label={label}
                    expanded={expanded.has(key)}
                    onToggle={() => toggleExpanded(key)}
                    right={
                      <div style={s.sectionRight}>
                        <CountBadges counts={diff.counts} />
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(key)}
                          onChange={() => toggleSelected(key)}
                          aria-label={`Include ${label} when applying`}
                          title={`Include ${label} when applying`}
                        />
                      </div>
                    }
                  >
                    <DiffEntryList entries={diff.entries} />
                  </CollapsibleSection>
                </div>
              );
            })}
          </div>

          <div style={s.footer}>
            {error && (
              <StatusBanner tone="danger" detail={error.detail}>
                {error.message}
              </StatusBanner>
            )}

            {confirmClean ? (
              <div style={s.confirmBox}>
                <div style={s.confirmText}>
                  This will delete and recreate <strong>all</strong> variables in sorted order —
                  regardless of the checkboxes above — which can briefly break existing references
                  to them elsewhere in Figma. Continue?
                </div>
                <div style={s.confirmBtns}>
                  <Button
                    variant="dangerFilled"
                    style={{ flex: 1 }}
                    onClick={() => {
                      setConfirmClean(false);
                      onCleanApply();
                    }}
                  >
                    Yes, clean apply
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmClean(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Button
                  variant="primary"
                  fullWidth
                  disabled={applying || selectedChanges === 0}
                  onClick={() => onApply(selectedKeys)}
                >
                  {applying
                    ? "Applying…"
                    : selectedChanges === 0
                      ? "Select collections to apply"
                      : `Apply (${selectedChanges})`}
                </Button>
                <Button
                  variant="danger"
                  fullWidth
                  disabled={applying}
                  onClick={() => setConfirmClean(true)}
                  title="Deletes all variables and recreates them in sorted order. Use when variable ordering is wrong."
                >
                  Clean apply
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CountBadges({ counts }: { counts: CollectionDiff["counts"] }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {counts.changed > 0 && <Badge tone="changed">{counts.changed} changed</Badge>}
      {counts.added > 0 && <Badge tone="added">{counts.added} added</Badge>}
      {counts.removed > 0 && <Badge tone="removed">{counts.removed} removed</Badge>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: {
    padding: `${space.md}px ${space.lg}px`,
    borderBottom: `1px solid ${color.border.subtle}`,
    flexShrink: 0,
  },

  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: space.xs + 2,
    color: color.text.secondary,
  },
  emptyText: { fontWeight: 500, fontSize: font.size.xl, color: color.text.primary },
  emptySubtext: { fontSize: font.size.md },

  body: { flex: 1, overflowY: "auto" },
  section: { borderBottom: `1px solid ${color.border.subtle}` },
  sectionRight: { display: "flex", alignItems: "center", gap: space.sm },

  footer: {
    flexShrink: 0,
    padding: `${space.md}px ${space.lg}px`,
    background: color.surface.default,
    borderTop: `1px solid ${color.border.subtle}`,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },

  confirmBox: {
    background: color.status.warning.bg,
    border: `1px solid ${color.status.warning.border}`,
    borderRadius: radius.md,
    padding: space.md,
    display: "flex",
    flexDirection: "column",
    gap: space.sm + 2,
  },
  confirmText: { fontSize: font.size.md, color: color.status.warning.text, lineHeight: 1.4 },
  confirmBtns: { display: "flex", gap: space.sm },
};
