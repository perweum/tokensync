/**
 * First-run setup, walked through step by step instead of one dense form —
 * editing an already-configured project uses the flat form in Setup.tsx
 * instead, where clicking through steps to change one field would be worse
 * than what was there before.
 *
 * Step 2 (Connect GitHub) intentionally can't be skipped past by mistake:
 * Continue is disabled until Test Connection succeeds, unless the user
 * explicitly chooses "Skip for now" — a bad token/repo should be caught
 * here, not on the first real Pull/Push after setup.
 */

import { useState } from "react";
import type { Project } from "../App";
import { fetchBranches } from "../hooks/useGitHub";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import { StatusBanner } from "../components/StatusBanner";
import { ViewHeader } from "../components/ViewHeader";
import { color, font, radius, space } from "../theme";
import { describeGitHubError } from "../errors";
import type { DescribedError } from "../errors";

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

type Step = 1 | 2 | 3;
const STEP_COUNT = 3;

type TestState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; message: string }
  | ({ kind: "error" } & DescribedError);

interface Props {
  onSave: (project: Project) => void;
  onCancel?: () => void;
}

export function AddProjectWizard({ onSave, onCancel }: Props) {
  const [step, setStep] = useState<Step>(1);

  const [name, setName] = useState("");
  const [pat, setPat] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [tokensPath, setTokensPath] = useState("tokens/");
  const [figmaFileKey, setFigmaFileKey] = useState("");

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const [reviewError, setReviewError] = useState("");

  const repoValid = repo.trim().includes("/") && repo.trim().length > 2;

  function resetTestState() {
    if (testState.kind !== "idle") setTestState({ kind: "idle" });
  }

  async function handleTestConnection() {
    setTestState({ kind: "loading" });
    try {
      const branches = await fetchBranches(pat.trim(), repo.trim());
      setTestState({
        kind: "success",
        message: `Connected — found ${branches.length} branch${branches.length !== 1 ? "es" : ""}.`,
      });
    } catch (err) {
      setTestState({ kind: "error", ...describeGitHubError(err, "fetch-branches") });
    }
  }

  function handleSave() {
    setReviewError("");
    if (!name.trim()) return setReviewError("Project name is required");
    if (!pat.trim()) return setReviewError("GitHub Personal Access Token is required");
    if (!repoValid) return setReviewError("Repository must be in format org/repo-name");

    onSave({
      id: generateId(),
      name: name.trim(),
      pat: pat.trim(),
      repo: repo.trim(),
      branch: branch.trim() || "main",
      tokensPath: tokensPath.trim() || "tokens/",
      figmaFileKey: figmaFileKey.trim(),
    });
  }

  const back = step === 1 ? onCancel : () => setStep((step - 1) as Step);

  return (
    <div style={s.container}>
      <ViewHeader title="Add project" onBack={back} />
      <StepIndicator step={step} />

      {step === 1 && (
        <div style={s.stepBody}>
          <p style={s.stepIntro}>Give this project a name — only used inside the plugin.</p>
          <Field label="Project name">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Design System"
              autoFocus
            />
          </Field>
          <Button variant="primary" fullWidth disabled={!name.trim()} onClick={() => setStep(2)}>
            Continue
          </Button>
        </div>
      )}

      {step === 2 && (
        <div style={s.stepBody}>
          <p style={s.stepIntro}>Connect the GitHub repository that holds your token files.</p>
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
              autoFocus
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

          <div style={s.testRow}>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={!pat.trim() || !repoValid || testState.kind === "loading"}
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

          <div style={s.stepFooter}>
            <Button
              variant="primary"
              fullWidth
              disabled={testState.kind !== "success"}
              onClick={() => setStep(3)}
            >
              Continue
            </Button>
            {testState.kind !== "success" && (
              <Button
                type="button"
                variant="ghost"
                disabled={!pat.trim() || !repoValid}
                onClick={() => setStep(3)}
              >
                Skip test and continue
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={s.stepBody}>
          <p style={s.stepIntro}>Confirm the defaults, or adjust them if this repo needs it.</p>

          <div style={s.summary}>
            <SummaryRow label="Name" value={name} />
            <SummaryRow label="Repository" value={repo} />
          </div>

          <Field label="Default branch">
            <TextInput
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </Field>
          <Field label="Tokens path" hint="Folder inside the repo containing the tokens/ structure">
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

          {reviewError && <StatusBanner tone="danger">{reviewError}</StatusBanner>}

          <Button variant="primary" fullWidth onClick={handleSave}>
            Save project
          </Button>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  return (
    <div style={s.steps}>
      {Array.from({ length: STEP_COUNT }, (_, i) => i + 1).map((n) => (
        <span
          key={n}
          style={{
            ...s.stepDash,
            background: n <= step ? color.accent.default : color.border.default,
          }}
        />
      ))}
      <span style={s.stepLabel}>
        Step {step} of {STEP_COUNT}
      </span>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.summaryRow}>
      <span style={s.summaryLabel}>{label}</span>
      <span style={s.summaryValue}>{value}</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { padding: space.xxl, display: "flex", flexDirection: "column", gap: space.md },
  steps: { display: "flex", alignItems: "center", gap: space.xs },
  stepDash: { width: 24, height: 4, borderRadius: 2, flexShrink: 0 },
  stepLabel: { fontSize: font.size.sm, color: color.text.muted, marginLeft: space.xs },
  stepBody: { display: "flex", flexDirection: "column", gap: space.lg },
  stepIntro: { margin: 0, fontSize: font.size.md, color: color.text.secondary, lineHeight: 1.5 },
  stepFooter: { display: "flex", flexDirection: "column", alignItems: "center", gap: space.sm },
  testRow: { display: "flex", marginTop: -space.sm },
  summary: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    padding: space.md,
    background: color.surface.subtle,
    borderRadius: radius.md,
    border: `1px solid ${color.border.subtle}`,
  },
  summaryRow: { display: "flex", justifyContent: "space-between", gap: space.sm },
  summaryLabel: { fontSize: font.size.sm, color: color.text.muted },
  summaryValue: {
    fontSize: font.size.sm,
    color: color.text.primary,
    fontFamily: font.mono,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};
