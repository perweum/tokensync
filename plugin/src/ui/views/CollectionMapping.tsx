/**
 * Collection mapping view.
 *
 * Lets the user assign every real Figma collection to a Token Sync role
 * (primitives/global/themes/semantic/sizes) or Ignore, instead of hand-editing
 * `figma.collections` in metadata.json. Several physical Figma collections can
 * map to the same role — Figma allows exactly one mode-axis per collection, so
 * a real system (e.g. separate "main color"/"support color" collections that
 * together make up Themes) is forced to split one logical role across several
 * physical ones. Saving writes the confirmed mapping into metadata.json via a
 * PR — the repo stays the source of truth, nothing is saved to clientStorage.
 */

import { useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { fetchTokenFiles, createTokenPR, type PRResult } from "../hooks/useGitHub";
import { useSendMessage, usePluginMessage } from "../hooks/usePlugin";
import { parseRepository } from "../../shared/token-merger";
import type { CollectionNames } from "../../shared/token-merger";
import type { FigmaVariableCollection, PluginMessage } from "../../shared/messages";
import { Button } from "../components/Button";
import { StatusBanner } from "../components/StatusBanner";
import { ViewHeader } from "../components/ViewHeader";
import { color, font, radius, space } from "../theme";
import { describeGitHubError } from "../errors";
import type { DescribedError } from "../errors";

type Role = keyof CollectionNames | "ignore";

/** Both the dropdown and the grouped sections use this order — real roles in
 * pipeline order (primitives → global → themes → semantic, sizes as the
 * orthogonal size axis — see shared/token-merger.ts), Ignore last since it's
 * what's excluded from the pipeline entirely. The dropdown previously listed
 * Ignore first, which put "exclude this" ahead of every real role as the
 * default-looking choice. */
const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "primitives", label: "Primitives" },
  { value: "global", label: "Global" },
  { value: "themes", label: "Themes" },
  { value: "semantic", label: "Semantic" },
  { value: "sizes", label: "Sizes" },
  { value: "ignore", label: "Ignore" },
];

const ROLE_LABELS: Record<Role, string> = Object.fromEntries(
  ROLE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<Role, string>;

const GROUP_ORDER: Role[] = ROLE_OPTIONS.map((o) => o.value);

interface Props {
  project: Project;
  activeBranch: string;
  onBack: () => void;
  onSaved: (result: PRResult) => void;
}

export function CollectionMapping({ project, activeBranch, onBack, onSaved }: Props) {
  const [figmaCollections, setFigmaCollections] = useState<FigmaVariableCollection[] | null>(null);
  const [collectionNames, setCollectionNames] = useState<CollectionNames | null>(null);
  const [rawMetadata, setRawMetadata] = useState<Record<string, unknown> | null>(null);
  const [assignments, setAssignments] = useState<Record<string, Role>>({});
  const [sizeBreakpoints, setSizeBreakpoints] = useState<Record<string, number>>({});
  const [error, setError] = useState<DescribedError | null>(null);
  const [saving, setSaving] = useState(false);

  const requested = useRef(false);
  const send = useSendMessage();

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;

    fetchTokenFiles({
      pat: project.pat,
      repo: project.repo,
      branch: activeBranch,
      tokensPath: project.tokensPath,
    })
      .then((files) => {
        const { metadata } = parseRepository(files, project.tokensPath);
        setCollectionNames(metadata.figma.collections);
        setRawMetadata(metadata as unknown as Record<string, unknown>);
        setSizeBreakpoints(metadata.sizeBreakpoints ?? {});
        send({ type: "GET_COLLECTIONS" });
      })
      .catch((err) => setError(describeGitHubError(err, "fetch-tokens")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePluginMessage((msg: PluginMessage) => {
    if (msg.type === "COLLECTIONS_LOADED") {
      setFigmaCollections(msg.collections);
    }
    if (msg.type === "ERROR") {
      setError({ message: msg.message, detail: msg.context });
    }
  });

  // Once both the real Figma collections and the current config have loaded,
  // seed each collection's row from whichever role (if any) already lists it.
  useEffect(() => {
    if (!figmaCollections || !collectionNames) return;
    setAssignments((prev) => {
      const next = { ...prev };
      for (const col of figmaCollections) {
        if (next[col.name]) continue; // don't clobber a change the user already made
        next[col.name] = roleFor(col.name, collectionNames);
      }
      return next;
    });
  }, [figmaCollections, collectionNames]);

  function roleFor(name: string, names: CollectionNames): Role {
    for (const role of Object.keys(names) as Array<keyof CollectionNames>) {
      if (names[role].includes(name)) return role;
    }
    return "ignore";
  }

  // Mode order for the Size axis comes straight from Figma — whichever
  // collection(s) are assigned the "sizes" role, in the order Figma reports
  // their modes (first = base, written straight into :root; no reason to
  // make the user retype names Figma already has). Only the per-mode
  // breakpoint pixel value has no Figma-side source and needs a real input —
  // see docs/design/size-axis.md.
  const sizeModeNames: string[] = (() => {
    if (!figmaCollections) return [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const col of figmaCollections) {
      if ((assignments[col.name] ?? "ignore") !== "sizes") continue;
      for (const mode of col.modes) {
        const key = mode.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(mode.name);
        }
      }
    }
    return ordered;
  })();

  async function handleSave() {
    if (!rawMetadata) return;
    setSaving(true);
    setError(null);

    const newCollections: CollectionNames = {
      primitives: [],
      global: [],
      themes: [],
      semantic: [],
      sizes: [],
    };
    for (const [name, role] of Object.entries(assignments)) {
      if (role !== "ignore") newCollections[role].push(name);
    }

    // Only keep breakpoints for modes that are still actually part of the
    // Size axis (a mode could've been typed in, then its collection
    // reassigned away from "sizes") and that have a real numeric value.
    const cleanedBreakpoints = Object.fromEntries(
      Object.entries(sizeBreakpoints).filter(
        ([name, px]) => sizeModeNames.includes(name) && Number.isFinite(px),
      ),
    );

    const nextMetadata = {
      ...rawMetadata,
      sizes: sizeModeNames,
      sizeBreakpoints: cleanedBreakpoints,
      figma: { ...(rawMetadata.figma as Record<string, unknown>), collections: newCollections },
    };

    try {
      const result = await createTokenPR(
        {
          pat: project.pat,
          repo: project.repo,
          branch: activeBranch,
          tokensPath: project.tokensPath,
        },
        [
          {
            path: joinTokensPath(project.tokensPath, "metadata.json"),
            content: JSON.stringify(nextMetadata, null, 2),
          },
        ],
        "chore: update Figma collection mapping",
      );
      onSaved(result);
    } catch (err) {
      setError(describeGitHubError(err, "create-pr"));
      setSaving(false);
    }
  }

  const ready = figmaCollections !== null && collectionNames !== null;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <ViewHeader title="Map Figma collections" onBack={onBack} />
      </div>

      <p style={s.subtext}>
        Assign each Figma collection to a Token Sync role, or Ignore. Several collections can share
        a role — useful when Figma's one-mode-axis-per-collection limit has split one logical role
        (e.g. Themes) across more than one physical collection.
      </p>

      {error && (
        <div style={{ margin: `0 ${space.lg}px` }}>
          <StatusBanner tone="danger" detail={error.detail}>
            {error.message}
          </StatusBanner>
        </div>
      )}

      {!ready ? (
        <div style={s.loading}>Loading collections…</div>
      ) : (
        <>
          <div style={s.list}>
            {GROUP_ORDER.map((role) => {
              const colsInRole = figmaCollections
                .filter((col) => (assignments[col.name] ?? "ignore") === role)
                .sort((a, b) => a.name.localeCompare(b.name));
              if (colsInRole.length === 0) return null;

              const isIgnore = role === "ignore";
              const roleColor = color.role[role];

              return (
                <div key={role} style={s.group}>
                  <div style={s.groupHeader}>
                    <span
                      style={{ ...s.groupDot, background: roleColor, opacity: isIgnore ? 0.6 : 1 }}
                    />
                    <span style={isIgnore ? { color: color.text.muted } : undefined}>
                      {ROLE_LABELS[role]}
                    </span>
                    <span style={s.groupCount}>
                      {" "}
                      · {colsInRole.length} collection{colsInRole.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {colsInRole.map((col) => (
                    <div
                      key={col.id}
                      style={{
                        ...s.row,
                        borderLeft: `3px solid ${roleColor}`,
                        borderStyle: isIgnore ? "dashed" : "solid",
                        opacity: isIgnore ? 0.7 : 1,
                      }}
                    >
                      <div style={s.rowInfo}>
                        <div style={s.rowName}>{col.name}</div>
                        <div style={s.rowModes}>
                          {col.modes.length} mode{col.modes.length !== 1 ? "s" : ""}:{" "}
                          {col.modes.map((m) => m.name).join(", ")}
                        </div>
                      </div>
                      <select
                        style={s.select}
                        value={assignments[col.name] ?? "ignore"}
                        onChange={(e) =>
                          setAssignments((prev) => ({
                            ...prev,
                            [col.name]: e.target.value as Role,
                          }))
                        }
                      >
                        {ROLE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {role === "sizes" && sizeModeNames.length > 1 && (
                    <div style={s.breakpointBox}>
                      <div style={s.breakpointHint}>
                        Mode order comes from Figma — <strong>{sizeModeNames[0]}</strong> is the
                        base, written straight into <code>:root</code>. Give each other mode a
                        viewport width to switch at automatically; leave it blank to only allow
                        the explicit <code>[data-size]</code> override.
                      </div>
                      {sizeModeNames.slice(1).map((modeName) => (
                        <div key={modeName} style={s.breakpointRow}>
                          <span style={s.breakpointLabel}>{modeName} applies from</span>
                          <input
                            type="number"
                            min={0}
                            style={s.breakpointInput}
                            placeholder="e.g. 768"
                            value={sizeBreakpoints[modeName] ?? ""}
                            onChange={(e) => {
                              const px = e.target.value === "" ? undefined : Number(e.target.value);
                              setSizeBreakpoints((prev) => {
                                const next = { ...prev };
                                if (px === undefined) delete next[modeName];
                                else next[modeName] = px;
                                return next;
                              });
                            }}
                          />
                          <span style={s.breakpointLabel}>px wide</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={s.footer}>
            <Button variant="primary" fullWidth disabled={saving} onClick={handleSave}>
              {saving ? "Saving…" : "Save mapping (opens a PR)"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** metadata.json lives at the root of tokensPath — same convention buildLayers/
 * stripTokensPath in shared/token-merger.ts assume for reading it back. */
function joinTokensPath(tokensPath: string, fileName: string): string {
  const prefix = tokensPath.endsWith("/") ? tokensPath : `${tokensPath}/`;
  return `${prefix}${fileName}`;
}

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: {
    padding: `${space.md}px ${space.lg}px`,
    borderBottom: `1px solid ${color.border.subtle}`,
  },
  subtext: {
    margin: `${space.sm}px ${space.lg}px 0`,
    fontSize: font.size.md,
    color: color.text.secondary,
    lineHeight: 1.5,
  },
  loading: {
    padding: `${space.xxl}px ${space.lg}px`,
    fontSize: font.size.md,
    color: color.text.muted,
    textAlign: "center",
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: `${space.md}px ${space.lg}px`,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  group: { display: "flex", flexDirection: "column", gap: space.xs + 2 },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    fontWeight: 600,
    fontSize: font.size.sm,
    color: color.text.secondary,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  groupDot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  groupCount: { fontWeight: 400, textTransform: "none", color: color.text.muted },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    padding: `${space.sm}px ${space.sm + 2}px`,
    borderRadius: radius.sm,
    border: `1px solid ${color.border.subtle}`,
  },
  rowInfo: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  rowName: { fontWeight: 500, fontSize: font.size.md, color: color.text.primary },
  rowModes: {
    fontSize: font.size.xs,
    color: color.text.muted,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  select: {
    border: `1px solid ${color.border.default}`,
    borderRadius: radius.sm,
    padding: `${space.xs}px ${space.sm}px`,
    fontSize: font.size.sm,
    fontFamily: font.family,
    flexShrink: 0,
  },
  footer: {
    padding: `${space.md}px ${space.lg}px`,
    borderTop: `1px solid ${color.border.subtle}`,
  },
  breakpointBox: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs + 2,
    padding: `${space.sm}px ${space.sm + 2}px`,
    marginLeft: space.md,
    borderRadius: radius.sm,
    background: color.surface.muted,
  },
  breakpointHint: { fontSize: font.size.xs, color: color.text.muted, lineHeight: 1.5 },
  breakpointRow: { display: "flex", alignItems: "center", gap: space.xs },
  breakpointLabel: { fontSize: font.size.sm, color: color.text.secondary },
  breakpointInput: {
    width: 72,
    border: `1px solid ${color.border.default}`,
    borderRadius: radius.sm,
    padding: `${space.xs}px ${space.sm}px`,
    fontSize: font.size.sm,
    fontFamily: font.family,
  },
};
