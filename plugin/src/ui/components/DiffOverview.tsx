import type { CollectionDiff } from "../../shared/token-diff";
import { Badge } from "./Badge";
import { color, font, space } from "../theme";

/**
 * At-a-glance stat bar shared by Pull and Push — total token changes, how
 * many collections/files are involved, and a changed/added/removed
 * breakdown. Previously only Push had this; Pull required scrolling past
 * every section to get the same picture.
 */
export function DiffOverview({
  diffs,
  unitLabel,
}: {
  diffs: CollectionDiff[];
  /** Singular noun for the second stat — "file" for Push, "collection" for Pull. */
  unitLabel: string;
}) {
  const totalChanges = diffs.reduce((n, d) => n + d.counts.total, 0);
  const totals = diffs.reduce(
    (acc, d) => ({
      changed: acc.changed + d.counts.changed,
      added: acc.added + d.counts.added,
      removed: acc.removed + d.counts.removed,
    }),
    { changed: 0, added: 0, removed: 0 },
  );

  return (
    <div
      style={{
        display: "flex",
        gap: space.lg,
        padding: `${space.md}px ${space.lg}px`,
        borderBottom: `1px solid ${color.border.subtle}`,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <Stat value={totalChanges} label="token changes" />
      <Stat value={diffs.length} label={`${unitLabel}${diffs.length !== 1 ? "s" : ""}`} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {totals.changed > 0 && <Badge tone="changed">{totals.changed} changed</Badge>}
        {totals.added > 0 && <Badge tone="added">{totals.added} added</Badge>}
        {totals.removed > 0 && <Badge tone="removed">{totals.removed} removed</Badge>}
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 40 }}>
      <span style={{ fontWeight: 700, fontSize: 20, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: font.size.xs, color: color.text.muted, marginTop: 2 }}>{label}</span>
    </div>
  );
}
