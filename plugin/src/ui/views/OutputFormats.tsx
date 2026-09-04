/**
 * Output formats view.
 *
 * Lets the user choose which code transformers run on push (CSS/JS/TS/Dart/
 * Swift), instead of hand-editing `platforms.*.enabled` in metadata.json.
 * A repo with everything off still gets the token JSON — the transformers
 * are a convenience for teams without their own build step; a team with an
 * existing pipeline (Style Dictionary, e.g.) can point it at `tokens/`
 * directly and leave every platform here off. See
 * docs/design/transformer-configurability.md.
 */

import { useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { fetchTokenFiles, createTokenPR, type PRResult } from "../hooks/useGitHub";
import { parseRepository } from "../../shared/token-merger";
import type { Platforms, PlatformConfig } from "../../shared/token-merger";
import { Button } from "../components/Button";
import { StatusBanner } from "../components/StatusBanner";
import { ViewHeader } from "../components/ViewHeader";
import { color, font, radius, space } from "../theme";
import { describeGitHubError } from "../errors";
import type { DescribedError } from "../errors";

type PlatformKey = keyof Platforms;

const PLATFORMS: Array<{ key: PlatformKey; label: string; hint: string; defaultOutput: string }> = [
  { key: "css", label: "CSS", hint: "Custom properties with theme/scheme/size selectors", defaultOutput: "dist/tokens.css" },
  { key: "js", label: "JavaScript", hint: "Plain ES module token constants", defaultOutput: "dist/tokens.js" },
  { key: "ts", label: "TypeScript", hint: "Same as JS, with `as const` and type exports", defaultOutput: "dist/tokens.ts" },
  { key: "dart", label: "Dart", hint: "Flutter-ready token classes", defaultOutput: "lib/src/design_tokens.dart" },
  { key: "swift", label: "Swift", hint: "iOS-ready token structs", defaultOutput: "ios/DesignTokens.swift" },
];

interface Props {
  project: Project;
  activeBranch: string;
  onBack: () => void;
  onSaved: (result: PRResult) => void;
}

export function OutputFormats({ project, activeBranch, onBack, onSaved }: Props) {
  const [rawMetadata, setRawMetadata] = useState<Record<string, unknown> | null>(null);
  const [platforms, setPlatforms] = useState<Platforms>({});
  const [error, setError] = useState<DescribedError | null>(null);
  const [saving, setSaving] = useState(false);

  const requested = useRef(false);

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
        setRawMetadata(metadata as unknown as Record<string, unknown>);
        setPlatforms(metadata.platforms ?? {});
      })
      .catch((err) => setError(describeGitHubError(err, "fetch-tokens")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(key: PlatformKey, enabled: boolean) {
    setPlatforms((prev) => ({ ...prev, [key]: { ...prev[key], enabled } }));
  }

  async function handleSave() {
    if (!rawMetadata) return;
    setSaving(true);
    setError(null);

    const nextMetadata = { ...rawMetadata, platforms };

    try {
      const result = await createTokenPR(
        { pat: project.pat, repo: project.repo, branch: activeBranch, tokensPath: project.tokensPath },
        [
          {
            path: joinTokensPath(project.tokensPath, "metadata.json"),
            content: JSON.stringify(nextMetadata, null, 2),
          },
        ],
        "chore: update output format config",
      );
      onSaved(result);
    } catch (err) {
      setError(describeGitHubError(err, "create-pr"));
      setSaving(false);
    }
  }

  const ready = rawMetadata !== null;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <ViewHeader title="Output formats" onBack={onBack} />
      </div>

      <p style={s.subtext}>
        Choose which code files get generated on push, alongside the token JSON. Already have a
        build step (Style Dictionary, e.g.)? Leave everything off and point it at the repo's{" "}
        <code>tokens/</code> folder directly — Token Sync's token JSON is plain DTCG, readable by
        any tool that speaks it.
      </p>

      {error && (
        <div style={{ margin: `0 ${space.lg}px` }}>
          <StatusBanner tone="danger" detail={error.detail}>
            {error.message}
          </StatusBanner>
        </div>
      )}

      {!ready ? (
        <div style={s.loading}>Loading configuration…</div>
      ) : (
        <>
          <div style={s.list}>
            {PLATFORMS.map((p) => {
              const cfg: PlatformConfig | undefined = platforms[p.key];
              const enabled = cfg?.enabled ?? false;
              return (
                <label key={p.key} style={s.row}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => toggle(p.key, e.target.checked)}
                  />
                  <div style={s.rowInfo}>
                    <div style={s.rowName}>{p.label}</div>
                    <div style={s.rowHint}>{p.hint}</div>
                    <div style={s.rowPath}>{cfg?.output || p.defaultOutput}</div>
                  </div>
                </label>
              );
            })}
          </div>

          <div style={s.footer}>
            <Button variant="primary" fullWidth disabled={saving} onClick={handleSave}>
              {saving ? "Saving…" : "Save output formats (opens a PR)"}
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
    gap: space.sm,
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    padding: `${space.sm}px ${space.sm + 2}px`,
    borderRadius: radius.sm,
    border: `1px solid ${color.border.subtle}`,
    cursor: "pointer",
  },
  rowInfo: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  rowName: { fontWeight: 500, fontSize: font.size.md, color: color.text.primary },
  rowHint: { fontSize: font.size.sm, color: color.text.secondary },
  rowPath: { fontSize: font.size.xs, color: color.text.muted, fontFamily: "monospace" },
  footer: {
    padding: `${space.md}px ${space.lg}px`,
    borderTop: `1px solid ${color.border.subtle}`,
  },
};
