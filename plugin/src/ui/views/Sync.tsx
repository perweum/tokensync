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
import type { ParsedRepository, Metadata, CollectionNames, CollectionSources } from "../../shared/token-merger";
import { figmaToCollections } from "../../shared/figma-to-tokens";
import type { CollectionDiff } from "../../shared/token-diff";
import {
  computePullDiff,
  computePushDiff,
  buildFilesFromDiffs,
  buildApplyPayloads,
  buildCleanApplyPayloads,
  mergeTypographyIntoFigmaMaps,
} from "../../shared/sync-logic";
import type { PluginMessage, FigmaVariableCollection, FigmaVariable, TokenValue } from "../../shared/messages";
import type { TypographyStyle } from "../../shared/typography-styles";
import { PullDiff } from "./PullDiff";
import { PushDiff } from "./PushDiff";
import { CollectionMapping } from "./CollectionMapping";
import { OutputFormats } from "./OutputFormats";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { StatusBanner } from "../components/StatusBanner";
import { IconArrowRight, IconClose, IconPlus, IconRefresh } from "../icons";
import { color, font, radius, space } from "../theme";
import { describeGitHubError, describePluginError } from "../errors";
import type { DescribedError } from "../errors";

type View = "main" | "pull-diff" | "push-diff" | "collection-mapping" | "output-formats";

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "success"; message: string; url?: string }
  | ({ kind: "error" } & DescribedError);

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
  const [diffError, setDiffError] = useState<DescribedError | undefined>(undefined);
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

  // Whether to sync typography ("$type": "typography" marked groups) as Figma
  // Text Styles at all — persisted per project, defaults OFF. Off just skips
  // sending APPLY_TEXT_STYLES; it never affects Variables sync. Defaults off
  // (not on) because the full apply flow — create-or-find by name, the
  // combined fontName merge, lineHeight/letterSpacing unit handling — has
  // not been verified end-to-end against a real Figma file; only one
  // isolated binding call has been confirmed live. Flip to on once that's
  // done, or once a team has verified it against their own file.
  const syncTypeStylesKey = `tokensync:syncTypeStyles:${project.id}`;
  const [syncTypeStyles, setSyncTypeStyles] = useState(false);

  const viewRef = useRef<View>("main");
  const pendingAction = useRef<PendingAction | null>(null);
  const applyAllRemaining = useRef(0);
  // Accumulates errors across every collection in a batch apply — including
  // ones whose task threw entirely (reported as a plain ERROR message, not a
  // TOKENS_APPLIED/TEXT_STYLES_APPLIED with its own errors array) — so the
  // final summary reflects the whole batch, not just whichever message
  // happened to be the last one processed.
  const applyAllBatchErrors = useRef<string[]>([]);
  const pendingGitHub = useRef<ReturnType<typeof parseRepository> | null>(null);
  const pendingGitHubCollections = useRef<ReturnType<typeof parseRepository>["collections"] | null>(
    null,
  );
  // Kept separately from pendingGitHub (nulled once its collections are
  // extracted below) — apply needs figma.collections/collectionSources to
  // route each token to its real Figma collection, which happens well after
  // that point, when the user actually clicks Apply on the reviewed diff.
  const pendingGitHubMetadata = useRef<Metadata | null>(null);
  const pendingFiles = useRef<Awaited<ReturnType<typeof fetchTokenFiles>> | null>(null);
  const pendingParsed = useRef<ParsedRepository | null>(null); // push: parsed GitHub repo (metadata + collections)
  const pendingFigmaCollections = useRef<
    ReturnType<typeof figmaToCollections>["collections"] | null
  >(null); // push: Figma resolved collections (known layers only — see unrecognizedCollections)
  const pendingFigmaRaw = useRef<{
    collections: FigmaVariableCollection[];
    variables: FigmaVariable[];
    typographyStyles: TypographyStyle[];
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
    send({ type: "LOAD_STORAGE", key: syncTypeStylesKey });
    refreshBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  function handleBranchChange(branch: string) {
    setActiveBranch(branch);
    send({ type: "SAVE_STORAGE", key: branchKey, value: branch });
    setStatus({ kind: "idle" });
  }

  function handleSyncTypeStylesChange(value: boolean) {
    setSyncTypeStyles(value);
    send({ type: "SAVE_STORAGE", key: syncTypeStylesKey, value: String(value) });
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
      setBranchCreateError(describeGitHubError(err, "create-branch").message);
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
        if (msg.type === "STORAGE_LOADED" && msg.key === syncTypeStylesKey) {
          if (msg.value !== null) setSyncTypeStyles(msg.value === "true");
        }
        if (msg.type === "COLLECTIONS_LOADED") {
          if (pendingAction.current === "pull") {
            handlePullCollectionsLoaded(msg.collections, msg.variables, msg.typographyStyles);
          } else if (pendingAction.current === "push") {
            handlePushCollectionsLoaded(msg.collections, msg.variables, msg.typographyStyles);
          }
          pendingAction.current = null;
        }
        if (msg.type === "TOKENS_APPLIED") {
          const removedSuffix = msg.removed > 0 ? `, ${msg.removed} removed` : "";
          if (applyAllRemaining.current > 0) {
            applyAllBatchErrors.current.push(...msg.errors);
            applyAllRemaining.current--;
            if (applyAllRemaining.current === 0) {
              finishApplyBatch(`All collections applied to Figma${removedSuffix}`);
            }
          } else {
            const errSuffix = msg.errors.length
              ? ` (${msg.errors.length} error${msg.errors.length > 1 ? "s" : ""}: ${msg.errors[0]})`
              : "";
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
          if (applyAllRemaining.current > 0) {
            applyAllBatchErrors.current.push(...msg.errors);
            applyAllRemaining.current--;
            if (applyAllRemaining.current === 0) {
              finishApplyBatch("All collections applied to Figma");
            }
          }
        }
        if (msg.type === "ERROR") {
          // Mid-batch: this task failed before it could send its own
          // TOKENS_APPLIED/TEXT_STYLES_APPLIED at all (e.g. collection.addMode
          // rejected outside the per-token try/catch) — still counts against
          // the batch the same way a reported error would, or the counter
          // never reaches zero and the collections that DID succeed never get
          // a final summary shown.
          if (applyAllRemaining.current > 0) {
            applyAllBatchErrors.current.push(msg.message);
            applyAllRemaining.current--;
            if (applyAllRemaining.current === 0) {
              finishApplyBatch("All collections applied to Figma");
            }
            return;
          }
          setApplying(false);
          setCreating(false);
          const described = describePluginError(msg.message, msg.context);
          if (viewRef.current === "pull-diff") {
            setDiffError(described);
          } else {
            setStatus({ kind: "error", ...described });
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
      setStatus({ kind: "error", ...describeGitHubError(err, "fetch-tokens") });
    }
  }

  function handlePullCollectionsLoaded(
    figmaCollections: FigmaVariableCollection[],
    figmaVariables: FigmaVariable[],
    figmaTypographyStyles: TypographyStyle[] = [],
  ) {
    const github = pendingGitHub.current;
    if (!github) return;

    setStatus({ kind: "loading", message: "Calculating diff…" });

    const figmaMaps = mergeTypographyIntoFigmaMaps(
      buildFigmaFlatMaps(figmaCollections, figmaVariables),
      figmaTypographyStyles,
      github.metadata,
    );
    const { diffs: result, filteredGithubCollections } = computePullDiff(
      github.collections,
      github.metadata,
      figmaMaps,
    );

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
    pendingGitHubMetadata.current = github.metadata;
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

  /**
   * Shared finalize step once every task in a batch apply has reported back
   * — whether via its own TOKENS_APPLIED/TEXT_STYLES_APPLIED, or because it
   * threw entirely and came back as a plain ERROR instead (see the message
   * handler above). Both paths funnel through the same applyAllRemaining/
   * applyAllBatchErrors bookkeeping, so there's exactly one place that
   * decides the batch is done and what its final summary says.
   */
  function finishApplyBatch(baseMessage: string) {
    const allErrors = applyAllBatchErrors.current;
    const errSuffix = allErrors.length
      ? ` (${allErrors.length} error${allErrors.length > 1 ? "s" : ""}: ${allErrors[0]})`
      : "";
    setApplying(false);
    viewRef.current = "main";
    setView("main");
    if (!allErrors.length) saveLastSync("pull");
    setStatus({
      kind: allErrors.length ? "error" : "success",
      message: `${baseMessage}${errSuffix}`,
    });
  }

  /**
   * handleApplyAll/handleCleanApplyAll are only reachable once the PullDiff
   * view is showing, which requires pendingGitHubMetadata.current to have
   * just been set (handlePullCollectionsLoaded sets it in the same
   * statement block as pendingGitHubCollections.current, and never nulls it
   * independently) — so a missing metadata here means that invariant broke,
   * not a normal, expected state. Throwing surfaces that loudly instead of
   * clicking Apply silently doing nothing.
   */
  function requirePendingMetadata(): { names: CollectionNames; sources: CollectionSources } {
    const metadata = pendingGitHubMetadata.current;
    if (!metadata) {
      throw new Error("Apply attempted with no pending pull metadata");
    }
    return { names: metadata.figma.collections, sources: metadata.figma.collectionSources ?? {} };
  }

  function handleApplyAll(selectedKeys: Set<string>) {
    const pending = diffs.filter(
      (d) => d.counts.total > 0 && selectedKeys.has(`${d.collectionName}/${d.modeName}`),
    );
    if (pending.length === 0) return;

    const { names, sources } = requirePendingMetadata();

    // A role backed by more than one physical Figma collection can now fan
    // out into more than one APPLY_TOKENS payload — each routed to the real
    // collection its tokens belong to (see buildApplyPayloads). With no
    // provenance recorded for a role, every payload still targets
    // diff.collectionName, identical to the single-message behavior before
    // this existed.
    const payloads = pending.flatMap((diff) => buildApplyPayloads(diff, names, sources));

    // Typography styles ride along only for the collections actually being applied.
    const relevantCollections = (pendingGitHubCollections.current ?? []).filter((c) =>
      pending.some((d) => d.collectionName === c.collectionName && d.modeName === c.modeName),
    );
    const typographyPayload = syncTypeStyles ? collectTypographyPayload(relevantCollections) : null;

    applyAllRemaining.current = payloads.length + (typographyPayload ? 1 : 0);
    applyAllBatchErrors.current = [];
    setApplying(true);
    for (const payload of payloads) {
      send({
        type: "APPLY_TOKENS",
        tokens: payload.tokens,
        resolvedValues: payload.resolvedValues,
        collectionId: payload.collectionId,
        modeId: payload.modeId,
        removedPaths: payload.removedPaths,
      });
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

    const { names, sources } = requirePendingMetadata();

    const typographyPayload = syncTypeStyles ? collectTypographyPayload(allCollections) : null;
    const payloads = allCollections.flatMap((col) => buildCleanApplyPayloads(col, names, sources));
    applyAllRemaining.current = payloads.length + (typographyPayload ? 1 : 0);
    applyAllBatchErrors.current = [];
    setApplying(true);
    // Only send cleanApply=true for the first payload targeting each real
    // Figma collection — keyed by the resolved collectionId, not the role's
    // display name, since a role split across collections can now route
    // more than one payload to distinct real collections that each need
    // their own first-time wipe, and two different roles/modes can resolve
    // to the *same* real collection and must not wipe it twice.
    const cleanedCollections = new Set<string>();
    for (const payload of payloads) {
      const isFirst = !cleanedCollections.has(payload.collectionId);
      if (isFirst) cleanedCollections.add(payload.collectionId);
      send({
        type: "APPLY_TOKENS",
        tokens: payload.tokens,
        resolvedValues: payload.resolvedValues,
        collectionId: payload.collectionId,
        modeId: payload.modeId,
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
      setStatus({ kind: "error", ...describeGitHubError(err, "fetch-tokens") });
    }
  }

  function handlePushCollectionsLoaded(
    figmaCollections: FigmaVariableCollection[],
    figmaVariables: FigmaVariable[],
    figmaTypographyStyles: TypographyStyle[],
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
      githubParsed.metadata,
      figmaTypographyStyles,
    );
    setUnrecognizedCollections(unknownCollectionNames);
    pendingFigmaCollections.current = figmaCollectionData;
    // Keep raw data for writing complete token files to GitHub (not just diff entries)
    pendingFigmaRaw.current = {
      collections: figmaCollections,
      variables: figmaVariables,
      typographyStyles: figmaTypographyStyles,
    };

    // Diff: Figma (new) vs GitHub (current) — githubValue = current state in
    // GitHub, figmaValue = new state from Figma.
    const result = computePushDiff(figmaCollectionData, githubParsed.collections, githubParsed.metadata);

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
      const raw = pendingFigmaRaw.current;
      const parsed = pendingParsed.current;
      if (!raw || !parsed) {
        throw new Error("handleCreatePR called without a pending push diff");
      }
      const changedFiles = buildFilesFromDiffs(
        selectedKeys,
        raw,
        parsed.metadata,
        project.tokensPath,
        pendingFigmaCollections.current,
      );

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
      setStatus({ kind: "error", ...describeGitHubError(err, "create-pr") });
    }
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

  if (view === "collection-mapping") {
    return (
      <CollectionMapping
        project={project}
        activeBranch={activeBranch}
        onBack={() => setView("main")}
        onSaved={(result) => {
          setView("main");
          setStatus({ kind: "success", message: `Collection mapping updated`, url: result.url });
        }}
      />
    );
  }

  if (view === "output-formats") {
    return (
      <OutputFormats
        project={project}
        activeBranch={activeBranch}
        onBack={() => setView("main")}
        onSaved={(result) => {
          setView("main");
          setStatus({ kind: "success", message: `Output formats updated`, url: result.url });
        }}
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
        <Button variant="secondary" size="compact" onClick={onEditProject}>
          Settings
        </Button>
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
            <Button
              variant="primary"
              size="compact"
              onClick={handleCreateBranch}
              disabled={branchCreateLoading || !newBranchName.trim()}
            >
              {branchCreateLoading ? "…" : "Create"}
            </Button>
            <IconButton
              label="Cancel"
              onClick={() => {
                setCreatingBranch(false);
                setNewBranchName("");
                setBranchCreateError(undefined);
              }}
              disabled={branchCreateLoading}
            >
              <IconClose size={11} />
            </IconButton>
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
            <IconButton
              label="Refresh branch list"
              onClick={refreshBranches}
              disabled={branchesLoading || status.kind === "loading"}
            >
              <IconRefresh
                size={11}
                style={branchesLoading ? { animation: "spin 1s linear infinite" } : undefined}
              />
            </IconButton>
            <IconButton
              label={`New branch from ${activeBranch}`}
              onClick={() => {
                setCreatingBranch(true);
                setBranchCreateError(undefined);
              }}
              disabled={status.kind === "loading"}
            >
              <IconPlus size={11} />
            </IconButton>
          </>
        )}
      </div>

      <label style={styles.syncOptionRow}>
        <input
          type="checkbox"
          checked={syncTypeStyles}
          onChange={(e) => handleSyncTypeStylesChange(e.target.checked)}
        />
        <span>
          Sync type styles
          <span style={styles.syncOptionHint}>
            {" "}
            — apply typography groups to Figma as Text Styles
          </span>
        </span>
      </label>

      <div style={styles.actions}>
        <ActionCard
          title="Pull from GitHub"
          description="Fetch token changes from GitHub and review before applying to Figma Variables."
          buttonLabel="Pull"
          buttonVariant="secondary"
          onClick={handlePull}
          disabled={status.kind === "loading"}
        />
        <ActionCard
          title="Push to GitHub"
          description="Export Figma Variables as tokens and open a Pull Request on GitHub."
          buttonLabel="Push → PR"
          buttonVariant="primary"
          onClick={handlePush}
          disabled={status.kind === "loading"}
        />
        <ActionCard
          title="Map collections"
          description="Assign each Figma collection to a role (primitives/global/themes/semantic/sizes) or Ignore."
          buttonLabel="Map"
          buttonVariant="secondary"
          onClick={() => setView("collection-mapping")}
          disabled={status.kind === "loading"}
        />
        <ActionCard
          title="Output formats"
          description="Choose which code files (CSS/JS/TS/Dart/Swift) get generated on push."
          buttonLabel="Configure"
          buttonVariant="secondary"
          onClick={() => setView("output-formats")}
          disabled={status.kind === "loading"}
        />
      </div>

      {status.kind !== "idle" && (
        <StatusBanner
          tone={statusTone(status.kind)}
          detail={status.kind === "error" ? status.detail : undefined}
          action={
            status.kind === "success" && "url" in status && status.url ? (
              <a href={status.url} target="_blank" rel="noreferrer" style={styles.prLink}>
                View PR <IconArrowRight size={10} />
              </a>
            ) : undefined
          }
        >
          {status.message}
        </StatusBanner>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ActionCard({
  title,
  description,
  buttonLabel,
  buttonVariant,
  onClick,
  disabled,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  buttonVariant: "primary" | "secondary";
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <div style={styles.card}>
      <div style={styles.cardText}>
        <div style={styles.cardTitle}>{title}</div>
        <div style={styles.cardDesc}>{description}</div>
      </div>
      <Button
        variant={buttonVariant}
        onClick={onClick}
        disabled={disabled}
        style={{ flexShrink: 0 }}
      >
        {buttonLabel}
      </Button>
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

function statusTone(kind: Status["kind"]): "loading" | "success" | "danger" | "neutral" {
  if (kind === "loading") return "loading";
  if (kind === "success") return "success";
  if (kind === "error") return "danger";
  return "neutral";
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: space.xl, display: "flex", flexDirection: "column", gap: space.lg },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: space.md,
  },
  projectName: { fontWeight: 600, fontSize: 15 },
  projectMeta: { fontSize: font.size.sm, color: color.text.muted, marginTop: 2 },
  lastSync: { color: color.text.faint },
  branchRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    padding: `${space.sm}px ${space.md}px`,
    background: color.surface.subtle,
    borderRadius: radius.md,
    border: `1px solid ${color.border.subtle}`,
  },
  branchLabel: { fontSize: font.size.sm, color: color.text.muted, fontWeight: 500, flexShrink: 0 },
  branchSelect: {
    flex: 1,
    fontSize: font.size.md,
    padding: "3px 6px",
    borderRadius: 5,
    border: `1px solid ${color.border.default}`,
    background: color.surface.default,
    color: "#222222",
    cursor: "pointer",
    fontFamily: font.family,
  },
  branchName: { flex: 1, fontSize: font.size.md, color: "#333333", fontFamily: font.mono },
  branchInput: {
    flex: 1,
    fontSize: font.size.md,
    padding: "3px 8px",
    borderRadius: 5,
    border: `1px solid ${color.accent.default}`,
    outline: "none",
    fontFamily: font.mono,
    minWidth: 0,
  },
  branchError: { fontSize: font.size.sm, color: color.status.danger.text, flexShrink: 0 },
  syncOptionRow: {
    display: "flex",
    alignItems: "center",
    gap: space.xs + 2,
    fontSize: font.size.md,
    color: color.text.secondary,
    cursor: "pointer",
    userSelect: "none",
  },
  syncOptionHint: { color: "#999999" },
  actions: { display: "flex", flexDirection: "column", gap: space.md },
  card: {
    border: `1px solid #e8e8e8`,
    borderRadius: radius.md,
    padding: space.lg,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
  },
  cardText: { display: "flex", flexDirection: "column", gap: space.xs },
  cardTitle: { fontWeight: 500, fontSize: font.size.lg },
  cardDesc: { fontSize: font.size.sm, color: color.text.secondary, lineHeight: 1.4 },
  prLink: {
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: font.size.md,
    color: color.accent.default,
    textDecoration: "none",
    fontWeight: 500,
  },
};
