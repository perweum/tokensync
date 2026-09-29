/**
 * Local dev preview — a persistent tool, not shipped code. vite.config's
 * build.rollupOptions.input is "index.html" only, so this file and
 * preview.html at the repo root never end up in the actual plugin bundle;
 * they only exist for `npm run dev`.
 *
 * Run `npm run dev` from plugin/, then open http://localhost:5173/preview.html
 * to click through views in a real browser without Figma or a real GitHub
 * token. Currently covers onboarding (Setup, both Add and Edit — Add now
 * goes through the full Welcome→...→Tips wizard), Push/Pull diffs, and the
 * standalone Help view; extend the `pages` map below for anything else.
 *
 * Mocks window.fetch for GitHub's branches endpoint: type a repo containing
 * "bad" (e.g. "org/bad-repo") to see the Test Connection failure state.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Setup } from "./views/Setup";
import { PushDiff } from "./views/PushDiff";
import { PullDiff } from "./views/PullDiff";
import { Help } from "./views/Help";
import { Sync } from "./views/Sync";
import type { Project } from "./App";
import type { CollectionDiff } from "../shared/token-diff";

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/branches")) {
    if (url.includes("bad")) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    return new Response(
      JSON.stringify([{ name: "main" }, { name: "develop" }, { name: "staging" }]),
    );
  }
  const gh = harnessGitHub(url);
  if (gh) return gh;
  return originalFetch(input, init);
};

// ---------------------------------------------------------------------------
// Sync harness — runs the real <Sync> component against a fake GitHub API and
// a fake Figma plugin, so Pull/Push/Apply can be driven end to end in a browser
// (there's no Figma here). Open /preview.html?page=sync; `?figma=8` sets the
// value of the one Figma variable (GitHub holds 4px, so 8 = a change, 4 = up to
// date). Every message the UI sends is kept on window.__sent.
// ---------------------------------------------------------------------------

const b64 = (text: string) => btoa(text);
const harnessFiles: Record<string, string> = {
  "tokens/metadata.json": JSON.stringify({
    version: "1.0.0",
    themes: ["default"],
    colorSchemes: ["light", "dark"],
    figma: {
      fileKey: "",
      collections: { primitives: ["Primitives"], global: [], themes: [], semantic: [] },
    },
  }),
  "tokens/primitives/dimension.json": JSON.stringify({
    dimension: { "0": { $type: "dimension", $value: "4px" } },
  }),
};

function harnessGitHub(url: string): Response | null {
  const prefix = "https://api.github.com/repos/acme/design-tokens/";
  if (!url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length);
  const json = (data: unknown) => new Response(JSON.stringify(data));
  const params = new URLSearchParams(location.search);
  // ?broken=1 — a token file in GitHub that isn't valid JSON (Pull must refuse, not diff without it).
  // ?truncated=1 — GitHub could only list part of the repo (Pull must refuse).
  const files = { ...harnessFiles };
  if (params.get("broken")) files["tokens/primitives/broken.json"] = "{ not json";
  if (path.startsWith("git/trees/")) {
    return json({
      truncated: params.get("truncated") === "1",
      tree: Object.keys(files).map((p) => ({ type: "blob", path: p, sha: `sha-${p}` })),
    });
  }
  const contents = path.match(/^contents\/(.+?)\?ref=/);
  if (contents && files[contents[1]]) {
    return json({
      content: b64(files[contents[1]]),
      encoding: "base64",
      sha: `sha-${contents[1]}`,
    });
  }
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
}

declare global {
  interface Window {
    __sent?: unknown[];
  }
}

function installFakePlugin() {
  if (window.__sent) return; // once
  window.__sent = [];
  const figmaValue = Number(new URLSearchParams(location.search).get("figma") ?? 8);
  const reply = (pluginMessage: unknown) =>
    setTimeout(() => window.postMessage({ pluginMessage }, "*"), 30);
  window.addEventListener("message", (event) => {
    const msg = event.data?.pluginMessage as { type: string } & Record<string, any>;
    if (!msg) return;
    // The UI posts to `parent`, which is this window — ignore replies we send ourselves.
    const isUIMessage = [
      "GET_COLLECTIONS",
      "APPLY_TOKENS",
      "APPLY_TEXT_STYLES",
      "LOAD_STORAGE",
      "SAVE_STORAGE",
    ].includes(msg.type);
    if (!isUIMessage) return;
    window.__sent!.push(msg);
    if (msg.type === "GET_COLLECTIONS") {
      reply({
        type: "COLLECTIONS_LOADED",
        collections: [
          {
            id: "c1",
            name: "Primitives",
            modes: [{ modeId: "m1", name: "Value" }],
            variableIds: ["v1"],
          },
        ],
        variables: [
          {
            id: "v1",
            name: "dimension/0",
            resolvedType: "FLOAT",
            valuesByMode: { m1: figmaValue },
            collectionId: "c1",
            collectionName: "Primitives",
          },
        ],
        typographyStyles: [],
      });
    } else if (
      msg.type === "APPLY_TOKENS" &&
      new URLSearchParams(location.search).get("applyError")
    ) {
      // A task that threw before it could report — the plugin's queue sends a plain ERROR.
      reply({ type: "ERROR", message: "addMode rejected", context: "APPLY_TOKENS" });
    } else if (msg.type === "APPLY_TOKENS") {
      reply({
        type: "TOKENS_APPLIED",
        count: Object.keys(msg.tokens ?? {}).length,
        removed: msg.removedPaths?.length ?? 0,
        errors: [],
      });
    } else if (msg.type === "LOAD_STORAGE") {
      reply({ type: "STORAGE_LOADED", key: msg.key, value: null });
    }
  });
}

const harnessProject: Project = {
  id: "harness",
  name: "Harness DS",
  pat: "ghp_fake",
  repo: "acme/design-tokens",
  branch: "main",
  tokensPath: "tokens/",
  figmaFileKey: "",
};

function SyncHarness() {
  installFakePlugin();
  return (
    <div style={{ padding: 24, background: "#f0f0f0", minHeight: "100vh" }}>
      <h1 style={{ fontFamily: "sans-serif", fontSize: 16, marginBottom: 20 }}>Sync harness</h1>
      <Frame title="Sync (fake GitHub + fake Figma)">
        <Sync project={harnessProject} onEditProject={() => {}} onDeleteProject={() => {}} />
      </Frame>
    </div>
  );
}

const existingProject: Project = {
  id: "1",
  name: "My Design System",
  pat: "ghp_existingtoken",
  repo: "acme/design-tokens",
  branch: "main",
  tokensPath: "tokens/",
  figmaFileKey: "",
};

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: "monospace", fontSize: 11, color: "#888", marginBottom: 8 }}>
        {title}
      </div>
      <div
        style={{
          width: 480,
          height: 640,
          border: "1px solid #ccc",
          overflow: "auto",
          background: "#fff",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function OnboardingPreview() {
  const [savedLog, setSavedLog] = useState<string[]>([]);
  const onSave = (p: Project) => setSavedLog((log) => [...log, `Saved "${p.name}" → ${p.repo}`]);

  return (
    <div style={{ padding: 24, background: "#f0f0f0", minHeight: "100vh" }}>
      <h1 style={{ fontFamily: "sans-serif", fontSize: 16, marginBottom: 4 }}>
        Onboarding preview
      </h1>
      <p
        style={{
          fontFamily: "sans-serif",
          fontSize: 12,
          color: "#666",
          marginBottom: 20,
          maxWidth: 480,
        }}
      >
        Type a repo containing "bad" (e.g. <code>org/bad-repo</code>) to see the Test Connection
        failure state. Save doesn't persist anywhere — check the log below.
      </p>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Frame title="Add project (first run)">
          <Setup onSave={onSave} />
        </Frame>
        <Frame title="Edit project (existing)">
          <Setup onSave={onSave} onCancel={() => {}} existing={existingProject} />
        </Frame>
      </div>
      {savedLog.length > 0 && (
        <div style={{ marginTop: 20, fontFamily: "monospace", fontSize: 11, color: "#444" }}>
          {savedLog.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const pushDiffs: CollectionDiff[] = [
  {
    collectionName: "Global",
    modeName: "Value",
    counts: { added: 0, changed: 1, removed: 0, total: 1 },
    entries: [
      {
        path: "Typography.banner.textCase",
        type: "typography",
        status: "changed",
        githubValue: "original",
        githubRawValue: "original",
        figmaValue: "title",
        figmaRawValue: "title",
      },
    ],
  },
];

function PushDiffPreview() {
  return (
    <div style={{ padding: 24, background: "#f0f0f0", minHeight: "100vh" }}>
      <h1 style={{ fontFamily: "sans-serif", fontSize: 16, marginBottom: 20 }}>
        Push diff preview
      </h1>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Frame title="Warnings collapsed (default)">
          <PushDiff
            diffs={pushDiffs}
            unrecognizedCollections={["Icons", "Illustrations", "Spacing"]}
            onCreatePR={() => {}}
            onBack={() => {}}
            creating={false}
          />
        </Frame>
        <Frame title="Danger tone (conflict present)">
          <PushDiff
            diffs={pushDiffs}
            unrecognizedCollections={["Icons"]}
            brokenAliasPaths={["color.brand.accent"]}
            conflictPaths={["surface.brand"]}
            onCreatePR={() => {}}
            onBack={() => {}}
            creating={false}
          />
        </Frame>
      </div>
    </div>
  );
}

// Variables that exist in Figma but not in GitHub — Apply would delete them, so
// PullDiff asks for confirmation first. Two modes of one collection share a
// removal, to show it's counted once.
const removedEntry = (path: string) => ({
  path,
  type: "color",
  status: "removed" as const,
  githubValue: null,
  githubRawValue: null,
  figmaValue: "#0142fe",
  figmaRawValue: "#0142fe",
});
const pullDiffsWithRemovals: CollectionDiff[] = [
  {
    collectionName: "Themes",
    modeName: "Alpha",
    counts: { added: 0, changed: 0, removed: 7, total: 7 },
    entries: ["brand.a", "brand.b", "brand.c", "brand.d", "brand.e", "brand.f", "brand.g"].map(
      removedEntry,
    ),
  },
  {
    collectionName: "Themes",
    modeName: "Beta",
    counts: { added: 0, changed: 0, removed: 1, total: 1 },
    entries: [removedEntry("brand.a")],
  },
];

function PullDiffPreview() {
  return (
    <div style={{ padding: 24, background: "#f0f0f0", minHeight: "100vh" }}>
      <h1 style={{ fontFamily: "sans-serif", fontSize: 16, marginBottom: 20 }}>
        Pull diff preview
      </h1>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Frame title="Default">
          <PullDiff
            diffs={pushDiffs}
            onApply={() => {}}
            onCleanApply={() => {}}
            onBack={() => {}}
            applying={false}
          />
        </Frame>
        <Frame title="With pending deletions">
          <PullDiff
            diffs={pullDiffsWithRemovals}
            onApply={() => {}}
            onCleanApply={() => {}}
            onBack={() => {}}
            applying={false}
          />
        </Frame>
      </div>
    </div>
  );
}

function HelpPreview() {
  return (
    <div style={{ padding: 24, background: "#f0f0f0", minHeight: "100vh" }}>
      <h1 style={{ fontFamily: "sans-serif", fontSize: 16, marginBottom: 20 }}>Help preview</h1>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Frame title="About & tips">
          <Help onBack={() => {}} />
        </Frame>
      </div>
    </div>
  );
}

const pages: Record<string, React.ReactNode> = {
  onboarding: <OnboardingPreview />,
  push: <PushDiffPreview />,
  pull: <PullDiffPreview />,
  help: <HelpPreview />,
  sync: <SyncHarness />,
};

function Root() {
  const page = new URLSearchParams(location.search).get("page") ?? "onboarding";
  return pages[page] ?? pages.onboarding;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
