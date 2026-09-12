/**
 * Push diff view.
 * Shows what will change on GitHub when the user creates a PR from Figma Variables.
 *
 * Collections stack as independently-collapsible sections, same pattern as
 * PullDiff — replaced an earlier tabs-based layout where only one collection
 * was visible at a time (forcing a click just to see what else changed),
 * the tab strip itself could overflow and clip a tab off-screen with no
 * scroll affordance, and a single control (checkbox to include + click to
 * preview) did two unrelated things at once.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import type { CollectionDiff } from "../../shared/token-diff";
import { diffLabel } from "../../shared/token-diff";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { CollapsibleSection } from "../components/CollapsibleSection";
import { DiffEntryList } from "../components/DiffEntryList";
import { DiffOverview } from "../components/DiffOverview";
import { StatusBanner } from "../components/StatusBanner";
import { Field, TextInput } from "../components/Field";
import { ViewHeader } from "../components/ViewHeader";
import { IconCheck, IconChevron } from "../icons";
import { color, font, radius, space } from "../theme";
import type { DescribedError } from "../errors";
import { toFigmaVarName } from "../../shared/token-format";
import type { StaleConfiguredMode } from "../../shared/sync-logic";
import { describeStaleModes } from "../staleModes";

/** Dot-paths are this project's own internal representation — a user
 * reading a warning has no reason to know that convention, and has to
 * mentally translate it back to find the actual variable in Figma's own
 * picker (which always shows "/"). Found live: exactly this friction was
 * flagged directly after a real conflict warning. */
function asFigmaNames(paths: string[]): string {
  return paths.map(toFigmaVarName).join(", ");
}

interface Props {
  diffs: CollectionDiff[];
  /** Figma collection names that matched none of the configured layers — never included in the PR. */
  unrecognizedCollections?: string[];
  /** Dot-paths whose Figma variable is a "ghost" alias — the picker shows the
   * right target name, but the underlying link is dead — so the field was
   * silently missing from the diff entirely rather than shown as broken.
   * Token Spark can't fix a dead link in Figma's own data, only report it. */
  brokenAliasPaths?: string[];
  /** Dot-paths where two real Figma variable names structurally collide
   * (e.g. "surface/brand" and "surface/brand/default" both existing) — the
   * file-writing step can't represent both at once and will refuse to write
   * either if the affected collection is included in this push. Computed
   * against the full Figma data, so this can show up even for a collection
   * the user hasn't selected yet. */
  conflictPaths?: string[];
  /** A theme/colorScheme/size mode renamed in Figma since "Map Collections"
   * was last saved — metadata.json's configured name no longer matches any
   * live Figma mode for that role. Figma itself always pushes under its
   * current real name; this warns that the *other* side (metadata.json)
   * hasn't caught up, before that silently drops the role on a future pull. */
  staleConfiguredModes?: StaleConfiguredMode[];
  /** Paths runTransformers would write that don't exist in the repo yet —
   * an enabled platform (Output Formats) whose file was never generated,
   * found even though there's zero token-level change to review. */
  outputOnlyFiles?: string[];
  onCreatePR: (title: string, selectedKeys: Set<string>) => void;
  onBack: () => void;
  creating: boolean;
  /** A failed PR creation — this view stays open on failure (no navigation
   * away), so it must render its own error, the same way PullDiff renders
   * diffError. Without this, a real failure looked identical to the button
   * doing nothing at all. */
  error?: DescribedError;
}

export function PushDiff({
  diffs,
  unrecognizedCollections = [],
  brokenAliasPaths = [],
  conflictPaths = [],
  staleConfiguredModes = [],
  outputOnlyFiles = [],
  onCreatePR,
  onBack,
  creating,
  error,
}: Props) {
  const isOutputOnly = diffs.length === 0 && outputOnlyFiles.length > 0;
  const [prTitle, setPrTitle] = useState(
    isOutputOnly ? "chore: generate output files" : "chore: sync design tokens from Figma",
  );

  // Selective sync — all collections selected by default
  const allKeys = diffs.map((d) => `${d.collectionName}/${d.modeName}`);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set(allKeys));

  // Expanded by default (same convention as PullDiff) — collapse individual
  // collections to manage a large diff instead of only ever seeing one.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set(allKeys));

  function toggleKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpandedKeys((prev) => {
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

  const warningCount =
    (unrecognizedCollections.length > 0 ? 1 : 0) +
    (brokenAliasPaths.length > 0 ? 1 : 0) +
    (conflictPaths.length > 0 ? 1 : 0) +
    (staleConfiguredModes.length > 0 ? 1 : 0);
  const hasWarnings = warningCount > 0;
  // Conflicts are the one case that actually blocks the push (see its own
  // copy below) — surface that by starting the accordion in red instead of
  // amber, even though the group itself still opens collapsed like any other.
  const warningsTone = conflictPaths.length > 0 ? "danger" : "warning";

  return (
    <div style={s.container}>
      <div style={s.header}>
        <ViewHeader title="Push to GitHub" onBack={onBack} />
      </div>

      {hasWarnings && (
        <div style={s.warnings}>
          <WarningsAccordion tone={warningsTone} count={warningCount}>
            {unrecognizedCollections.length > 0 && (
              <StatusBanner
                bare
                tone="warning"
                expandableDetail={
                  <>
                    Not included in this PR: <strong>{unrecognizedCollections.join(", ")}</strong>.
                    Assign {unrecognizedCollections.length === 1 ? "it" : "them"} to a role on the
                    main screen's "Map collections" if this is unexpected.
                  </>
                }
              >
                {unrecognizedCollections.length} Figma{" "}
                {unrecognizedCollections.length === 1 ? "collection isn't" : "collections aren't"}{" "}
                set up in Map Collections yet, so{" "}
                {unrecognizedCollections.length === 1 ? "it's" : "they're"} skipped.
              </StatusBanner>
            )}

            {brokenAliasPaths.length > 0 && (
              <StatusBanner
                bare
                tone="warning"
                expandableDetail={
                  <>
                    <strong>{asFigmaNames(brokenAliasPaths)}</strong>
                    {brokenAliasPaths.length === 1 ? " shows" : " show"} the right name in Figma's
                    variable picker, but the link underneath is broken (its target was likely
                    deleted or recreated). Open {brokenAliasPaths.length === 1 ? "it" : "each one"}{" "}
                    in Figma and re-link {brokenAliasPaths.length === 1 ? "it" : "them"} to a real
                    value, then push again.
                  </>
                }
              >
                {brokenAliasPaths.length} field{brokenAliasPaths.length !== 1 ? "s" : ""} skipped —
                Figma shows a broken variable link.
              </StatusBanner>
            )}

            {conflictPaths.length > 0 && (
              <StatusBanner
                bare
                tone="danger"
                expandableDetail={
                  <>
                    <strong>{asFigmaNames(conflictPaths)}</strong> — each one is a real variable
                    name in Figma, and other variables are also nested under that same name (e.g.{" "}
                    <code>{toFigmaVarName(conflictPaths[0])}/default</code>). One name can't be both
                    at once. Rename or delete one of them in Figma, then push again — this will
                    block the push until it's resolved.
                  </>
                }
              >
                {conflictPaths.length} variable name{conflictPaths.length !== 1 ? "s" : ""} can't
                sync — {conflictPaths.length === 1 ? "it conflicts" : "they conflict"} with another
                variable in Figma.
              </StatusBanner>
            )}

            {staleConfiguredModes.length > 0 && (
              <StatusBanner
                bare
                tone="warning"
                expandableDetail={
                  <>
                    {describeStaleModes(staleConfiguredModes)} — configured here, but no mode in
                    Figma is currently named this. If you renamed the mode in Figma, this push will
                    still work under its new real name, but the "Map Collections" screen won't know
                    about that rename until you open it and save again — do that after this push, or
                    the next pull may not find this{" "}
                    {staleConfiguredModes.length === 1 ? "one" : "one of these"} at all.
                  </>
                }
              >
                {staleConfiguredModes.length} configured mode name
                {staleConfiguredModes.length !== 1 ? "s don't" : " doesn't"} match anything in Figma
                right now.
              </StatusBanner>
            )}
          </WarningsAccordion>
        </div>
      )}

      {isOutputOnly ? (
        <>
          <div style={s.outputOnlyIntro}>
            <div style={s.emptyText}>No token changes</div>
            <div style={s.emptySubtext}>
              {outputOnlyFiles.length} output file{outputOnlyFiles.length !== 1 ? "s" : ""} from
              Output Formats {outputOnlyFiles.length !== 1 ? "haven't" : "hasn't"} been generated
              yet:
            </div>
          </div>
          <ul style={s.outputOnlyList}>
            {outputOnlyFiles.map((path) => (
              <li key={path} style={s.outputOnlyItem}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <div style={s.footer}>
            {error && (
              <StatusBanner tone="danger" detail={error.detail}>
                {error.message}
              </StatusBanner>
            )}
            <Field label="Pull request title">
              <TextInput value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              fullWidth
              disabled={creating}
              onClick={() =>
                onCreatePR(prTitle.trim() || "chore: generate output files", new Set())
              }
            >
              {creating
                ? "Creating PR…"
                : `Create PR (${outputOnlyFiles.length} file${outputOnlyFiles.length !== 1 ? "s" : ""})`}
            </Button>
          </div>
        </>
      ) : !hasChanges ? (
        <div style={s.empty}>
          <IconCheck size={26} style={{ color: color.status.success.text }} />
          <div style={s.emptyText}>GitHub is already up to date</div>
          <div style={s.emptySubtext}>No changes detected between Figma and the repository</div>
        </div>
      ) : (
        <>
          <DiffOverview diffs={diffs} unitLabel="file" />

          <div style={s.body}>
            {diffs.map((diff) => {
              const key = `${diff.collectionName}/${diff.modeName}`;
              const label = diffLabel(diff);
              const selected = selectedKeys.has(key);
              return (
                <div key={key} style={{ ...s.section, opacity: selected ? 1 : 0.6 }}>
                  <CollapsibleSection
                    level="section"
                    label={label}
                    expanded={expandedKeys.has(key)}
                    onToggle={() => toggleExpanded(key)}
                    left={
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleKey(key)}
                        aria-label={`Include ${label} in the pull request`}
                        title={`Include ${label} in the pull request`}
                      />
                    }
                    right={
                      diff.counts.total > 0 && (
                        <Badge tone="changed" muted={!selected}>
                          {diff.counts.total}
                        </Badge>
                      )
                    }
                  >
                    {diff.counts.total === 0 ? (
                      <div style={s.noDiff}>No changes in this collection</div>
                    ) : (
                      <DiffEntryList entries={diff.entries} />
                    )}
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

/**
 * Groups the push's warning/danger banners behind one collapsed-by-default
 * header. These persist for as long as the underlying condition does (an
 * unmapped Figma collection, a broken alias link, ...), unlike a one-off
 * error banner from a failed action — found live: seeing the same detailed
 * warning box on every visit to this screen made it something to tune out
 * rather than read, and it also pushed the actual diff list further down
 * the screen every time. An accordion keeps it out of the way until opened,
 * while the collapsed header's color still signals there's something here.
 */
function WarningsAccordion({
  tone,
  count,
  children,
}: {
  tone: "warning" | "danger";
  count: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = color.status[tone];
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: radius.md,
        background: t.bg,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          padding: `${space.sm + 2}px ${space.md + 2}px`,
          border: "none",
          background: "none",
          color: t.text,
          font: "inherit",
          fontWeight: 600,
          fontSize: font.size.md,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <IconChevron expanded={expanded} size={10} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          {count} issue{count !== 1 ? "s" : ""} to review before pushing
        </span>
      </button>
      {expanded && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.md,
            padding: `0 ${space.md + 2}px ${space.sm + 2}px`,
          }}
        >
          {children}
        </div>
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
  warnings: {
    margin: `${space.sm}px ${space.lg}px 0`,
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
  emptySubtext: { fontSize: font.size.md, color: color.text.secondary },
  outputOnlyIntro: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: `${space.lg}px ${space.lg}px ${space.sm}px`,
  },
  outputOnlyList: {
    margin: 0,
    padding: `0 ${space.lg}px ${space.lg}px ${space.lg + space.md}px`,
    flex: 1,
    overflowY: "auto",
  },
  outputOnlyItem: {
    fontSize: font.size.sm,
    fontFamily: font.mono,
    color: color.text.secondary,
    padding: `${space.xs}px 0`,
  },
  body: { flex: 1, overflowY: "auto" },
  section: { borderBottom: `1px solid ${color.border.subtle}` },
  noDiff: {
    padding: `${space.xxl}px ${space.lg}px`,
    fontSize: font.size.md,
    color: color.text.muted,
    textAlign: "center",
  },
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
