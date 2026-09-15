# AI-assisted Figma sync — idea, not scoped

Status: **idea raised by the user (September 2026), written up for
consideration.** No design accepted, nothing built. The point of this
document is to separate what's actually buildable today from what depends on
a platform capability this project doesn't control.

---

## 1. The idea, in the framing it was raised with

A tool that lets an AI agent sync more easily with Figma Variables and
Styles — not "run the existing sync on a timer," but "let an AI operate the
sync loop itself," inside a controlled environment with strict rules. If this
is a genuinely new tool rather than a feature bolted onto the existing
plugin, it should be scoped as its own idea: is it an MCP server, what APIs
would it need, and what are the real limitations.

## 2. The hard constraint underneath everything here

Token Spark exists as a Figma *plugin*, not a browser app or a server, for
one specific, already-documented reason (README — "Why a Figma plugin and
not a browser app?"): the Figma Variables **REST** API requires an
Enterprise/Organization plan for write access; the **Plugin** API has full
read/write on every plan, but only executes inside Figma's own sandbox while
a human has the file open in the desktop or web app.

That single fact splits this idea in two:

- The Plugin API is **not a network-callable surface at all** — it can't be
  invoked by an external process, an MCP server, or an AI agent under any
  circumstances, regardless of plan. There is no headless path through it.
- The REST API **is** callable headlessly, but only for a team on an
  Enterprise/Organization plan — and this is already filed in DECISIONS.md's
  "Later / on demand" list as "Enterprise REST provider — for true headless
  two-way sync," unbuilt.

Everything below is organized around this line, because it produces two
genuinely different tools, not one feature with a config flag.

## 3. Two integration surfaces

### (A) GitHub-side only — buildable today, any Figma plan, smaller scope

An MCP server (or a well-briefed general-purpose coding agent, which already
covers a lot of this) that operates purely on the repo: reading
`tokens/**/*.json` and `metadata.json`, making an edit — a rename, a new
theme file, a primitive value change — validating it, and opening a PR. It
never touches Figma. A human still runs the plugin's Pull/Apply to bring the
change into Figma, exactly as if a person had hand-edited the files.

This is realistic specifically because `plugin/src/shared/` is already pure
TypeScript with zero Figma or browser dependency — the same adapter-boundary
property `docs/design/canonical-model.md` §2 identified for a different
reason (swapping *input* formats) applies just as well to *who* is driving
the edit. The validation an agent needs — does this tree still resolve, does
a rename touch all three affected places — is logic `token-merger.ts`
already has; it needs exposing, not rebuilding.

**Real limitation:** this only closes half the loop. Nothing here confirms
the eventual Figma-side apply actually succeeds — that still needs a human in
Figma clicking Apply, and can still fail for reasons the agent has zero
visibility into (an unloaded font, a renamed collection — both real logged
incidents in DECISIONS.md §1).

### (B) Full headless Figma REST integration — Enterprise plan only, large scope

A genuinely new sync engine — not the existing plugin — talking to Figma's
Variables REST API instead of the Plugin API, reusing the same
`plugin/src/shared/` diff/parse/transform logic behind a new adapter (REST
calls in place of `figma.variables.*`). This is the only way an AI agent (or
a scheduled job) could pull/push/apply without a human ever opening Figma.

This is a substantially bigger project than (A): a new auth model (Figma
OAuth or a REST-scoped token, distinct from the plugin's own PAT-based GitHub
auth), a new test story (the plugin's existing suite exercises Plugin-API
code paths, not a REST equivalent), and it only matters at all for a team
already on Enterprise/Organization. Worth building only if a real customer on
that tier needs it — not speculatively.

## 4. What "strict rules" should mean — reuse this project's own principles, don't invent new ones

Whichever surface gets built, an AI agent should operate under the *same*
invariants a human already does here — arguably enforced more strictly,
since an agent is more likely to attempt something destructive without
intending to:

- **Always a PR, never a direct commit** — identical to the plugin's own
  stance (README — "Why always PR and not direct push?"). An AI-authored
  change gets the same mandatory human review gate as anything else, no
  exception for the agent.
- **Merge, never a destructive rebuild** — an agent must never get the
  equivalent of `handleCleanApplyAll`'s wholesale delete-and-rebuild, already
  flagged internally as unsafe on any repo with file-only composite tokens
  (`canonical-model.md` §5.3).
- **Dry-run diff before any write, always** — the same diff a human would see
  in `PushDiff`/`PullDiff`, surfaced before anything commits, with an
  explicit confirm step rather than open-ended write access.
- **Schema validation gate** — every proposed change runs through the same
  structural checks `parseRepository`/`token-merger.ts` already enforce;
  reject before a PR exists, not after.
- **A narrow, enumerable tool surface** — expose actions that mirror the
  plugin's own (`get diff`, `open PR`, `validate`), not raw file-write or raw
  Figma-API access — so a bad agent decision's blast radius is bounded by
  what the tool even allows, not by hoping the model behaves.

## 5. A concrete MCP tool sketch (surface (A) only — the one buildable today)

- `tokenspark_get_status(project)` → metadata, last sync time, ignored
  collections
- `tokenspark_get_diff(project)` → the same diff shape `PushDiff`/`PullDiff`
  compute today, scoped to local-edit-vs-repo (there's no live Figma diff
  available outside the plugin sandbox)
- `tokenspark_validate(project)` → runs `parseRepository`'s structural checks
  against the current tree, returns pass/fail with specific errors
- `tokenspark_propose_change(project, description)` → the agent's edit,
  applied to a working copy only, always followed by a forced `validate` +
  `get_diff`
- `tokenspark_open_pr(project, diff_id)` → callable only against a diff that
  already passed validation; opens a PR, never writes to the configured
  branch directly

Deliberately no tool here touches Figma at all — none is possible without
the Enterprise REST path in §3(B).

## 6. Limitations, stated plainly

- **No non-Enterprise path to "AI drives Figma directly."** This is a
  platform ceiling, not a design choice Token Spark could engineer around.
- **Surface (A) never verifies the Figma-side apply actually worked.** An
  agent can open a well-validated, human-reviewed PR and the eventual
  Apply-to-Figma step can still fail for reasons outside the loop entirely.
  Not a fully closed system.
- **Reusing `plugin/src/shared/` outside the plugin needs the
  `@tokenspark/core` extraction**, already a separate, not-yet-built backlog
  item (DECISIONS.md Priority 1). This idea and that extraction are naturally
  sequenced together, not independent efforts.
- **An AI agent with repo write access is a new trust surface**, even scoped
  to PR-only — a confused agent opening many plausible-looking bad PRs is a
  different failure mode than an occasional human mistake, and needs its own
  answer (rate limits? mandatory second reviewer?) before reaching a real
  team, not just before reaching production code.

## 7. Recommendation

- Treat (A) and (B) as two separate ideas with very different cost/benefit,
  not one continuum with a toggle. (A) is buildable soon and composes
  naturally with the already-planned `@tokenspark/core` extraction — start
  there if this is pursued at all.
- Leave (B) filed exactly where it already sits in DECISIONS.md's
  Later/on-demand list — a real Enterprise use case should drive scoping it
  further, not the reverse.
- Don't build either speculatively ahead of a concrete need — the same
  lesson this project keeps re-confirming (see DECISIONS.md's Core
  Priorities section).

## See also

- `docs/design/canonical-model.md` §2 — the adapter boundary this reuses
- `README.md` — "Why a Figma plugin and not a browser app?"
- `DECISIONS.md` §4, Later/on demand — "Enterprise REST provider"
