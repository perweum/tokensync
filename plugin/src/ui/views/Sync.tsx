/**
 * Sync view — main screen after a project is configured.
 * Manages the pull and push flows.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { Project } from "../App";
import { fetchTokenFiles, fetchBranches, createBranch, createTokenPR } from "../hooks/useGitHub";
import { useSendMessage, usePluginMessage } from "../hooks/usePlugin";
import { buildFigmaFlatMaps } from "../hooks/useFigmaValues";
import { parseRepository } from "../../shared/token-merger";
import type { ParsedRepository, Metadata } from "../../shared/token-merger";
import { buildCollectionDiff } from "../../shared/token-diff";
import { figmaToCollections, figmaToTokenFiles } from "../../shared/figma-to-tokens";
import type { CollectionDiff } from "../../shared/token-diff";
import { runTransformers } from "../../shared/transformer";
import type {
  PluginMessage,
  FigmaVariableCollection,
  FigmaVariable,
  TokenTree,
  TokenValue,
} from "../../shared/messages";
import type { TypographyStyle } from "../../shared/typography-styles";
import { PullDiff } from "./PullDiff";
import { PushDiff } from "./PushDiff";

type View = "main" | "pull-diff" | "push-diff";

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "success"; message: string; url?: string }
  | { kind: "error"; message: string };

interface LastSync {
  timestamp: number;
  direction: "pull" | "push";
}

interface Props {
  project: Project;
  onEditProject: () => void;
  onDeleteProject: () => void;
}

// Stored between the GET_COLLECTIONS call and the plugin response
type PendingAction = "pull" | "push";

export function Sync({ project, onEditProject, onDeleteProject: _onDeleteProject }: Props) {
  const [view, setView] = useState<View>("main");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [applying, setApplying] = useState(false);
  const [creating, setCreating] = useState(false);
  const [diffs, setDiffs] = useState<CollectionDiff[]>([]);
  const [diffError, setDiffError] = useState<string | undefined>(undefined);
  const [unrecognizedCollections, setUnrecognizedCollections] = useState<string[]>([]);
  const [lastSync, setLastSync] = useState<LastSync | null>(null);

  // Branch switching — persisted per project; defaults to the configured branch
  const branchKey = `tokensync:branch:${project.id}`;
  const [activeBranch, setActiveBranch] = useState(project.branch);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchCreateError, setBranchCreateError] = useState<string | undefined>(undefined);
  const [branchCreateLoading, setBranchCreateLoading] = useState(false);

  const lastSyncKey = `tokensync:lastSync:${project.id}`;

  const viewRef = useRef<View>("main");
  const pendingAction = useRef<PendingAction | null>(null);
  const applyAllRemaining = useRef(0);
  const pendingGitHub = useRef<ReturnType<typeof parseRepository> | null>(null);
  const pendingGitHubCollections = useRef<ReturnType<typeof parseRepository>["collections"] | null>(
    null,
  );
  const pendingFiles = useRef<Awaited<ReturnType<typeof fetchTokenFiles>> | null>(null);
  const pendingParsed = useRef<ParsedRepository | null>(null); // push: parsed GitHub repo (metadata + collections)
  const pendingFigmaCollections = useRef<
    ReturnType<typeof figmaToCollections>["collections"] | null
  >(null); // push: Figma resolved collections (known layers only — see unrecognizedCollections)
  const pendingFigmaRaw = useRef<{
    collections: FigmaVariableCollection[];
    variables: FigmaVariable[];
  } | null>(null); // push: raw Figma data for file generation

  const send = useSendMessage();

  // ---------------------------------------------------------------------------
  // Last sync state — load on mount, save after successful operations
  // ---------------------------------------------------------------------------

  const refreshBranches = useCallback(async () => {
    setBranchesLoading(true);
    try {
      const list = await fetchBranches(project.pat, project.repo);
      setBranches(list);
    } catch {
      // silently ignore — branch selector falls back to text display
    } finally {
      setBranchesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    send({ type: "LOAD_STORAGE", key: lastSyncKey });
    send({ type: "LOAD_STORAGE", key: branchKey });
    refreshBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  function handleBranchChange(branch: string) {
    setActiveBranch(branch);
    send({ type: "SAVE_STORAGE", key: branchKey, value: branch });
    setStatus({ kind: "idle" });
  }

  async function handleCreateBranch() {
    const name = newBranchName.trim();
    if (!name) return;
    setBranchCreateLoading(true);
    setBranchCreateError(undefined);
    try {
      await createBranch(project.pat, project.repo, name, activeBranch);
      setBranches((prev) => [...prev, name].sort());
      handleBranchChange(name);
      setCreatingBranch(false);
      setNewBranchName("");
    } catch (err) {
      setBranchCreateError(err instanceof Error ? err.message : "Failed to create branch");
    } finally {
      setBranchCreateLoading(false);
    }
  }

  function saveLastSync(direction: "pull" | "push") {
    const entry: LastSync = { timestamp: Date.now(), direction };
    setLastSync(entry);
    send({ type: "SAVE_STORAGE", key: lastSyncKey, value: JSON.stringify(entry) });
  }

  // ---------------------------------------------------------------------------
  // Plugin message handler
  // ---------------------------------------------------------------------------

  usePluginMessage(
    useCallback(
      (msg: PluginMessage) => {
        if (msg.type === "STORAGE_LOADED" && msg.key === lastSyncKey) {
          try {
            setLastSync(msg.value ? (JSON.parse(msg.value) as LastSync) : null);
          } catch {
            /* ignore */
          }
        }
        if (msg.type === "STORAGE_LOADED" && msg.key === branchKey) {
          if (msg.value) setActiveBranch(msg.value);
        }
        if (msg.type === "COLLECTIONS_LOADED") {
          if (pendingAction.current === "pull") {
            handlePullCollectionsLoaded(msg.collections, msg.variables);
          } else if (pendingAction.current === "push") {
            handlePushCollectionsLoaded(msg.collections, msg.variables);
          }
          pendingAction.current = null;
        }
        if (msg.type === "TOKENS_APPLIED") {
          const errSuffix = msg.errors.length
            ? ` (${msg.errors.length} error${msg.errors.length > 1 ? "s" : ""}: ${msg.errors[0]})`
            : "";
          const removedSuffix = msg.removed > 0 ? `, ${msg.removed} removed` : "";
          if (applyAllRemaining.current > 0) {
            applyAllRemaining.current--;
            if (applyAllRemaining.current === 0) {
              setApplying(false);
              viewRef.current = "main";
              setView("main");
              if (!msg.errors.length) saveLastSync("pull");
              setStatus({
                kind: msg.errors.length ? "error" : "success",
                message: `All collections applied to Figma${removedSuffix}${errSuffix}`,
              });
            }
          } else {
            setApplying(false);
            viewRef.current = "main";
            setView("main");
            if (!msg.errors.length) saveLastSync("pull");
            setStatus({
              kind: msg.errors.length ? "error" : "success",
              message: `Applied ${msg.count} variable(s)${removedSuffix} to Figma${errSuffix}`,
            });
          }
        }
        if (msg.type === "TEXT_STYLES_APPLIED") {
          const errSuffix = msg.errors.length
            ? ` (${msg.errors.length} error${msg.errors.length > 1 ? "s" : ""}: ${msg.errors[0]})`
            : "";
          if (applyAllRemaining.current > 0) {
            applyAllRemaining.current--;
            if (applyAllRemaining.current === 0) {
              setApplying(false);
              viewRef.current = "main";
              setView("main");
              if (!msg.errors.length) saveLastSync("pull");
              setStatus({
                kind: msg.errors.length ? "error" : "success",
                message: `All collections applied to Figma${errSuffix}`,
              });
            }
          }
        }
        if (msg.type === "ERROR") {
          setApplying(false);
          setCreating(false);
          if (viewRef.current === "pull-diff") {
            setDiffError(msg.message);
          } else {
            setStatus({ kind: "error", message: msg.message });
          }
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  );

  // ---------------------------------------------------------------------------
  // Pull flow
  // ---------------------------------------------------------------------------

  async function handlePull() {
    try {
      setStatus({ kind: "loading", message: "Fetching tokens from GitHub…" });

      const files = await fetchTokenFiles({
        pat: project.pat,
        repo: project.repo,
        branch: activeBranch,
        tokensPath: project.tokensPath,
      });

      setStatus({ kind: "loading", message: `Parsing ${files.length} token files…` });
      const parsed = parseRepository(files, project.tokensPath);
      pendingGitHub.current = parsed;

      setStatus({ kind: "loading", message: "Reading Figma variables…" });
      pendingAction.current = "pull";
      send({ type: "GET_COLLECTIONS" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handlePullCollectionsLoaded(
    figmaCollections: FigmaVariableCollection[],
    figmaVariables: FigmaVariable[],
  ) {
    const github = pendingGitHub.current;
    if (!github) return;

    setStatus({ kind: "loading", message: "Calculating diff…" });

    const figmaMaps = buildFigmaFlatMaps(figmaCollections, figmaVariables);

    const filteredGithubCollections = github.collections.filter(
      (c) => !isIgnoredCollection(c.collectionName, github.metadata),
    );

    const result = filteredGithubCollections.map((githubCol) => {
      const figmaMap = figmaMaps.find(
        (m) => m.collectionName === githubCol.collectionName && m.modeName === githubCol.modeName,
      );
      return buildCollectionDiff(
        githubCol.collectionName,
        githubCol.modeName,
        githubCol.tokens,
        figmaMap?.values ?? {},
        githubCol.rawTokens,
      );
    });

    const totalChanges = result.reduce((n, d) => n + d.counts.total, 0);

    if (totalChanges === 0) {
      setStatus({ kind: "success", message: "Figma is already up to date with GitHub" });
    } else {
      setStatus({ kind: "idle" });
      setDiffs(result.filter((d) => d.counts.total > 0));
      setView("pull-diff");
    }

    // Clean Apply must also skip ignored collections — store the filtered list
    pendingGitHubCollections.current = filteredGithubCollections;
    pendingGitHub.current = null;
  }

  /**
   * Gathers typography styles (from marked "$type": "typography" groups —
   * see shared/typography-styles.ts) across the given collections into one
   * APPLY_TEXT_STYLES payload, along with a flat resolved-value fallback map
   * for refs the plugin can't bind directly. Returns null when there's
   * nothing to apply, so callers can skip sending the message entirely.
   */
  function collectTypographyPayload(
    collections: Array<{ typographyStyles: TypographyStyle[]; tokens: Record<string, TokenValue> }>,
  ): { styles: TypographyStyle[]; resolvedFallback: Record<string, string> } | null {
    const styles = collections.flatMap((c) => c.typographyStyles);
    if (styles.length === 0) return null;

    const resolvedFallback: Record<string, string> = {};
    for (const col of collections) {
      for (const [path, token] of Object.entries(col.tokens)) {
        resolvedFallback[path] = token.$value;
      }
    }

    return { styles, resolvedFallback };
  }

  function sendApplyDiff(diff: CollectionDiff) {
    const changed = diff.entries.filter((e) => e.status === "added" || e.status === "changed");

    const tokensToApply = changed.reduce<Record<string, { $type: string; $value: string }>>(
      (acc, entry) => {
        const value = entry.githubRawValue ?? entry.githubValue;
        if (value) acc[entry.path] = { $type: entry.type, $value: value };
        return acc;
      },
      {},
    );

    // Resolved hex values — used as fallback when the ref target variable doesn't exist yet
    const resolvedValues: Record<string, string> = {};
    for (const entry of changed) {
      if (entry.githubValue && entry.githubRawValue && entry.githubRawValue !== entry.githubValue) {
        resolvedValues[entry.path] = entry.githubValue;
      }
    }

    const removedPaths = diff.entries.filter((e) => e.status === "removed").map((e) => e.path);

    send({
      type: "APPLY_TOKENS",
      tokens: tokensToApply,
      resolvedValues: Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined,
      collectionId: diff.collectionName,
      modeId: diff.modeName,
      removedPaths: removedPaths.length > 0 ? removedPaths : undefined,
    });
  }

  function handleApplyAll() {
    const pending = diffs.filter((d) => d.counts.total > 0);
    if (pending.length === 0) return;

    // Typography styles ride along only for the collections actually being applied.
    const relevantCollections = (pendingGitHubCollections.current ?? []).filter((c) =>
      pending.some((d) => d.collectionName === c.collectionName && d.modeName === c.modeName),
    );
    const typographyPayload = collectTypographyPayload(relevantCollections);

    applyAllRemaining.current = pending.length + (typographyPayload ? 1 : 0);
    setApplying(true);
    for (const diff of pending) {
      sendApplyDiff(diff);
    }
    // Sent last so the plugin's serial apply queue runs it after every
    // collection above — styles must bind after their Variables exist.
    if (typographyPayload) {
      send({
        type: "APPLY_TEXT_STYLES",
        styles: typographyPayload.styles,
        resolvedFallback: typographyPayload.resolvedFallback,
      });
    }
  }

  function handleCleanApplyAll() {
    const allCollections = pendingGitHubCollections.current;
    if (!allCollections) return;

    const typographyPayload = collectTypographyPayload(allCollections);
    applyAllRemaining.current = allCollections.length + (typographyPayload ? 1 : 0);
    setApplying(true);
    // Only send cleanApply=true for the first mode of each collection.
    // Multi-mode collections (e.g. Semantic with Light + Dark) share variables —
    // a clean apply on mode 2 would delete variables written by mode 1.
    const cleanedCollections = new Set<string>();
    for (const col of allCollections) {
      const isFirst = !cleanedCollections.has(col.collectionName);
      if (isFirst) cleanedCollections.add(col.collectionName);
      // Build resolved fallback map: path → hex value, for tokens whose raw value is a {ref}
      const resolvedValues: Record<string, string> = {};
      for (const [path, token] of Object.entries(col.rawTokens)) {
        const resolved = col.tokens[path];
        if (resolved && token.$value !== resolved.$value) {
          resolvedValues[path] = resolved.$value;
        }
      }
      send({
        type: "APPLY_TOKENS",
        tokens: col.rawTokens as TokenTree,
        resolvedValues: Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined,
        collectionId: col.collectionName,
        modeId: col.modeName,
        cleanApply: isFirst,
      });
    }
    // Sent last — same ordering guarantee as handleApplyAll.
    if (typographyPayload) {
      send({
        type: "APPLY_TEXT_STYLES",
        styles: typographyPayload.styles,
        resolvedFallback: typographyPayload.resolvedFallback,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Push flow
  // ---------------------------------------------------------------------------

  async function handlePush() {
    try {
      setStatus({ kind: "loading", message: "Fetching current tokens from GitHub…" });

      const files = await fetchTokenFiles({
        pat: project.pat,
        repo: project.repo,
        branch: activeBranch,
        tokensPath: project.tokensPath,
      });

      pendingFiles.current = files;
      setStatus({ kind: "loading", message: "Reading Figma variables…" });
      pendingAction.current = "push";
      send({ type: "GET_COLLECTIONS" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handlePushCollectionsLoaded(
    figmaCollections: FigmaVariableCollection[],
    figmaVariables: FigmaVariable[],
  ) {
    const githubFiles = pendingFiles.current;
    if (!githubFiles) return;

    setStatus({ kind: "loading", message: "Calculating diff…" });

    // GitHub side: parse existing token files
    const githubParsed = parseRepository(githubFiles, project.tokensPath);
    pendingParsed.current = githubParsed;

    // Figma side: convert to same ResolvedCollection shape
    const { collections: figmaCollectionData, unknownCollectionNames } = figmaToCollections(
      figmaCollections,
      figmaVariables,
      githubParsed.metadata.figma.collections,
    );
    setUnrecognizedCollections(unknownCollectionNames);
    pendingFigmaCollections.current = figmaCollectionData;
    // Keep raw data for writing complete token files to GitHub (not just diff entries)
    pendingFigmaRaw.current = { collections: figmaCollections, variables: figmaVariables };

    const filteredFigmaCollectionData = figmaCollectionData.filter(
      (c) => !isIgnoredCollection(c.collectionName, githubParsed.metadata),
    );

    // Diff: Figma (new) vs GitHub (current)
    // githubValue = current state in GitHub, figmaValue = new state from Figma
    const result: CollectionDiff[] = filteredFigmaCollectionData.map((figmaCol) => {
      const githubCol = githubParsed.collections.find(
        (c) => c.collectionName === figmaCol.collectionName && c.modeName === figmaCol.modeName,
      );
      // Swap: figmaTokens as "github" (what we're proposing), githubTokens as "figma" (current)
      return buildCollectionDiff(
        figmaCol.collectionName,
        figmaCol.modeName,
        figmaCol.tokens, // proposed (from Figma)
        Object.fromEntries(
          // current (from GitHub) — convert TokenValue to plain string
          Object.entries(githubCol?.tokens ?? {}).map(([k, v]) => [k, v.$value]),
        ),
      );
    });

    const totalChanges = result.reduce((n, d) => n + d.counts.total, 0);
    const unknownSuffix = unknownCollectionNames.length
      ? ` (skipped unrecognized collection${unknownCollectionNames.length > 1 ? "s" : ""}: ${unknownCollectionNames.join(", ")} — check metadata.json figma.collections)`
      : "";

    if (totalChanges === 0) {
      setStatus({
        kind: "success",
        message: `GitHub is already up to date with Figma${unknownSuffix}`,
      });
    } else {
      setStatus({ kind: "idle" });
      setDiffs(result.filter((d) => d.counts.total > 0));
      setView("push-diff");
    }

    pendingFiles.current = null;
  }

  async function handleCreatePR(prTitle: string, selectedKeys: Set<string>) {
    setCreating(true);
    try {
      const changedFiles = buildFilesFromDiffs(selectedKeys);

      const result = await createTokenPR(
        {
          pat: project.pat,
          repo: project.repo,
          branch: activeBranch,
          tokensPath: project.tokensPath,
        },
        changedFiles,
        prTitle,
      );

      setCreating(false);
      setView("main");
      saveLastSync("push");
      setStatus({
        kind: "success",
        message: `PR #${result.number} created`,
        url: result.url,
      });
    } catch (err) {
      setCreating(false);
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Build token files for the PR.
   * selectedKeys: set of "collectionName/modeName" pairs to include.
   * Writes ALL variables for selected collections (not just changed ones) so GitHub files stay complete.
   * Also runs platform transformers if configured in metadata.
   */
  function buildFilesFromDiffs(
    selectedKeys: Set<string>,
  ): Array<{ path: string; content: string }> {
    const raw = pendingFigmaRaw.current;
    const parsed = pendingParsed.current;
    if (!raw || !parsed) return [];

    // Build filtered collections: only selected modes
    const filteredCollections = raw.collections
      .map((col) => ({
        ...col,
        modes: col.modes.filter((mode) => selectedKeys.has(`${col.name}/${mode.name}`)),
      }))
      .filter((col) => col.modes.length > 0);

    const tokenFiles = figmaToTokenFiles(
      filteredCollections,
      raw.variables,
      project.tokensPath,
      parsed.metadata.figma.collections,
    ).map((f) => ({ path: f.repoPath, content: f.content }));

    // Platform transformers always use the full collection set (they represent the full design system)
    const figmaCollections = pendingFigmaCollections.current;
    if (figmaCollections) {
      const platformFiles = runTransformers(figmaCollections, parsed.metadata, project.tokensPath);
      return [...tokenFiles, ...platformFiles];
    }

    return tokenFiles;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (view === "pull-diff") {
    viewRef.current = "pull-diff";
    return (
      <PullDiff
        diffs={diffs}
        onApply={handleApplyAll}
        onCleanApply={handleCleanApplyAll}
        onBack={() => {
          viewRef.current = "main";
          setView("main");
          setStatus({ kind: "idle" });
          pendingGitHubCollections.current = null;
        }}
        applying={applying}
        error={diffError}
      />
    );
  }

  if (view === "push-diff") {
    return (
      <PushDiff
        diffs={diffs}
        unrecognizedCollections={unrecognizedCollections}
        onCreatePR={(title, keys) => handleCreatePR(title, keys)}
        onBack={() => {
          setView("main");
          setStatus({ kind: "idle" });
          pendingFigmaRaw.current = null;
          setUnrecognizedCollections([]);
        }}
        creating={creating}
      />
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.projectName}>{project.name}</div>
          <div style={styles.projectMeta}>
            {project.repo}
            {lastSync && <span style={styles.lastSync}> · {formatLastSync(lastSync)}</span>}
          </div>
        </div>
        <button style={styles.editBtn} onClick={onEditProject}>
          Settings
        </button>
      </div>

      <div style={styles.branchRow}>
        {creatingBranch ? (
          <>
            <input
              style={styles.branchInput}
              value={newBranchName}
              onChange={(e) => {
                setNewBranchName(e.target.value);
                setBranchCreateError(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateBranch();
                if (e.key === "Escape") {
                  setCreatingBranch(false);
                  setNewBranchName("");
                  setBranchCreateError(undefined);
                }
              }}
              placeholder={`from: ${activeBranch}`}
              autoFocus
              disabled={branchCreateLoading}
            />
            <button
              style={{
                ...styles.branchIconBtn,
                background: "#1a52d8",
                color: "#fff",
                borderColor: "#1a52d8",
              }}
              onClick={handleCreateBranch}
              disabled={branchCreateLoading || !newBranchName.trim()}
              title="Create branch"
            >
              {branchCreateLoading ? "…" : "Create"}
            </button>
            <button
              style={styles.branchIconBtn}
              onClick={() => {
                setCreatingBranch(false);
                setNewBranchName("");
                setBranchCreateError(undefined);
              }}
              disabled={branchCreateLoading}
              title="Cancel"
            >
              ✕
            </button>
            {branchCreateError && <span style={styles.branchError}>{branchCreateError}</span>}
          </>
        ) : (
          <>
            <span style={styles.branchLabel}>Branch</span>
            {branches.length > 1 ? (
              <select
                style={styles.branchSelect}
                value={activeBranch}
                onChange={(e) => handleBranchChange(e.target.value)}
                disabled={status.kind === "loading"}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <span style={styles.branchName}>{activeBranch}</span>
            )}
            <button
              style={styles.branchIconBtn}
              onClick={refreshBranches}
              disabled={branchesLoading || status.kind === "loading"}
              title="Refresh branch list"
            >
              {branchesLoading ? "…" : "⟳"}
            </button>
            <button
              style={styles.branchIconBtn}
              onClick={() => {
                setCreatingBranch(true);
                setBranchCreateError(undefined);
              }}
              disabled={status.kind === "loading"}
              title={`New branch from ${activeBranch}`}
            >
              +
            </button>
          </>
        )}
      </div>

      <div style={styles.actions}>
        <ActionCard
          title="Pull from GitHub"
          description="Fetch token changes from GitHub and review before applying to Figma Variables."
          buttonLabel="Pull"
          buttonStyle="secondary"
          onClick={handlePull}
          disabled={status.kind === "loading"}
        />
        <ActionCard
          title="Push to GitHub"
          description="Export Figma Variables as tokens and open a Pull Request on GitHub."
          buttonLabel="Push → PR"
          buttonStyle="primary"
          onClick={handlePush}
          disabled={status.kind === "loading"}
        />
      </div>

      {status.kind !== "idle" && (
        <div style={{ ...styles.status, ...statusStyle(status.kind) }}>
          {status.kind === "loading" && <span style={styles.spinner}>⟳</span>}
          <span>{status.message}</span>
          {status.kind === "success" && "url" in status && status.url && (
            <a href={status.url} target="_blank" rel="noreferrer" style={styles.prLink}>
              View PR →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when a collection is listed in metadata.ignoredCollections.
 * Entries are layer keys ("primitives", "global", "themes", "semantic"),
 * matched against the configured Figma collection names.
 */
function isIgnoredCollection(collectionName: string, metadata: Metadata): boolean {
  const names = metadata.figma.collections;
  const key = (Object.keys(names) as Array<keyof typeof names>).find(
    (k) => names[k] === collectionName,
  );
  return key !== undefined && (metadata.ignoredCollections ?? []).includes(key);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActionCard({
  title,
  description,
  buttonLabel,
  buttonStyle,
  onClick,
  disabled,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  buttonStyle: "primary" | "secondary";
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <div style={styles.card}>
      <div style={styles.cardText}>
        <div style={styles.cardTitle}>{title}</div>
        <div style={styles.cardDesc}>{description}</div>
      </div>
      <button
        style={{
          ...styles.actionBtn,
          ...(buttonStyle === "primary" ? styles.primaryBtn : styles.secondaryBtn),
        }}
        onClick={onClick}
        disabled={disabled}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function formatLastSync(sync: LastSync): string {
  const mins = Math.floor((Date.now() - sync.timestamp) / 60000);
  const label = sync.direction === "pull" ? "Pulled" : "Pushed";
  if (mins < 1) return `${label} just now`;
  if (mins < 60) return `${label} ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${label} ${hrs}h ago`;
  return `${label} ${Math.floor(hrs / 24)}d ago`;
}

function statusStyle(kind: Status["kind"]): React.CSSProperties {
  if (kind === "error") return { background: "#fff0f0", color: "#c00", borderColor: "#fcc" };
  if (kind === "success")
    return { background: "#f0faf3", color: "#127030", borderColor: "#b8e8c7" };
  return { background: "#f5f5f5", color: "#444", borderColor: "#e0e0e0" };
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: "20px", display: "flex", flexDirection: "column", gap: "16px" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "12px",
  },
  projectName: { fontWeight: 600, fontSize: "15px" },
  projectMeta: { fontSize: "11px", color: "#888", marginTop: "2px" },
  lastSync: { color: "#aaa" },
  editBtn: {
    fontSize: "12px",
    color: "#555",
    background: "none",
    border: "1px solid #ddd",
    borderRadius: "6px",
    padding: "4px 10px",
    cursor: "pointer",
    flexShrink: 0,
  },
  branchRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
    background: "#f8f8f8",
    borderRadius: "8px",
    border: "1px solid #eee",
  },
  branchLabel: { fontSize: "11px", color: "#888", fontWeight: 500, flexShrink: 0 },
  branchSelect: {
    flex: 1,
    fontSize: "12px",
    padding: "3px 6px",
    borderRadius: "5px",
    border: "1px solid #ddd",
    background: "#fff",
    color: "#222",
    cursor: "pointer",
  },
  branchName: { flex: 1, fontSize: "12px", color: "#333", fontFamily: "monospace" },
  branchInput: {
    flex: 1,
    fontSize: "12px",
    padding: "3px 8px",
    borderRadius: "5px",
    border: "1px solid #1a52d8",
    outline: "none",
    fontFamily: "monospace",
    minWidth: 0,
  },
  branchIconBtn: {
    flexShrink: 0,
    fontSize: "12px",
    padding: "3px 8px",
    borderRadius: "5px",
    border: "1px solid #ddd",
    background: "#fff",
    color: "#444",
    cursor: "pointer",
    lineHeight: 1.4,
  },
  branchError: { fontSize: "11px", color: "#c00", flexShrink: 0 },
  actions: { display: "flex", flexDirection: "column", gap: "12px" },
  card: {
    border: "1px solid #e8e8e8",
    borderRadius: "10px",
    padding: "16px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
  },
  cardText: { display: "flex", flexDirection: "column", gap: "4px" },
  cardTitle: { fontWeight: 500, fontSize: "13px" },
  cardDesc: { fontSize: "11px", color: "#666", lineHeight: 1.4 },
  actionBtn: {
    flexShrink: 0,
    border: "none",
    borderRadius: "6px",
    padding: "8px 14px",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
  },
  primaryBtn: { background: "#1a52d8", color: "#fff" },
  secondaryBtn: { background: "#f0f0f0", color: "#222" },
  status: {
    fontSize: "12px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid",
    lineHeight: 1.4,
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  spinner: { display: "inline-block", animation: "spin 1s linear infinite" },
  prLink: {
    marginLeft: "auto",
    fontSize: "12px",
    color: "#1a52d8",
    textDecoration: "none",
    fontWeight: 500,
  },
};
