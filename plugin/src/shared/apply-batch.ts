/**
 * Apply-to-Figma bookkeeping, pulled out of Sync.tsx so it's testable.
 *
 * Two independent pieces:
 *   - a batch tracker: an apply fans out into several queued plugin tasks
 *     (one per real collection, plus optionally one for Text Styles), each of
 *     which reports back on its own; the UI needs to know when the last one
 *     has, and what the whole batch amounted to.
 *   - apply planning: turning a reviewed diff (or a whole pull, for Clean
 *     Apply) into the exact messages to send and how many tasks to expect.
 *
 * Pure — no React, no Figma. The message handler and the sends stay in
 * Sync.tsx; this only decides what they say.
 */

import type { TokenValue, UIMessage } from "./messages";
import type { CollectionDiff } from "./token-diff";
import type { CollectionNames, CollectionSources, ResolvedCollection } from "./token-merger";
import type { TypographyStyle } from "./typography-styles";
import { buildApplyPayloads, buildCleanApplyPayloads } from "./sync-logic";

// ---------------------------------------------------------------------------
// Batch tracker
// ---------------------------------------------------------------------------

export interface ApplyBatch {
  /** Queued tasks that haven't reported back yet. */
  remaining: number;
  /** Every error from every task, in arrival order. */
  errors: string[];
  /** Variables deleted across the whole batch. */
  removed: number;
}

export function startApplyBatch(taskCount: number): ApplyBatch {
  return { remaining: taskCount, errors: [], removed: 0 };
}

export function isBatchActive(batch: ApplyBatch): boolean {
  return batch.remaining > 0;
}

/** One queued task reported back (TOKENS_APPLIED / TEXT_STYLES_APPLIED). A
 * report with no batch running is ignored. */
export function batchTaskFinished(
  batch: ApplyBatch,
  result: { errors: string[]; removed?: number },
): ApplyBatch {
  if (!isBatchActive(batch)) return batch;
  return {
    remaining: batch.remaining - 1,
    errors: [...batch.errors, ...result.errors],
    removed: batch.removed + (result.removed ?? 0),
  };
}

/** The plugin's serial apply queue reports a task that threw entirely — before
 * it could send its own *_APPLIED message — as an ERROR with this context. */
const APPLY_QUEUE_ERROR_CONTEXT = "APPLY_TOKENS";

/**
 * An ERROR arrived while a batch is running. Only one raised by the apply
 * queue means a task is finished (it threw instead of reporting); any other
 * (a failed storage write, say) is still an error the summary should show,
 * but says nothing about the apply tasks — counting it as one ended the batch
 * early, with collections still being applied.
 */
export function batchErrorReceived(
  batch: ApplyBatch,
  message: string,
  context: string | undefined,
): ApplyBatch {
  if (!isBatchActive(batch)) return batch;
  if (context === APPLY_QUEUE_ERROR_CONTEXT) {
    return batchTaskFinished(batch, { errors: [message] });
  }
  return { ...batch, errors: [...batch.errors, message] };
}

export function summarizeBatch(batch: ApplyBatch): { kind: "success" | "error"; message: string } {
  const removedSuffix = batch.removed > 0 ? `, ${batch.removed} removed` : "";
  const n = batch.errors.length;
  const errSuffix = n ? ` (${n} error${n > 1 ? "s" : ""}: ${batch.errors[0]})` : "";
  return {
    kind: n ? "error" : "success",
    message: `All collections applied to Figma${removedSuffix}${errSuffix}`,
  };
}

// ---------------------------------------------------------------------------
// Apply planning
// ---------------------------------------------------------------------------

export interface ApplyPlan {
  /** In send order — the plugin's serial queue runs them in this order. */
  messages: UIMessage[];
  /** How many tasks will report back — pass to startApplyBatch. */
  taskCount: number;
}

const EMPTY_PLAN: ApplyPlan = { messages: [], taskCount: 0 };

/**
 * Gathers typography styles (from marked "$type": "typography" groups — see
 * shared/typography-styles.ts) across the given collections into one
 * APPLY_TEXT_STYLES payload, along with a flat resolved-value fallback map
 * for refs the plugin can't bind directly. Null when there's nothing to apply.
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
 * Selective apply: the diffs the user left checked. A role backed by more than
 * one physical Figma collection can fan out into more than one APPLY_TOKENS
 * payload, each routed to the real collection its tokens belong to (see
 * buildApplyPayloads). Typography rides along last, only for the collections
 * actually being applied — the plugin's serial queue guarantees styles bind
 * after their Variables exist.
 */
export function planApply(input: {
  diffs: CollectionDiff[];
  selectedKeys: Set<string>;
  /** parseRepository's collections (already ignore-filtered) — source of typography styles. */
  pendingCollections: ResolvedCollection[];
  names: CollectionNames;
  sources: CollectionSources;
  syncTypeStyles: boolean;
}): ApplyPlan {
  const { diffs, selectedKeys, pendingCollections, names, sources, syncTypeStyles } = input;

  const pending = diffs.filter(
    (d) => d.counts.total > 0 && selectedKeys.has(`${d.collectionName}/${d.modeName}`),
  );
  if (pending.length === 0) return EMPTY_PLAN;

  const payloads = pending.flatMap((diff) => buildApplyPayloads(diff, names, sources));

  const relevantCollections = pendingCollections.filter((c) =>
    pending.some((d) => d.collectionName === c.collectionName && d.modeName === c.modeName),
  );
  const typography = syncTypeStyles ? collectTypographyPayload(relevantCollections) : null;

  const messages: UIMessage[] = payloads.map((payload) => ({
    type: "APPLY_TOKENS",
    tokens: payload.tokens,
    resolvedValues: payload.resolvedValues,
    collectionId: payload.collectionId,
    modeId: payload.modeId,
    removedPaths: payload.removedPaths,
  }));
  if (typography) {
    messages.push({
      type: "APPLY_TEXT_STYLES",
      styles: typography.styles,
      resolvedFallback: typography.resolvedFallback,
    });
  }
  return { messages, taskCount: messages.length };
}

/**
 * Clean Apply: every token in every collection, wiping each real Figma
 * collection once before it's rebuilt.
 */
export function planCleanApply(input: {
  collections: ResolvedCollection[];
  names: CollectionNames;
  sources: CollectionSources;
  syncTypeStyles: boolean;
}): ApplyPlan {
  const { collections, names, sources, syncTypeStyles } = input;

  const payloads = collections.flatMap((col) => buildCleanApplyPayloads(col, names, sources));
  const typography = syncTypeStyles ? collectTypographyPayload(collections) : null;

  // Only the first payload targeting each real Figma collection wipes it —
  // keyed by the resolved collectionId, not the role's display name: a role
  // split across collections routes payloads to distinct real collections that
  // each need their own first-time wipe, while two roles/modes resolving to the
  // *same* real collection must not wipe it twice (that would delete what the
  // first payload just created).
  const cleaned = new Set<string>();
  const messages: UIMessage[] = payloads.map((payload) => {
    const isFirst = !cleaned.has(payload.collectionId);
    if (isFirst) cleaned.add(payload.collectionId);
    return {
      type: "APPLY_TOKENS",
      tokens: payload.tokens,
      resolvedValues: payload.resolvedValues,
      collectionId: payload.collectionId,
      modeId: payload.modeId,
      cleanApply: isFirst,
    };
  });
  if (typography) {
    messages.push({
      type: "APPLY_TEXT_STYLES",
      styles: typography.styles,
      resolvedFallback: typography.resolvedFallback,
    });
  }
  return { messages, taskCount: messages.length };
}
