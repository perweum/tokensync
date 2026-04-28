/**
 * Push diff view.
 * Shows what will change on GitHub when the user creates a PR from Figma Variables.
 */

import { useState } from "react";
import type { CollectionDiff, DiffEntry, DiffStatus } from "../../shared/token-diff";
import { groupByCategory } from "../../shared/token-diff";

interface Props {
  diffs: CollectionDiff[];
  onCreatePR: (title: string, selectedKeys: Set<string>) => void;
  onBack: () => void;
  creating: boolean;
}

export function PushDiff({ diffs, onCreatePR, onBack, creating }: Props) {
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
      {/* Header */}
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>
          ← Back
        </button>
        <span style={s.title}>Push to GitHub</span>
      </div>

      {!hasChanges ? (
        <div style={s.empty}>
          <div style={s.emptyIcon}>✓</div>
          <div style={s.emptyText}>GitHub is already up to date</div>
          <div style={s.emptySubtext}>No changes detected between Figma and the repository</div>
        </div>
      ) : (
        <>
          {/* Overview bar */}
          <div style={s.overview}>
            <div style={s.overviewStat}>
              <span style={s.overviewNum}>{totalChanges}</span>
              <span style={s.overviewLabel}>token changes</span>
            </div>
            <div style={s.overviewStat}>
              <span style={s.overviewNum}>{diffs.length}</span>
              <span style={s.overviewLabel}>file{diffs.length !== 1 ? "s" : ""}</span>
            </div>
            <SummaryChips diffs={diffs} />
          </div>

          {/* Collection tabs */}
          <div style={s.tabs}>
            {diffs.map((diff, i) => {
              const key = `${diff.collectionName}/${diff.modeName}`;
              const selected = selectedKeys.has(key);
              return (
                <button
                  key={key}
                  style={{
                    ...s.tab,
                    ...(activeTab === i ? s.tabActive : {}),
                    ...(!selected ? s.tabDeselected : {}),
                  }}
                  onClick={() => setActiveTab(i)}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    style={s.tabCheck}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleKey(key)}
                  />
                  {diff.modeName}
                  {diff.counts.total > 0 && (
                    <span style={{ ...s.tabBadge, ...(!selected ? s.tabBadgeOff : {}) }}>
                      {diff.counts.total}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Diff list for active tab */}
          {(() => {
            const diff = diffs[activeTab];
            if (!diff || diff.counts.total === 0)
              return <div style={s.noDiff}>No changes in this collection</div>;
            return <DiffList entries={diff.entries} />;
          })()}

          {/* PR form */}
          <div style={s.footer}>
            <input
              style={s.prInput}
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              placeholder="Pull request title"
            />
            <button
              style={{ ...s.prBtn, ...(creating || selectedChanges === 0 ? s.prBtnDisabled : {}) }}
              onClick={() =>
                onCreatePR(prTitle.trim() || "chore: sync design tokens from Figma", selectedKeys)
              }
              disabled={creating || selectedChanges === 0}
            >
              {creating
                ? "Creating PR…"
                : selectedChanges === 0
                  ? "Select collections to include"
                  : `Create PR (${selectedChanges} change${selectedChanges !== 1 ? "s" : ""})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary chips across all collections
// ---------------------------------------------------------------------------

function SummaryChips({ diffs }: { diffs: CollectionDiff[] }) {
  const totals = diffs.reduce(
    (acc, d) => ({
      changed: acc.changed + d.counts.changed,
      added: acc.added + d.counts.added,
      removed: acc.removed + d.counts.removed,
    }),
    { changed: 0, added: 0, removed: 0 },
  );
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
      {totals.changed > 0 && <Chip color="#1a52d8" label={`${totals.changed} changed`} />}
      {totals.added > 0 && <Chip color="#12702f" label={`${totals.added} added`} />}
      {totals.removed > 0 && <Chip color="#c00000" label={`${totals.removed} removed`} />}
    </div>
  );
}

function Chip({ color, label }: { color: string; label: string }) {
  return <span style={{ ...s.chip, background: color + "18", color }}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Diff list
// ---------------------------------------------------------------------------

function DiffList({ entries }: { entries: DiffEntry[] }) {
  const grouped = groupByCategory(entries);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(cat: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  return (
    <div style={s.diffList}>
      {[...grouped.entries()].map(([category, catEntries]) => (
        <div key={category}>
          <button style={s.categoryRow} onClick={() => toggle(category)}>
            <span style={s.chevron}>{collapsed.has(category) ? "▶" : "▼"}</span>
            <span style={s.categoryName}>{category}</span>
            <span style={s.categoryCount}>{catEntries.length}</span>
          </button>
          {!collapsed.has(category) &&
            catEntries.map((entry) => <DiffRow key={entry.path} entry={entry} />)}
        </div>
      ))}
    </div>
  );
}

function DiffRow({ entry }: { entry: DiffEntry }) {
  const isColor = entry.type === "color";
  const label = entry.path.split(".").slice(1).join(".");

  return (
    <div style={{ ...s.row, ...rowBg(entry.status) }}>
      <span style={{ ...s.dot, color: dotColor(entry.status) }}>{dotIcon(entry.status)}</span>
      <div style={s.meta}>
        <span style={s.path}>{label}</span>
        {entry.description && <span style={s.desc}>{entry.description}</span>}
      </div>
      <div style={s.vals}>
        {entry.figmaValue !== null && (
          <Val value={entry.figmaValue} isColor={isColor} faded={entry.status === "changed"} />
        )}
        {entry.status === "changed" && <span style={s.arrow}>→</span>}
        {entry.githubValue !== null && entry.status !== "removed" && (
          <Val value={entry.githubValue} isColor={isColor} faded={false} />
        )}
      </div>
    </div>
  );
}

function Val({ value, isColor, faded }: { value: string; isColor: boolean; faded: boolean }) {
  const hex = /^#[0-9a-f]{3,8}$/i.test(value);
  const light = hex && isLightColor(value);
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "3px", opacity: faded ? 0.4 : 1 }}>
      {isColor && hex && (
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            flexShrink: 0,
            display: "inline-block",
            background: value,
            border: light ? "1px solid #ddd" : "1px solid transparent",
          }}
        />
      )}
      <span style={{ fontSize: 11, color: "#555", fontFamily: "monospace" }}>
        {value.length > 20 ? value.slice(0, 18) + "…" : value}
      </span>
    </span>
  );
}

function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 200;
}

function rowBg(s: DiffStatus): React.CSSProperties {
  if (s === "added") return { background: "#f0faf3" };
  if (s === "removed") return { background: "#fff5f5" };
  return {};
}
function dotColor(s: DiffStatus) {
  if (s === "added") return "#12702f";
  if (s === "removed") return "#c00000";
  return "#1a52d8";
}
function dotIcon(s: DiffStatus) {
  if (s === "added") return "+";
  if (s === "removed") return "−";
  return "~";
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "14px 16px",
    borderBottom: "1px solid #eee",
  },
  backBtn: {
    background: "none",
    border: "none",
    fontSize: "12px",
    color: "#555",
    cursor: "pointer",
    padding: "2px 0",
  },
  title: { fontWeight: 600, fontSize: "14px" },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: "6px",
    color: "#666",
  },
  emptyIcon: { fontSize: "28px", color: "#12702f" },
  emptyText: { fontWeight: 500, fontSize: "14px", color: "#1a1a1a" },
  emptySubtext: { fontSize: "12px" },
  overview: {
    display: "flex",
    gap: "16px",
    padding: "12px 16px",
    borderBottom: "1px solid #eee",
    alignItems: "center",
    flexWrap: "wrap",
  },
  overviewStat: { display: "flex", flexDirection: "column", alignItems: "center", minWidth: 40 },
  overviewNum: { fontWeight: 700, fontSize: "20px", lineHeight: 1 },
  overviewLabel: { fontSize: "10px", color: "#888", marginTop: 2 },
  chip: { fontSize: "11px", fontWeight: 500, padding: "3px 8px", borderRadius: "12px" },
  tabs: {
    display: "flex",
    gap: "2px",
    padding: "8px 16px 0",
    borderBottom: "1px solid #eee",
    overflowX: "auto",
  },
  tab: {
    background: "none",
    border: "none",
    fontSize: "12px",
    padding: "6px 10px",
    cursor: "pointer",
    color: "#666",
    borderRadius: "6px 6px 0 0",
    display: "flex",
    alignItems: "center",
    gap: "5px",
  },
  tabActive: { background: "#f0f0f0", color: "#1a1a1a", fontWeight: 500 },
  tabDeselected: { opacity: 0.45 },
  tabCheck: { margin: 0, cursor: "pointer", flexShrink: 0 },
  tabBadge: {
    background: "#1a52d8",
    color: "#fff",
    borderRadius: "8px",
    padding: "1px 5px",
    fontSize: "10px",
  },
  tabBadgeOff: { background: "#aaa" },
  noDiff: { padding: "24px 16px", fontSize: "12px", color: "#888", textAlign: "center" },
  diffList: { flex: 1, overflowY: "auto", paddingBottom: 100 },
  categoryRow: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "7px 16px",
    background: "#f8f8f8",
    border: "none",
    borderBottom: "1px solid #eee",
    cursor: "pointer",
    textAlign: "left",
  },
  chevron: { fontSize: "9px", color: "#888" },
  categoryName: {
    flex: 1,
    fontSize: "12px",
    fontWeight: 600,
    color: "#444",
    textTransform: "capitalize",
  },
  categoryCount: { fontSize: "11px", color: "#888" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 16px",
    borderBottom: "1px solid #f0f0f0",
  },
  dot: { fontWeight: 700, fontSize: "13px", width: 14, flexShrink: 0, fontFamily: "monospace" },
  meta: { flex: 1, display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
  path: {
    fontSize: "11px",
    color: "#333",
    fontFamily: "monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  desc: {
    fontSize: "10px",
    color: "#999",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  vals: { display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 },
  arrow: { fontSize: "11px", color: "#aaa" },
  footer: {
    position: "sticky",
    bottom: 0,
    padding: "12px 16px",
    background: "#fff",
    borderTop: "1px solid #eee",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  prInput: {
    border: "1px solid #ddd",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "12px",
    outline: "none",
  },
  prBtn: {
    background: "#1a52d8",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    padding: "11px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
  },
  prBtnDisabled: { background: "#aaa", cursor: "not-allowed" },
};
