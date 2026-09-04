/**
 * Push diff view.
 * Shows what will change on GitHub when the user creates a PR from Figma Variables.
 */

import { useState } from "react";
import type { CollectionDiff } from "../../shared/token-diff";
import { diffLabel } from "../../shared/token-diff";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { DiffEntryList } from "../components/DiffEntryList";
import { DiffOverview } from "../components/DiffOverview";
import { StatusBanner } from "../components/StatusBanner";
import { Field, TextInput } from "../components/Field";
import { ViewHeader } from "../components/ViewHeader";
import { IconCheck } from "../icons";
import { color, font, space } from "../theme";

interface Props {
  diffs: CollectionDiff[];
  /** Figma collection names that matched none of the configured layers — never included in the PR. */
  unrecognizedCollections?: string[];
  onCreatePR: (title: string, selectedKeys: Set<string>) => void;
  onBack: () => void;
  creating: boolean;
}

export function PushDiff({
  diffs,
  unrecognizedCollections = [],
  onCreatePR,
  onBack,
  creating,
}: Props) {
  const [prTitle, setPrTitle] = useState("chore: sync design tokens from Figma");
  const [activeTab, setActiveTab] = useState(0);

  // Selective sync — all collections selected by default
  const allKeys = diffs.map((d) => `${d.collectionName}/${d.modeName}`);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set(allKeys));

  function toggleKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectedChanges = diffs
    .filter((d) => selectedKeys.has(`${d.collectionName}/${d.modeName}`))
    .reduce((n, d) => n + d.counts.total, 0);

  const totalChanges = diffs.reduce((n, d) => n + d.counts.total, 0);
  const hasChanges = totalChanges > 0;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <ViewHeader title="Push to GitHub" onBack={onBack} />
      </div>

      {unrecognizedCollections.length > 0 && (
        <div style={{ margin: `${space.sm}px ${space.lg}px 0` }}>
          <StatusBanner
            tone="warning"
            title={`Not included in the PR. Use "Map collections" on the main screen to assign it a role, if this is unexpected.`}
          >
            Skipped {unrecognizedCollections.length}{" "}
            {unrecognizedCollections.length === 1 ? "collection" : "collections"} not in{" "}
            <code>figma.collections</code>: <strong>{unrecognizedCollections.join(", ")}</strong>
          </StatusBanner>
        </div>
      )}

      {!hasChanges ? (
        <div style={s.empty}>
          <IconCheck size={26} style={{ color: color.status.success.text }} />
          <div style={s.emptyText}>GitHub is already up to date</div>
          <div style={s.emptySubtext}>No changes detected between Figma and the repository</div>
        </div>
      ) : (
        <>
          <DiffOverview diffs={diffs} unitLabel="file" />

          <div style={s.tabHint}>
            Check a tab to include it in the PR — click its name to preview.
          </div>
          <div style={s.tabs}>
            {diffs.map((diff, i) => {
              const key = `${diff.collectionName}/${diff.modeName}`;
              const selected = selectedKeys.has(key);
              const label = diffLabel(diff);
              return (
                <div
                  key={key}
                  style={{
                    ...s.tab,
                    ...(activeTab === i ? s.tabActive : {}),
                    ...(!selected ? s.tabDeselected : {}),
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleKey(key)}
                    aria-label={`Include ${label} in the pull request`}
                    style={s.tabCheck}
                  />
                  <button
                    type="button"
                    className={`ts-tab${activeTab === i ? " ts-tab--active" : ""}`}
                    onClick={() => setActiveTab(i)}
                    title={`Preview ${label}`}
                    style={s.tabButton}
                  >
                    <span style={s.tabLabel}>{label}</span>
                    {diff.counts.total > 0 && (
                      <Badge tone="changed" muted={!selected}>
                        {diff.counts.total}
                      </Badge>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {(() => {
            const diff = diffs[activeTab];
            if (!diff || diff.counts.total === 0)
              return <div style={s.noDiff}>No changes in this collection</div>;
            return (
              <div style={s.diffList}>
                <DiffEntryList entries={diff.entries} />
              </div>
            );
          })()}

          <div style={s.footer}>
            <Field label="Pull request title">
              <TextInput value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              fullWidth
              disabled={creating || selectedChanges === 0}
              onClick={() =>
                onCreatePR(prTitle.trim() || "chore: sync design tokens from Figma", selectedKeys)
              }
            >
              {creating
                ? "Creating PR…"
                : selectedChanges === 0
                  ? "Select collections to include"
                  : `Create PR (${selectedChanges} change${selectedChanges !== 1 ? "s" : ""})`}
            </Button>
          </div>
        </>
      )}
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
  tabHint: {
    fontSize: font.size.xs,
    color: color.text.muted,
    padding: `${space.sm}px ${space.lg}px 0`,
  },
  tabs: {
    display: "flex",
    gap: space.xs + 2,
    padding: `${space.xs}px ${space.lg}px ${space.xs}px`,
    borderBottom: `1px solid ${color.border.subtle}`,
    overflowX: "auto",
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    borderRadius: "6px 6px 0 0",
    padding: `2px ${space.xs}px`,
    flexShrink: 0,
  },
  tabActive: { background: color.surface.muted },
  tabDeselected: { opacity: 0.55 },
  tabCheck: { margin: 0, cursor: "pointer", flexShrink: 0 },
  tabButton: {
    border: "none",
    fontSize: font.size.md,
    padding: `${space.xs + 1}px ${space.sm}px`,
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontFamily: font.family,
    minWidth: 0,
  },
  tabLabel: {
    maxWidth: 110,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  noDiff: {
    padding: `${space.xxl}px ${space.lg}px`,
    fontSize: font.size.md,
    color: color.text.muted,
    textAlign: "center",
  },
  diffList: { flex: 1, overflowY: "auto", paddingBottom: 100 },
  footer: {
    position: "sticky",
    bottom: 0,
    padding: `${space.md}px ${space.lg}px`,
    background: color.surface.default,
    borderTop: `1px solid ${color.border.subtle}`,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
};
