# Token Spark — Onboarding Wizard (current copy & steps)

This is the actual text and flow of the plugin's first-run "Add project"
wizard today, pulled directly from
[`plugin/src/ui/views/AddProjectWizard.tsx`](../plugin/src/ui/views/AddProjectWizard.tsx)
and [`plugin/src/ui/views/Help.tsx`](../plugin/src/ui/views/Help.tsx) — not
invented copy. Each step already has a small flat SVG illustration in
[`plugin/src/ui/onboardingArt.tsx`](../plugin/src/ui/onboardingArt.tsx); its
description is included per step so you can see what exists today before
replacing or extending it.

The wizard is 5 screens internally (steps 0–4), but the on-screen step
indicator ("Step N of 3") only counts steps 1–3 — step 0 (Welcome) and step 4
(Tips) are framing, not fields to fill in.

The same two text blocks (Welcome's intro, the closing tips) are reused
verbatim in the plugin's "About & tips" screen (reached from the `?` button
in Sync's header), so they only exist in one place in the copy.

---

## Step 0 — Welcome (no step indicator)

**Current illustration:** a Figma-canvas shape and a repo/code shape (`</>`),
joined by a dashed arc — "the plugin's whole job in one picture."

**Heading:** What Token Spark does

**Body:**
> Token Spark keeps design tokens in sync between this Figma file and a
> GitHub repository — no manual copying, no drift between what designers see
> and what code ships.

**Bullets:**
- **Pull** brings token changes from GitHub into Figma Variables.
- **Push** opens a GitHub Pull Request with whatever changed in Figma.
- **Map Collections** tells Token Spark which Figma collections are
  primitives, themes, or one-off values, so only the right ones export.

**Buttons:**
- `Get started` (primary) → Step 1
- `Skip intro` (ghost) → jumps straight to the flat one-screen project form
  (Setup.tsx) instead of walking through steps 1–3

---

## Step 1 — Name ("Step 1 of 3")

**Current illustration:** a plain label/tag shape.

**Intro text:**
> Give this project a name — only used inside the plugin.

**Field:**
- Label: `Project name`
- Placeholder: `My Design System`

**Button:** `Continue` (primary, disabled until a name is entered) → Step 2

Back button (header) returns to Step 0.

---

## Step 2 — Connect GitHub ("Step 2 of 3")

**Current illustration:** a padlock over a repo shape — "prove you have
access."

**Intro text:**
> Connect the GitHub repository that holds your token files.

**Fields:**
- Label: `GitHub Personal Access Token`
  Hint: *Needs repo read + write permissions. Stored in Figma clientStorage.*
  Placeholder: `ghp_xxxxxxxxxxxx` (masked input)
- Label: `Repository`
  Hint: *org/repo-name*
  Placeholder: `your-org/design-tokens`

**Action:** `Test connection` button (disabled until both fields look valid)
- While checking: button label becomes `Testing…`
- On success: green banner — *"Connected — found N branch(es)."*
- On failure: red banner with the described GitHub error

**Buttons:**
- `Continue` (primary, disabled until the test succeeds) → Step 3
- `Skip for now` (ghost, shown until the test succeeds) → Step 3 with no
  GitHub connection; the project shows a "not connected" state in Sync until
  one is added later from Settings

This step is optional — connecting isn't required to finish setup.

---

## Step 3 — Defaults ("Step 3 of 3")

**Current illustration:** a short settings list (rows with toggles) —
standing in for the three fields below.

**Intro text:**
> Confirm the defaults, or adjust them if this repo needs it.

**Summary shown above the fields** (read-only, from steps 1–2):
- Name: *(what was typed in Step 1)*
- Repository: *(what was typed in Step 2)*

**Fields:**
- Label: `Default branch` — Placeholder: `main`
- Label: `Tokens path`
  Hint: *Folder inside the repo containing the tokens/ structure*
  Placeholder: `tokens/`
- Label: `Figma file key`
  Hint: *Optional, reserved for a future feature. Found in the URL:
  figma.com/design/FILE_KEY/...*
  Placeholder: `abc123xyz`

**Button:** `Continue` (primary) → Step 4

---

## Step 4 — Tips (no step indicator)

**Current illustration:** the plugin's checkmark glyph, enlarged, inside a
soft ring — "you're set."

**Heading:** Best practices

**Bullets:**
- Every push opens a Pull Request — nothing reaches your repo's main branch
  until it's reviewed and merged, same as any other change.
- Renamed a mode or collection in Figma? Reopen **Map Collections** and save
  again so Token Spark picks up the new name before your next sync.
- Token Spark opens the PR; a human still reviews it. Treat the diff like
  any other code change before merging.

(If saving fails — e.g. project name left empty, or a malformed
`org/repo-name` — a red error banner appears above the button with the
specific problem.)

**Button:** `Finish setup` (primary) → saves the project and returns to Sync

---

## Notes for illustration work

- All five illustrations share one fixed 160×96 canvas so they drop into the
  same slot on every step without per-step layout changes — worth keeping
  that constraint if you're replacing rather than just restyling them.
- They're built as flat shapes from the plugin's own theme colors
  (`color.surface.subtle`, `color.border.default`, `color.accent.default`),
  deliberately not in the blurred/gradient style of the plugin's favicon —
  that's treated as a one-off brand mark, not a pattern to extend across
  these five.
- Back-button behavior: Step 0's back exits the wizard entirely (`onCancel`);
  every other step's back returns to the previous step.
