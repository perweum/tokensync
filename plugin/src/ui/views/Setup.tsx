/**
 * Setup view — shown when no project is configured, or when editing one.
 * A brand-new project goes through the step-by-step AddProjectWizard
 * instead — see that file. This file only handles editing an existing
 * project, where a single flat screen is faster than clicking through
 * steps to change one field.
 */

import { useState } from "react";
import type { Project } from "../App";
import { fetchBranches } from "../hooks/useGitHub";
import { AddProjectWizard } from "./AddProjectWizard";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import { StatusBanner } from "../components/StatusBanner";
import { ViewHeader } from "../components/ViewHeader";
import { IconChevron } from "../icons";
import { color, font, space } from "../theme";
import { describeGitHubError } from "../errors";
import type { DescribedError } from "../errors";

interface Props {
  onSave: (project: Project) => void;
  onCancel?: () => void;
  existing?: Project | null;
}

export function Setup({ onSave, onCancel, existing }: Props) {
  if (!existing) {
    return <AddProjectWizard onSave={onSave} onCancel={onCancel} />;
  }
  return <EditProjectForm project={existing} onSave={onSave} onCancel={onCancel} />;
}

// ---------------------------------------------------------------------------
// Edit — single flat screen; every field is already set, so there's nothing
// to walk through step by step.
// ---------------------------------------------------------------------------

type TestState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; message: string }
  | ({ kind: "error" } & DescribedError);

function EditProjectForm({
  project,
  onSave,
  onCancel,
}: {
  project: Project;
  onSave: (project: Project) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [pat, setPat] = useState(project.pat);
  const [repo, setRepo] = useState(project.repo);
  const [branch, setBranch] = useState(project.branch);
  const [tokensPath, setTokensPath] = useState(project.tokensPath);
  const [figmaFileKey, setFigmaFileKey] = useState(project.figmaFileKey);
  const [error, setError] = useState("");

  const [showAdvanced, setShowAdvanced] = useState(true);
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });

  function resetTestState() {
    if (testState.kind !== "idle") setTestState({ kind: "idle" });
  }

  async function handleTestConnection() {
    if (!pat.trim() || !repo.trim() || !repo.includes("/")) {
      setTestState({
        kind: "error",
        message: "Enter a personal access token and a repository (org/repo-name) first.",
      });
      return;
    }
    setTestState({ kind: "loading" });
    try {
      const branches = await fetchBranches(pat.trim(), repo.trim());
      const branchName = branch.trim();
      const branchMissing = branchName && !branches.includes(branchName);
      setTestState({
        kind: "success",
        message: branchMissing
          ? `Connected, but branch "${branchName}" wasn't found in this repo.`
          : `Connected — found ${branches.length} branch${branches.length !== 1 ? "es" : ""}.`,
      });
    } catch (err) {
      setTestState({ kind: "error", ...describeGitHubError(err, "fetch-branches") });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!name.trim()) return setError("Project name is required");
    if (!pat.trim()) return setError("GitHub Personal Access Token is required");
    if (!repo.trim() || !repo.includes("/"))
      return setError("Repository must be in format org/repo-name");

    onSave({
      id: project.id,
      name: name.trim(),
      pat: pat.trim(),
      repo: repo.trim(),
      branch: branch.trim() || "main",
      tokensPath: tokensPath.trim() || "tokens/",
      figmaFileKey: figmaFileKey.trim(),
    });
  }

  return (
    <div style={styles.container}>
      <ViewHeader title="Edit project" onBack={onCancel} />
      <p style={styles.subtext}>
        Connect a GitHub repository to this Figma file. Token files will be read from and written to
        the repository via Pull Request.
      </p>

      <form onSubmit={handleSubmit} style={styles.form}>
        <Field label="Project name" hint="Used only in this plugin">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Design System"
          />
        </Field>

        <Field
          label="GitHub Personal Access Token"
          hint="Needs repo read + write permissions. Stored in Figma clientStorage."
        >
          <TextInput
            type="password"
            value={pat}
            onChange={(e) => {
              setPat(e.target.value);
              resetTestState();
            }}
            placeholder="ghp_xxxxxxxxxxxx"
          />
        </Field>

        <Field label="Repository" hint="org/repo-name">
          <TextInput
            value={repo}
            onChange={(e) => {
              setRepo(e.target.value);
              resetTestState();
            }}
            placeholder="your-org/design-tokens"
          />
        </Field>

        <div style={styles.testRow}>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={testState.kind === "loading"}
            onClick={handleTestConnection}
          >
            {testState.kind === "loading" ? "Testing…" : "Test connection"}
          </Button>
        </div>

        {testState.kind === "success" && (
          <StatusBanner tone="success">{testState.message}</StatusBanner>
        )}
        {testState.kind === "error" && (
          <StatusBanner tone="danger" detail={testState.detail}>
            {testState.message}
          </StatusBanner>
        )}

        <Button
          type="button"
          variant="ghost"
          icon={<IconChevron expanded={showAdvanced} size={10} />}
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          style={styles.advancedToggle}
        >
          Advanced settings
        </Button>

        {showAdvanced && (
          <div style={styles.advancedFields}>
            <Field label="Default branch">
              <TextInput
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  resetTestState();
                }}
                placeholder="main"
              />
            </Field>

            <Field
              label="Tokens path"
              hint="Folder inside the repo containing the tokens/ structure"
            >
              <TextInput
                value={tokensPath}
                onChange={(e) => setTokensPath(e.target.value)}
                placeholder="tokens/"
              />
            </Field>

            <Field
              label="Figma file key"
              hint="Optional, reserved for a future feature. Found in the URL: figma.com/design/FILE_KEY/..."
            >
              <TextInput
                value={figmaFileKey}
                onChange={(e) => setFigmaFileKey(e.target.value)}
                placeholder="abc123xyz"
              />
            </Field>
          </div>
        )}

        {error && <StatusBanner tone="danger">{error}</StatusBanner>}

        <Button type="submit" variant="primary" fullWidth>
          Save project
        </Button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: space.xxl, display: "flex", flexDirection: "column", gap: space.sm },
  subtext: { margin: 0, fontSize: font.size.md, color: color.text.secondary, lineHeight: 1.5 },
  form: { display: "flex", flexDirection: "column", gap: space.lg, marginTop: space.xs },
  testRow: { display: "flex", marginTop: -space.xs },
  advancedToggle: { alignSelf: "flex-start", marginLeft: -space.sm },
  advancedFields: { display: "flex", flexDirection: "column", gap: space.lg },
};
