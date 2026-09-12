/**
 * First-run setup, walked through step by step instead of one dense form —
 * editing an already-configured project uses the flat form in Setup.tsx
 * instead, where clicking through steps to change one field would be worse
 * than what was there before.
 *
 * Bookended by a Welcome step (what Token Spark does, before asking for
 * anything) and a Tips step (best practices, right before the actual save)
 * — the 1/2/3 step count and its indicator only cover the settings in
 * between, since those two are framing, not something to fill in. Welcome's
 * "Skip intro" hands off to Setup.tsx's flat ProjectForm instead — for
 * anyone who already knows what they're doing and would rather fill in one
 * screen than click through steps.
 *
 * Step 2 (Connect GitHub) is optional — Continue is disabled until Test
 * Connection succeeds so a bad token/repo is caught here rather than on
 * the first real Pull/Push, but "Skip for now" lets you finish setup with
 * no GitHub connection at all, to add one later from Settings. Sync.tsx
 * shows a distinct "not connected" state for that project until you do.
 */

import { useState } from "react";
import type { Project } from "../App";
import { fetchBranches } from "../hooks/useGitHub";
import { generateId } from "./Setup";
import { AboutTokenSpark, BestPracticesTips } from "./Help";
import { NameArt, ConnectArt, DefaultsArt } from "../onboardingArt";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Field";
import { StatusBanner } from "../components/StatusBanner";
import { ViewHeader } from "../components/ViewHeader";
import { color, font, radius, space } from "../theme";
import { describeGitHubError } from "../errors";
import type { DescribedError } from "../errors";

type Step = 0 | 1 | 2 | 3 | 4;
const STEP_COUNT = 3;

type TestState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; message: string }
  | ({ kind: "error" } & DescribedError);

interface Props {
  onSave: (project: Project) => void;
  onCancel?: () => void;
  /** Welcome step's "Skip intro" — hands off to Setup.tsx's flat form instead
   * of walking through the remaining steps. */
  onSkipToFlatForm: () => void;
}

export function AddProjectWizard({ onSave, onCancel, onSkipToFlatForm }: Props) {
  const [step, setStep] = useState<Step>(0);

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
    // GitHub connection is optional — a project can be saved without one
    // and connected later from Settings (see Sync.tsx's "not connected"
    // state). Only validate the format of what was actually typed.
    if (repo.trim() && !repoValid)
      return setReviewError("Repository must be in format org/repo-name");

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

  const back = step === 0 ? onCancel : () => setStep((step - 1) as Step);

  return (
    <div style={s.container}>
      <ViewHeader title="Add project" onBack={back} />
      {step >= 1 && step <= 3 && <StepIndicator step={step as 1 | 2 | 3} />}

      {step === 0 && (
        <div style={s.stepBody}>
          <AboutTokenSpark />
          <div style={s.stepFooter}>
            <Button variant="primary" fullWidth onClick={() => setStep(1)}>
              Get started
            </Button>
            <Button type="button" variant="ghost" onClick={onSkipToFlatForm}>
              Skip intro
            </Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div style={s.stepBody}>
          <NameArt style={s.stepArt} />
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
          <ConnectArt style={s.stepArt} />
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
                disabled={testState.kind === "loading"}
                onClick={() => setStep(3)}
              >
                Skip for now
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={s.stepBody}>
          <DefaultsArt style={s.stepArt} />
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

          <Button variant="primary" fullWidth onClick={() => setStep(4)}>
            Continue
          </Button>
        </div>
      )}

      {step === 4 && (
        <div style={s.stepBody}>
          <BestPracticesTips />

          {reviewError && <StatusBanner tone="danger">{reviewError}</StatusBanner>}

          <Button variant="primary" fullWidth onClick={handleSave}>
            Finish setup
          </Button>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
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
  stepArt: { alignSelf: "center" },
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
