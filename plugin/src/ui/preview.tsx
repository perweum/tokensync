/**
 * Local dev preview — a persistent tool, not shipped code. vite.config's
 * build.rollupOptions.input is "index.html" only, so this file and
 * preview.html at the repo root never end up in the actual plugin bundle;
 * they only exist for `npm run dev`.
 *
 * Run `npm run dev` from plugin/, then open http://localhost:5173/preview.html
 * to click through views in a real browser without Figma or a real GitHub
 * token. Currently covers onboarding (Setup, both Add and Edit); extend the
 * `pages` map below if you want to preview other views the same way.
 *
 * Mocks window.fetch for GitHub's branches endpoint: type a repo containing
 * "bad" (e.g. "org/bad-repo") to see the Test Connection failure state.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Setup } from "./views/Setup";
import type { Project } from "./App";

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
  return originalFetch(input, init);
};

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

const pages: Record<string, React.ReactNode> = {
  onboarding: <OnboardingPreview />,
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
