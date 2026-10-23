/**
 * Sync view — main screen after a project is configured.
 * Manages the pull and push flows.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { Project } from "../App";
import {
  fetchTokenFiles,
  fetchRepoPaths,
  fetchBranches,
  createBranch,
  createTokenPR,
} from "../hooks/useGitHub";
import { useSendMessage, usePluginMessage } from "../hooks/usePlugin";
import { parseRepository } from "../../shared/token-merger";
import type {
  ParsedRepository,
  Metadata,
  CollectionNames,
  CollectionSources,
} from "../../shared/token-merger";
import type { figmaToCollections } from "../../shared/figma-to-tokens";
import { toFigmaVarName } from "../../shared/token-format";
import type { CollectionDiff } from "../../shared/token-diff";
import { buildFilesFromDiffs } from "../../shared/sync-logic";
import {
  startApplyBatch,
  isBatchActive,
  batchTaskFinished,
  batchErrorReceived,
  summarizeBatch,
  planApply,
  planCleanApply,
} from "../../shared/apply-batch";
import type { ApplyBatch } from "../../shared/apply-batch";
import { reviewPull, reviewPush, skippedCollectionsSuffix } from "../syncReview";
import type { StaleConfiguredMode } from "../../shared/sync-logic";
import type { PluginMessage, FigmaVariableCollection, FigmaVariable } from "../../shared/messages";
import type { TypographyStyle } from "../../shared/typography-styles";
import { PullDiff } from "./PullDiff";
import { Help } from "./Help";
import { PushDiff } from "./PushDiff";
import { CollectionMapping } from "./CollectionMapping";
import { OutputFormats } from "./OutputFormats";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { StatusBanner } from "../components/StatusBanner";
import { IconArrowRight, IconClose, IconHelp, IconPlus, IconRefresh } from "../icons";
import { color, font, radius, space } from "../theme";
import { describeGitHubError, describePluginError, describeUnreadableFiles } from "../errors";
import type { DescribedError } from "../errors";

type View = "main" | "pull-diff" | "push-diff" | "collection-mapping" | "output-formats" | "help";

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "success"; message: string; url?: string }
  | ({ kind: "error" } & DescribedError);

interface LastSync {
  repo: string;
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
  // A project can now be saved with no GitHub connection yet — the wizard's
  // Skip-test/Finish-setup and the flat form's Add/Save no longer require
  // it (see AddProjectWizard.tsx / Setup.tsx). Nothing below this point
  // should attempt a GitHub API call, or show controls whose only purpose
  // is one, while that's true.
  const isConnected = Boolean(project.pat.trim() && project.repo.trim());

  const [view, setView] = useState<View>("main");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [applying, setApplying] = useState(false);
  const [creating, setCreating] = useState(false);
  const [diffs, setDiffs] = useState<CollectionDiff[]>([]);
  const [diffError, setDiffError] = useState<DescribedError | undefined>(undefined);
  // Mirrors diffError — handleCreatePR's own failure was previously only
  // reported via the shared `status` state, which nothing renders while
  // still on the push-diff view (unlike the main screen). A real failure
  // (found live: a GitHub error creating the PR) looked exactly like the
  // button doing nothing at all.
  const [createError, setCreateError] = useState<DescribedError | undefined>(undefined);
  const [unrecognizedCollections, setUnrecognizedCollections] = useState<string[]>([]);
  // A "ghost" alias — Figma's own variable picker shows the right target
  // name, but the underlying link is dead — silently dropped the whole
  // field from every synced output with zero trace anywhere. Confirmed
  // live (Vy's Spor system). Surfaced the same way unrecognizedCollections
  // already is, since Token Spark can't fix a broken link in Figma's own
  // data, only report it.
  const [brokenAliasPaths, setBrokenAliasPaths] = useState<string[]>([]);
  // Two real Figma variable names structurally collide (e.g. "surface/brand"
  // and "surface/brand/default" both existing) — figmaToTokenFiles' tree
  // builder can't represent both at once and would silently corrupt or lose
  // data if written. Computed here (against the full, unfiltered Figma data,
  // the same way unrecognizedCollections/brokenAliasPaths already are) so
  // it's visible on the diff screen itself, not only as the hard stop
  // handleCreatePR still enforces against whatever's actually selected.
  const [conflictPaths, setConflictPaths] = useState<string[]>([]);
  // A theme/colorScheme/size mode renamed in Figma since "Map Collections"
  // was last saved — metadata.json's configured name (a sanitized slug, or
  // stale real casing) no longer matches any live Figma mode for that role.
  // Figma pushes/pulls fine under its own current name; the *other* side's
  // config silently stops finding it at all, with no error either way.
  // Computed on both push and pull, same as the checks above.
  const [staleConfiguredModes, setStaleConfiguredModes] = useState<StaleConfiguredMode[]>([]);
  // Push, zero token changes: an enabled platform's output file that's never
  // been generated (e.g. just turned on in Output Formats) — see PushDiff's
  // "output-only" state.
  const [outputOnlyFiles, setOutputOnlyFiles] = useState<string[]>([]);
  const [lastSync, setLastSync] = useState<LastSync | null>(null);

  // Branch switching — persisted per project; defaults to the configured branch.
  // Stored as {repo, branch} rather than a bare branch string, so that editing
  // a project's repo in Settings (project.id unchanged) correctly invalidates
  // a branch name cached for the *previous* repo instead of silently resurrecting
  // it — found live: a project repointed at a new repo still showed the old
  // repo's branch name on this screen after Settings reported success.
  const branchKey = `tokenspark:branch:${project.id}`;
  const [activeBranch, setActiveBranch] = useState(project.branch);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchCreateError, setBranchCreateError] = useState<string | undefined>(undefined);
  const [branchCreateLoading, setBranchCreateLoading] = useState(false);

  const lastSyncKey = `tokenspark:lastSync:${project.id}`;

  // Whether to sync typography ("$type": "typography" marked groups) as Figma
  // Text Styles at all — persisted per project, defaults OFF. Off just skips
  // sending APPLY_TEXT_STYLES; it never affects Variables sync. Defaults off
  // (not on) because the full apply flow — create-or-find by name, the
  // combined fontName merge, lineHeight/letterSpacing unit handling — has
  // not been verified end-to-end against a real Figma file; only one
  // isolated binding call has been confirmed live. Flip to on once that's
  // done, or once a team has verified it against their own file.
  const syncTypeStylesKey = `tokenspark:syncTypeStyles:${project.id}`;
  const [syncTypeStyles, setSyncTypeStyles] = useState(false);

  const viewRef = useRef<View>("main");
  const pendingAction = useRef<PendingAction | null>(null);
  // Progress of the running batch apply — see shared/apply-batch.ts. Errors and
  // removals accumulate across every task (including one that threw entirely,
  // which arrives as a plain ERROR), so the summary covers the whole batch.
  const applyBatch = useRef<ApplyBatch>(startApplyBatch(0));
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
  const pendingRepoPaths = useRef<Set<string> | null>(null); // push: every real blob path in the repo, for detecting an enabled platform's never-generated output file

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
    if (isConnected) refreshBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  function handleBranchChange(branch: string) {
    setActiveBranch(branch);
    send({
      type: "SAVE_STORAGE",
      key: branchKey,
      value: JSON.stringify({ repo: project.repo, branch }),
    });
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
    const entry: LastSync = { repo: project.repo, timestamp: Date.now(), direction };
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
            // Same fix as the branch cache below: only trust a cached
            // "last synced" timestamp for the repo it was cached against — a
            // pre-fix value (no `repo` field) fails the check and is
            // discarded, same as it should be, since it can't be trusted
            // either. Found live: repointing a project at a different repo
            // still showed "Pulled 3h ago" from the *previous* repo, even
            // though nothing had ever synced against the new one.
            const parsed = msg.value ? (JSON.parse(msg.value) as LastSync) : null;
            setLastSync(parsed && parsed.repo === project.repo ? parsed : null);
          } catch {
            setLastSync(null);
          }
        }
        if (msg.type === "STORAGE_LOADED" && msg.key === branchKey) {
          if (msg.value) {
            try {
              const stored = JSON.parse(msg.value) as { repo: string; branch: string };
              // Only trust a cached branch name for the repo it was cached
              // against — a pre-fix bare-string value (no `repo` field) fails
              // this parse and falls through, correctly discarding a name
              // that predates this fix and can't be trusted either.
              if (stored.repo === project.repo) setActiveBranch(stored.branch);
            } catch {
              // pre-fix format or corrupt value — ignore, keep project.branch
            }
          }
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
          if (isBatchActive(applyBatch.current)) {
            applyBatch.current = batchTaskFinished(applyBatch.current, msg);
            if (!isBatchActive(applyBatch.current)) finishApplyBatch();
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
          if (isBatchActive(applyBatch.current)) {
            applyBatch.current = batchTaskFinished(applyBatch.current, msg);
            if (!isBatchActive(applyBatch.current)) finishApplyBatch();
          }
        }
        if (msg.type === "ERROR") {
          // Mid-batch: this task failed before it could send its own
          // TOKENS_APPLIED/TEXT_STYLES_APPLIED at all (e.g. collection.addMode
          // rejected outside the per-token try/catch) — still counts against
          // the batch the same way a reported error would, or the counter
          // never reaches zero and the collections that DID succeed never get
          // a final summary shown.
          if (isBatchActive(applyBatch.current)) {
            applyBatch.current = batchErrorReceived(applyBatch.current, msg.message, msg.context);
            if (!isBatchActive(applyBatch.current)) finishApplyBatch();
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
      // A failure from a previous apply stays in diffError until something
      // clears it — without this it reappeared on the next pull's diff screen.
      setDiffError(undefined);
      setStatus({ kind: "loading", message: "Fetching tokens from GitHub…" });

      const files = await fetchTokenFiles({
        pat: project.pat,
        repo: project.repo,
        branch: activeBranch,
        tokensPath: project.tokensPath,
      });

      setStatus({ kind: "loading", message: `Parsing ${files.length} token files…` });
      const parsed = parseRepository(files, project.tokensPath);
      if (parsed.unreadableFiles.length > 0) {
        // Never diff without them: their tokens would show as removed in
        // GitHub, and Apply would delete the matching Figma variables.
        setStatus({ kind: "error", ...describeUnreadableFiles(parsed.unreadableFiles) });
        return;
      }
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

    // Real, live Figma/GitHub data this code doesn't control can be malformed
    // in a way no test fixture anticipated (found live testing an unfamiliar
    // design system's Figma structure — a malformed $value crashed this whole
    // synchronous block with an uncaught TypeError). Every other GitHub call
    // in this file reports failure via setStatus; this one didn't, so an
    // exception here left "Calculating diff…" spinning forever with no
    // visible error at all.
    try {
      const review = reviewPull(github, figmaCollections, figmaVariables, figmaTypographyStyles);
      setStaleConfiguredModes(review.staleModes);

      // "Up to date" needs no changes AND no stale configured mode: a stale mode
      // hides its whole collection from the diff (nothing on the other side to
      // compare against), which looks identical to being up to date. Open the
      // diff view anyway so the warning banner has a chance to render.
      if (review.outcome === "up-to-date") {
        setStatus({ kind: "success", message: "Figma is already up to date with GitHub" });
      } else {
        setStatus({ kind: "idle" });
        setDiffs(review.diffs);
        setView("pull-diff");
      }

      // Clean Apply must also skip ignored collections — store the filtered list
      pendingGitHubCollections.current = review.filteredGithubCollections;
      pendingGitHubMetadata.current = github.metadata;
    } catch (err) {
      setStatus({
        kind: "error",
        message: "Something went wrong while calculating the diff.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    pendingGitHub.current = null;
  }

  /**
   * Shared finalize step once every task in a batch apply has reported back
   * — whether via its own TOKENS_APPLIED/TEXT_STYLES_APPLIED, or because it
   * threw entirely and came back as a plain ERROR instead (see the message
   * handler above). Every path funnels through applyBatch, so there's exactly
   * one place that decides the batch is done and what its summary says.
   */
  function finishApplyBatch() {
    const summary = summarizeBatch(applyBatch.current);
    setApplying(false);
    viewRef.current = "main";
    setView("main");
    if (summary.kind === "success") saveLastSync("pull");
    setStatus(summary);
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

  // Both apply paths build a plan of exactly what to send (shared/apply-batch.ts),
  // start the batch tracker with the number of tasks to expect, then send in
  // order — the plugin's serial queue runs them in that order, which is what
  // makes typography (last) bind after the Variables it references exist.
  function runApplyPlan(plan: { messages: Parameters<typeof send>[0][]; taskCount: number }) {
    if (plan.taskCount === 0) return; // nothing to send — don't sit on "Applying…" forever
    applyBatch.current = startApplyBatch(plan.taskCount);
    setApplying(true);
    for (const message of plan.messages) send(message);
  }

  function handleApplyAll(selectedKeys: Set<string>) {
    const { names, sources } = requirePendingMetadata();
    runApplyPlan(
      planApply({
        diffs,
        selectedKeys,
        pendingCollections: pendingGitHubCollections.current ?? [],
        names,
        sources,
        syncTypeStyles,
      }),
    );
  }

  function handleCleanApplyAll() {
    const collections = pendingGitHubCollections.current;
    if (!collections) return;
    const { names, sources } = requirePendingMetadata();
    runApplyPlan(planCleanApply({ collections, names, sources, syncTypeStyles }));
  }

  // ---------------------------------------------------------------------------
  // Push flow
  // ---------------------------------------------------------------------------

  async function handlePush() {
    try {
      setStatus({ kind: "loading", message: "Fetching current tokens from GitHub…" });

      const githubConfig = {
        pat: project.pat,
        repo: project.repo,
        branch: activeBranch,
        tokensPath: project.tokensPath,
      };
      const [files, repoPaths] = await Promise.all([
        fetchTokenFiles(githubConfig),
        fetchRepoPaths(githubConfig),
      ]);

      pendingFiles.current = files;
      pendingRepoPaths.current = repoPaths;
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

    // Real, live Figma/GitHub data this code doesn't control can be malformed
    // in a way no test fixture anticipated (found live testing an unfamiliar
    // design system's Figma structure — a malformed $value crashed this whole
    // synchronous block with an uncaught TypeError). Every other GitHub call
    // in this file reports failure via setStatus; this one didn't, so an
    // exception here left "Calculating diff…" spinning forever with no
    // visible error at all.
    try {
      const review = reviewPush({
        githubFiles,
        tokensPath: project.tokensPath,
        figmaCollections,
        figmaVariables,
        figmaTypographyStyles,
        repoPaths: pendingRepoPaths.current ?? new Set(),
      });

      pendingParsed.current = review.githubParsed;
      pendingFigmaCollections.current = review.figmaCollectionData;
      // Keep raw data for writing complete token files to GitHub (not just diff entries)
      pendingFigmaRaw.current = {
        collections: figmaCollections,
        variables: figmaVariables,
        typographyStyles: figmaTypographyStyles,
      };
      setUnrecognizedCollections(review.unknownCollectionNames);
      setBrokenAliasPaths(review.brokenAliasPaths);
      setConflictPaths(review.conflictPaths);
      setStaleConfiguredModes(review.staleModes);
      setOutputOnlyFiles(review.outputOnlyFiles);

      // "Up to date" needs no token changes, no enabled-but-never-generated
      // output file, AND no stale configured mode — the last two are reasons to
      // open the screen even with an empty diff (see shared syncReview.ts).
      if (review.outcome === "up-to-date") {
        setStatus({
          kind: "success",
          message: `GitHub is already up to date with Figma${skippedCollectionsSuffix(review.unknownCollectionNames)}`,
        });
      } else {
        setStatus({ kind: "idle" });
        setDiffs(review.diffs);
        setView("push-diff");
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: "Something went wrong while calculating the diff.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    pendingFiles.current = null;
  }

  async function handleCreatePR(prTitle: string, selectedKeys: Set<string>) {
    setCreating(true);
    setCreateError(undefined);
    try {
      const raw = pendingFigmaRaw.current;
      const parsed = pendingParsed.current;
      if (!raw || !parsed) {
        throw new Error("handleCreatePR called without a pending push diff");
      }
      const { files: changedFiles, conflictPaths } = buildFilesFromDiffs(
        selectedKeys,
        raw,
        parsed.metadata,
        project.tokensPath,
        pendingFigmaCollections.current,
      );

      // A real Figma variable name structurally collides with another one
      // at the same position (e.g. "surface/brand" and "surface/brand/default"
      // both existing) — confirmed live (Vy's Spor system) to silently corrupt
      // or destroy data depending purely on Figma's own variable return order.
      // Refuse to write known-incomplete files rather than let a bad commit
      // through; the fix is in Figma (rename/delete the colliding variable),
      // not something Token Spark can safely guess at.
      if (conflictPaths.length > 0) {
        const figmaNames = conflictPaths.map(toFigmaVarName).join(", ");
        throw new Error(
          `Can't push — ${figmaNames} ${conflictPaths.length === 1 ? "conflicts" : "conflict"} ` +
            `with another variable in Figma (a variable is named exactly this, and other variables ` +
            `are also nested under that same name). Rename or delete one of them in Figma, then push again.`,
        );
      }

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
      // Reported via createError, not setStatus — the push-diff view (still
      // active here; a failure doesn't navigate away) renders createError
      // itself, the same way PullDiff already renders diffError. setStatus
      // alone was invisible here, since nothing on this view ever read it.
      setCreateError(describeGitHubError(err, "create-pr"));
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
        staleConfiguredModes={staleConfiguredModes}
        onApply={handleApplyAll}
        onCleanApply={handleCleanApplyAll}
        onBack={() => {
          viewRef.current = "main";
          setView("main");
          setStatus({ kind: "idle" });
          pendingGitHubCollections.current = null;
          setStaleConfiguredModes([]);
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
        brokenAliasPaths={brokenAliasPaths}
        conflictPaths={conflictPaths}
        staleConfiguredModes={staleConfiguredModes}
        outputOnlyFiles={outputOnlyFiles}
        onCreatePR={(title, keys) => handleCreatePR(title, keys)}
        onBack={() => {
          setView("main");
          setStatus({ kind: "idle" });
          pendingFigmaRaw.current = null;
          setUnrecognizedCollections([]);
          setBrokenAliasPaths([]);
          setConflictPaths([]);
          setStaleConfiguredModes([]);
          setOutputOnlyFiles([]);
          setCreateError(undefined);
        }}
        creating={creating}
        error={createError}
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

  if (view === "help") {
    return <Help onBack={() => setView("main")} />;
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
        <IconButton label="About & tips" onClick={() => setView("help")}>
          <IconHelp size={13} />
        </IconButton>
        <Button variant="secondary" size="compact" onClick={onEditProject}>
          Settings
        </Button>
      </div>

      {!isConnected ? (
        <div style={styles.notConnected}>
          <div style={styles.notConnectedText}>
            Add a GitHub personal access token and repository to enable Pull and Push.
          </div>
          <Button variant="primary" onClick={onEditProject}>
            Connect GitHub
          </Button>
        </div>
      ) : (
        <>
          <div style={styles.branchRow}>
            {creatingBranch ? (
              <>
                <input
                  className="ts-input"
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
        </>
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
  notConnected: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: space.md,
    padding: `${space.xxl}px ${space.lg}px`,
    color: color.text.secondary,
  },
  notConnectedText: { fontSize: font.size.md, lineHeight: 1.5 },
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
