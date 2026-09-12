/**
 * "About & tips" — reopens the informational half of onboarding (what the
 * plugin does, best practices) without re-running project setup. Reached
 * from the small `?` button in Sync's header; also the same two blocks
 * AddProjectWizard shows on its Welcome/Tips steps, kept here as the one
 * place their copy lives so the wizard and this view can't drift apart.
 *
 * Left-aligned throughout, matching every other view (Setup, AddProjectWizard's
 * own step text) — only the small art next to each heading is a fixed-size
 * decorative element, the same convention AddProjectWizard's Name/Connect/
 * Defaults steps already use for their own illustrations.
 */
import { ViewHeader } from "../components/ViewHeader";
import { WelcomeArt, TipsArt } from "../onboardingArt";
import { color, font, space } from "../theme";

export function Help({ onBack }: { onBack: () => void }) {
  return (
    <div style={s.container}>
      <div style={s.header}>
        <ViewHeader title="About & tips" onBack={onBack} />
      </div>
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
      <div style={s.blockHeading}>
        <WelcomeArt style={s.art} />
        <h3 style={s.heading}>What Token Spark does</h3>
      </div>
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
      <div style={s.blockHeading}>
        <TipsArt style={s.art} />
        <h3 style={s.heading}>Best practices</h3>
      </div>
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
  header: {
    padding: `${space.md}px ${space.lg}px`,
    borderBottom: `1px solid ${color.border.subtle}`,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: `${space.lg}px ${space.lg}px ${space.xxl}px`,
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  block: { display: "flex", flexDirection: "column", gap: space.sm },
  blockHeading: { display: "flex", alignItems: "center", gap: space.sm },
  art: { width: 32, height: 19, flexShrink: 0 },
  heading: { margin: 0, fontWeight: 600, fontSize: font.size.lg, color: color.text.primary },
  lead: { margin: 0, fontSize: font.size.md, color: color.text.secondary, lineHeight: 1.5 },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: space.sm + 2,
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
