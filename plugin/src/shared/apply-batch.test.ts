import { describe, it, expect } from "vitest";
import {
  startApplyBatch,
  isBatchActive,
  batchTaskFinished,
  batchErrorReceived,
  summarizeBatch,
  planApply,
  planCleanApply,
} from "./apply-batch";
import type { CollectionDiff, DiffEntry } from "./token-diff";
import type { CollectionNames, CollectionSources, ResolvedCollection } from "./token-merger";
import type { TypographyStyle } from "./typography-styles";

// ─────────────────────────────────────────────────────────────────────────
// Batch tracker
// ─────────────────────────────────────────────────────────────────────────

describe("apply batch tracker", () => {
  it("stays active until every task has reported back, then is done", () => {
    let b = startApplyBatch(3);
    expect(isBatchActive(b)).toBe(true);
    b = batchTaskFinished(b, { errors: [] });
    b = batchTaskFinished(b, { errors: [] });
    expect(isBatchActive(b)).toBe(true);
    b = batchTaskFinished(b, { errors: [] });
    expect(isBatchActive(b)).toBe(false);
  });

  it("accumulates errors across every task, not just the last one", () => {
    let b = startApplyBatch(2);
    b = batchTaskFinished(b, { errors: ["first failed"] });
    b = batchTaskFinished(b, { errors: [] });
    expect(summarizeBatch(b)).toEqual({
      kind: "error",
      message: "All collections applied to Figma (1 error: first failed)",
    });
  });

  it("sums removals across the whole batch instead of reporting only the last task's", () => {
    // Regression: the summary used `removed` from whichever TOKENS_APPLIED
    // happened to arrive last — a batch that deleted 5 variables in one
    // collection and 0 in the next reported "0 removed" (i.e. nothing).
    let b = startApplyBatch(3);
    b = batchTaskFinished(b, { errors: [], removed: 5 });
    b = batchTaskFinished(b, { errors: [], removed: 2 });
    b = batchTaskFinished(b, { errors: [] }); // e.g. the text-styles task
    expect(summarizeBatch(b)).toEqual({
      kind: "success",
      message: "All collections applied to Figma, 7 removed",
    });
  });

  it("reports a clean success with no suffix when nothing was removed and nothing failed", () => {
    let b = startApplyBatch(1);
    b = batchTaskFinished(b, { errors: [], removed: 0 });
    expect(summarizeBatch(b)).toEqual({
      kind: "success",
      message: "All collections applied to Figma",
    });
  });

  it("pluralises the error count", () => {
    let b = startApplyBatch(1);
    b = batchTaskFinished(b, { errors: ["a", "b"] });
    expect(summarizeBatch(b).message).toBe("All collections applied to Figma (2 errors: a)");
  });

  it("counts a task that threw entirely (an APPLY_TOKENS-context ERROR) as finished", () => {
    let b = startApplyBatch(2);
    b = batchTaskFinished(b, { errors: [] });
    b = batchErrorReceived(b, "addMode rejected", "APPLY_TOKENS");
    expect(isBatchActive(b)).toBe(false);
    expect(summarizeBatch(b).kind).toBe("error");
  });

  it("records an unrelated ERROR (e.g. a failed storage write) without consuming a task slot", () => {
    // Regression: any ERROR message mid-batch was counted as a finished apply
    // task, so a failed SAVE_STORAGE could end the batch early — summarising
    // it as done while real collections were still being applied.
    let b = startApplyBatch(2);
    b = batchErrorReceived(b, "storage full", "SAVE_STORAGE");
    expect(isBatchActive(b)).toBe(true);
    expect(b.remaining).toBe(2);
    b = batchTaskFinished(b, { errors: [] });
    b = batchTaskFinished(b, { errors: [] });
    expect(isBatchActive(b)).toBe(false);
    expect(summarizeBatch(b).message).toBe(
      "All collections applied to Figma (1 error: storage full)",
    );
  });

  it("ignores a stray task report when no batch is running", () => {
    const idle = startApplyBatch(0);
    expect(batchTaskFinished(idle, { errors: ["x"] })).toEqual(idle);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Apply planning
// ─────────────────────────────────────────────────────────────────────────

const names: CollectionNames = {
  primitives: ["Primitives"],
  global: ["Global"],
  themes: ["Themes"],
  semantic: ["Semantic"],
  sizes: [],
};
const noSources: CollectionSources = {};

function entry(path: string, status: DiffEntry["status"], value = "#fff"): DiffEntry {
  return {
    path,
    type: "color",
    status,
    githubValue: status === "removed" ? null : value,
    githubRawValue: status === "removed" ? null : value,
    figmaValue: status === "added" ? null : "#000",
    figmaRawValue: status === "added" ? null : "#000",
  };
}

function diff(collectionName: string, modeName: string, entries: DiffEntry[]): CollectionDiff {
  const counts = {
    added: entries.filter((e) => e.status === "added").length,
    changed: entries.filter((e) => e.status === "changed").length,
    removed: entries.filter((e) => e.status === "removed").length,
    total: entries.length,
  };
  return { collectionName, modeName, entries, counts };
}

const style = (path: string): TypographyStyle => ({
  path,
  fields: { fontSize: { $type: "dimension", $value: "16px" } },
});

function col(
  collectionName: string,
  modeName: string,
  tokens: ResolvedCollection["tokens"],
  typographyStyles: TypographyStyle[] = [],
): ResolvedCollection {
  return { collectionName, modeName, tokens, rawTokens: tokens, typographyStyles };
}

describe("planApply (selective)", () => {
  const diffs = [
    diff("Themes", "Alpha", [entry("brand.a", "changed"), entry("brand.gone", "removed")]),
    diff("Semantic", "Light", [entry("text.a", "added")]),
  ];

  it("sends one APPLY_TOKENS per selected diff, carrying removals, and counts them as tasks", () => {
    const plan = planApply({
      diffs,
      selectedKeys: new Set(["Themes/Alpha"]),
      pendingCollections: [],
      names,
      sources: noSources,
      syncTypeStyles: false,
    });
    expect(plan.taskCount).toBe(1);
    expect(plan.messages).toHaveLength(1);
    const m = plan.messages[0];
    expect(m.type).toBe("APPLY_TOKENS");
    if (m.type !== "APPLY_TOKENS") throw new Error("unreachable");
    expect(m.collectionId).toBe("Themes");
    expect(m.modeId).toBe("Alpha");
    expect(Object.keys(m.tokens)).toEqual(["brand.a"]);
    expect(m.removedPaths).toEqual(["brand.gone"]);
    expect(m.cleanApply).toBeUndefined();
  });

  it("skips diffs that aren't selected, and diffs with no changes", () => {
    const plan = planApply({
      diffs: [...diffs, diff("Global", "Value", [])],
      selectedKeys: new Set(["Global/Value"]),
      pendingCollections: [],
      names,
      sources: noSources,
      syncTypeStyles: false,
    });
    expect(plan).toEqual({ messages: [], taskCount: 0 });
  });

  it("appends typography last — only when enabled, and only for the collections being applied", () => {
    const pendingCollections = [
      col("Themes", "Alpha", {}, [style("type.a")]),
      col("Semantic", "Light", {}, [style("type.b")]),
    ];
    const args = {
      diffs,
      selectedKeys: new Set(["Themes/Alpha"]),
      pendingCollections,
      names,
      sources: noSources,
    };

    const off = planApply({ ...args, syncTypeStyles: false });
    expect(off.messages.map((m) => m.type)).toEqual(["APPLY_TOKENS"]);

    const on = planApply({ ...args, syncTypeStyles: true });
    expect(on.taskCount).toBe(2);
    expect(on.messages.map((m) => m.type)).toEqual(["APPLY_TOKENS", "APPLY_TEXT_STYLES"]);
    const last = on.messages[1];
    if (last.type !== "APPLY_TEXT_STYLES") throw new Error("unreachable");
    // Only Themes/Alpha's style — Semantic/Light wasn't selected.
    expect(last.styles.map((s) => s.path)).toEqual(["type.a"]);
  });

  it("sends no typography message when the applied collections have no styles", () => {
    const plan = planApply({
      diffs,
      selectedKeys: new Set(["Themes/Alpha"]),
      pendingCollections: [col("Themes", "Alpha", {})],
      names,
      sources: noSources,
      syncTypeStyles: true,
    });
    expect(plan.messages.map((m) => m.type)).toEqual(["APPLY_TOKENS"]);
  });
});

describe("planCleanApply", () => {
  it("wipes each real collection once — only its first payload carries cleanApply", () => {
    // Two modes of one collection resolve to the same real Figma collection;
    // wiping it twice would delete what the first payload just created.
    const plan = planCleanApply({
      collections: [
        col("Themes", "Alpha", { "brand.a": { $type: "color", $value: "#111" } }),
        col("Themes", "Beta", { "brand.a": { $type: "color", $value: "#222" } }),
        col("Semantic", "Light", { "text.a": { $type: "color", $value: "#333" } }),
      ],
      names,
      sources: noSources,
      syncTypeStyles: false,
    });
    const wipes = plan.messages.map((m) =>
      m.type === "APPLY_TOKENS" ? [m.collectionId, m.modeId, m.cleanApply] : null,
    );
    expect(wipes).toEqual([
      ["Themes", "Alpha", true],
      ["Themes", "Beta", false],
      ["Semantic", "Light", true],
    ]);
    expect(plan.taskCount).toBe(3);
  });

  it("appends one typography task, gathering every collection's styles, last", () => {
    const plan = planCleanApply({
      collections: [
        col("Global", "Value", { "a.b": { $type: "dimension", $value: "4px" } }, [style("type.a")]),
        col("Themes", "Alpha", { "brand.a": { $type: "color", $value: "#111" } }, [
          style("type.b"),
        ]),
      ],
      names,
      sources: noSources,
      syncTypeStyles: true,
    });
    expect(plan.messages.map((m) => m.type)).toEqual([
      "APPLY_TOKENS",
      "APPLY_TOKENS",
      "APPLY_TEXT_STYLES",
    ]);
    const last = plan.messages[2];
    if (last.type !== "APPLY_TEXT_STYLES") throw new Error("unreachable");
    expect(last.styles.map((s) => s.path)).toEqual(["type.a", "type.b"]);
    expect(last.resolvedFallback).toEqual({ "a.b": "4px", "brand.a": "#111" });
    expect(plan.taskCount).toBe(3);
  });

  it("plans nothing for an empty pull", () => {
    expect(
      planCleanApply({ collections: [], names, sources: noSources, syncTypeStyles: true }),
    ).toEqual({
      messages: [],
      taskCount: 0,
    });
  });
});
