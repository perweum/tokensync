/**
 * "About & tips" — reopens the informational half of onboarding (what the
 * plugin does, best practices) without re-running project setup. Reached
 * from the small `?` button in Sync's header; also the same two blocks
 * AddProjectWizard shows on its Welcome/Tips steps, kept here as the one
 * place their copy lives so the wizard and this view can't drift apart.
 */
import { ViewHeader } from "../components/ViewHeader";
import { WelcomeArt, TipsArt } from "../onboardingArt";
import { color, font, space } from "../theme";

export function Help({ onBack }: { onBack: () => void }) {
  return (
    <div style={s.container}>
      <ViewHeader title="About & tips" onBack={onBack} />
      <div style={s.body}>
        <AboutTokenSpark />
        <BestPracticesTips />
      </div>
    </div>
  );
}

export function AboutTokenSpark() {
  return (
    <div style={s.block}>
      <WelcomeArt style={s.art} />
      <p style={s.lead}>
        Token Spark keeps design tokens in sync between this Figma file and a GitHub repository — no
        manual copying, no drift between what designers see and what code ships.
      </p>
      <ul style={s.list}>
        <TipRow>
          <strong>Pull</strong> brings token changes from GitHub into Figma Variables.
        </TipRow>
        <TipRow>
          <strong>Push</strong> opens a GitHub Pull Request with whatever changed in Figma.
        </TipRow>
        <TipRow>
          <strong>Map Collections</strong> tells Token Spark which Figma collections are primitives,
          themes, or one-off values, so only the right ones export.
        </TipRow>
      </ul>
    </div>
  );
}

export function BestPracticesTips() {
  return (
    <div style={s.block}>
      <TipsArt style={s.art} />
      <p style={s.heading}>Best practices</p>
      <ul style={s.list}>
        <TipRow>
          Every push opens a Pull Request — nothing reaches your repo's main branch until it's
          reviewed and merged, same as any other change.
        </TipRow>
        <TipRow>
          Renamed a mode or collection in Figma? Reopen <strong>Map Collections</strong> and save
          again so Token Spark picks up the new name before your next sync.
        </TipRow>
        <TipRow>
          Token Spark opens the PR; a human still reviews it. Treat the diff like any other code
          change before merging.
        </TipRow>
      </ul>
    </div>
  );
}

function TipRow({ children }: { children: React.ReactNode }) {
  return (
    <li style={s.item}>
      <span style={s.dot} />
      <span>{children}</span>
    </li>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: `${space.md}px ${space.xxl}px ${space.xxl}px`,
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  block: { display: "flex", flexDirection: "column", alignItems: "center", gap: space.sm },
  art: { flexShrink: 0 },
  lead: {
    margin: 0,
    textAlign: "center",
    fontSize: font.size.md,
    color: color.text.secondary,
    lineHeight: 1.5,
  },
  heading: {
    margin: 0,
    alignSelf: "flex-start",
    fontWeight: 600,
    fontSize: font.size.lg,
    color: color.text.primary,
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: space.sm + 2,
    width: "100%",
  },
  item: {
    display: "flex",
    gap: space.sm,
    fontSize: font.size.md,
    color: color.text.secondary,
    lineHeight: 1.5,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: color.accent.default,
    flexShrink: 0,
    marginTop: 7,
  },
};
