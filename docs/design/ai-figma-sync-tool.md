# AI-assisted Figma sync — analysis, not scoped

Status: **idea raised by the user (September 2026); revised October 2026.**
No design accepted, nothing built. The point of this document is to separate
what's buildable today from what depends on a platform capability this project
doesn't control, and to state what an agent would need (access, rules, guards)
to do what Token Spark does.

**Revision note (October 2026).** The September version claimed the Figma
Plugin API "is not a network-callable surface at all" and that agent-driven
Figma access therefore required the Enterprise REST API. That is no longer
accurate: Figma's official MCP server exposes `use_figma`, which executes
JavaScript against the Plugin API in a named file, plus read tools such as
`get_variable_defs`. §2 and §3 are rewritten around that. Claims marked
**[verify]** come from the tool descriptions, not from a test against a real
file.

---

## 1. The idea

A tool that lets an AI agent operate the sync loop — Figma Variables and
Styles ⇄ the token repository — inside a controlled environment with strict
rules. Not "run the existing sync on a timer": the agent reads, diffs, proposes
and verifies, while the rules that protect the repo stay enforced outside the
model.

## 2. What the plugin does, and where the logic lives

- `plugin/src/plugin/` (`figma-variables.ts`, `figma-text-styles.ts`,
  `main.ts`) is the only code that calls `figma.*`. It is a thin boundary.
- `plugin/src/shared/` is pure TypeScript with no Figma or browser dependency:
  `figma-to-tokens.ts` (Figma → token files), `token-merger.ts`
  (`parseRepository`: repo → resolved collections), `token-diff.ts`,
  `sync-logic.ts`, `apply-batch.ts`, and the CSS/JS/TS/Dart/Swift transformers.
- Push: Figma → token files → diff → one atomic commit via the Git Data API →
  PR. Pull: repo → `parseRepository` → diff → apply to Figma.

The value is in `shared/`. An agent's job is to be another hand that runs this
logic, not to re-derive it.

## 3. Integration surfaces

### Platform facts (revised)

- The **Plugin API** has full read/write on Variables on every plan, but only
  runs inside Figma. A human running the plugin is one way to reach it.
  `use_figma` in Figma's MCP server is another: it runs agent-supplied
  JavaScript against the Plugin API in a given file, with no plugin UI
  involved **[verify: plan and seat requirements, rate limits]**.
- The **Variables REST API** requires an Enterprise/Organisation plan for
  write access (unchanged; this is why Token Spark is a plugin — see README).
- Known limits of `use_figma` per its description: ≤ 50 000 characters of code
  per call; `setPluginData`, `createImageAsync` and `loadAllPagesAsync` are not
  supported; pages must be switched with `setCurrentPageAsync`.

### (A) Repo-only agent — buildable today, any plan, smallest scope

An MCP server (or a well-briefed coding agent) that only touches the repo:
reads `tokens/**/*.json` and `metadata.json`, makes an edit (rename, new theme
file, primitive change), validates, and opens a PR. It never touches Figma; a
human runs the plugin's Pull/Apply afterwards.

Realistic because `shared/` already has no Figma dependency; the validation an
agent needs (does the tree still resolve, does a rename touch every affected
place) already exists in `token-merger.ts` and needs exposing, not rebuilding.

**Limitation:** closes half the loop. Nothing confirms the Figma-side apply
succeeds; it can still fail for reasons the agent can't see (unloaded font,
renamed collection — both logged incidents in DECISIONS.md §1).

### (B) Agent with Figma MCP + GitHub — closes the loop, no Enterprise REST

The agent reads Variables/Styles from Figma (`get_variable_defs`, or
`use_figma` running read-only Plugin API code), feeds the result through the
**same** `shared/` logic (`figmaToCollections` → `diff`), and opens a PR. In
the other direction it runs the apply logic through `use_figma` and then reads
back to verify.

What this changes versus September: Figma-side access no longer needs a human
in the plugin or an Enterprise plan **[verify]**. What it does not change:

- `use_figma` is raw Plugin API access. It can delete variables and
  collections, and has no dry-run. Every guard has to be built around it (§5).
- The apply code in `plugin/src/plugin/` is written against the plugin sandbox
  and would need to be callable as a string of JS (or reimplemented thinly)
  inside `use_figma` calls. This is real work, not a config change.
- The reusable logic still needs the `@tokenspark/core` extraction.

### (C) Headless Figma REST — Enterprise only, large scope

Unchanged from September: a separate sync engine over the Variables REST API
with its own auth model and test story. Only worth building for a real
Enterprise customer; stays in DECISIONS.md "Later / on demand".

### Recommendation on surfaces

(A) first — it cannot damage a Figma file and delivers the validation tools
(B) also needs. Then (B), read-only first (Figma → diff), writes later and only
against a Figma branch or copy. (C) only on demand.

## 4. Access an agent needs

**GitHub** — identical to the plugin (`docs/github-token-setup.md`):

| Permission | Access |
|---|---|
| Contents | Read and write |
| Pull requests | Read and write |
| Metadata | Read-only (automatic) |

Fine-grained token on exactly one repository. Prefer a dedicated bot account
or GitHub App so agent-authored PRs are identifiable. Branch protection on the
default branch with required review; the agent must not be able to merge.
That is what actually enforces "always a PR".

**Figma** (surface B only):

- Read: access to the file.
- Write: edit rights on the file via OAuth in the MCP server. Edit rights on a
  file means `use_figma` can do anything the Plugin API can. Contain this by
  pointing the agent at a **Figma branch or duplicate**, never the main file —
  the Figma-side equivalent of the PR gate. **[verify: branching availability
  per plan]**

**Runtime** — outbound allowlist limited to `api.github.com` and the Figma MCP
endpoint; credentials in a secret store, never in the prompt or the repo.

## 5. Rules: the same as the plugin, enforced as code

An agent needs the same invariants a human operator has, arguably enforced
harder because it will attempt destructive things without intending to. The
concrete rules, all from this repository:

- **Always a PR, never a direct commit** (README — "Why always PR…").
- **Import merges, never replaces.** Composite typography has no Figma
  representation and is destroyed by a rebuild. The agent must never get the
  equivalent of `handleCleanApplyAll`'s delete-and-rebuild
  (`canonical-model.md` §5.3).
- **Renames are atomic**: file, `metadata.json` and any theme config in one
  commit (CLAUDE.md).
- **`ignoredCollections` is honoured**, and unknown Figma collections surface
  as a warning rather than being dropped silently.
- **Names**: `.` in token names is refused on push and pull; mode names are
  Figma's real names and are sanitised for file names (`sanitizeFileName`);
  paths outside `primitives/`, `semantic/global|themes/`, `semantic/{scheme}.json`
  are silently dropped by the parser.
- **References resolve for real**: circular aliases are detected, ghost aliases
  are not dropped silently, `var(--*)` is verified against the real target.
- **Types**: `dimension`/`number` → `FLOAT`; `fontWeight` stays `STRING`.
- **Text Styles**: load the font before writing any property.
- **Dry-run diff before any write**, with an explicit confirm step.

**Where the rules live matters more than what they are.** DECISIONS.md §1
records the bugs that violated them: base64 handled as Latin-1, a colour-alpha
rounding boundary, ghost aliases, two variable names colliding structurally.
These are subtle; a model re-deriving them from a prompt list will reproduce
them. So:

1. Extract `shared/` as `@tokenspark/core` (DECISIONS.md Priority 1).
2. Expose a narrow tool surface over it, not raw file or Figma access:
   `tokenspark_get_status`, `tokenspark_get_diff`, `tokenspark_validate`,
   `tokenspark_propose_change` (working copy only, always followed by
   `validate` + `get_diff`), `tokenspark_open_pr` (callable only against a diff
   that passed validation).
3. Keep a short `AGENTS.md`/`CLAUDE.md` in the token repo explaining *what* and
   *why*; enforcement stays in the tools, not the prompt.
4. For surface (B), only a wrapped, reviewed apply routine may call
   `use_figma` for writes — not free-form agent-written JavaScript.

## 6. Limitations and risks

- **Prompt injection.** Token names, descriptions, and PR/commit text come from
  Figma and GitHub and are untrusted input to the agent. They must be handled
  as data, and the tool surface (not the model's judgement) is what bounds the
  blast radius.
- **Concurrency.** A designer edits while the agent pushes or applies. Needs
  last-synced detection and the "repo wins" rule from
  `docs/principles/no-lock-in.md`.
- **Verification.** Without a read-back step (`get_variable_defs` after a write,
  diffed against the repo), (A) never knows whether apply worked, and (B) only
  knows if the read-back is built.
- **Many plausible bad PRs.** A confused agent is a different failure mode from
  an occasional human mistake; needs rate limits and clear branch naming before
  reaching a real team.
- **Cost and determinism.** Anything that doesn't need judgement (build outputs,
  validation, diff) belongs in a deterministic CLI in CI
  (DECISIONS.md "Developer-First Toolchain"). Use the agent for judgement —
  proposing renames, explaining a diff, diagnosing a failed apply.
- **Platform dependency.** (B) depends on a Figma-hosted tool whose plan gating,
  rate limits and supported API subset can change. This is the reverse of the
  no-lock-in principle if made required: the repo and plugin must keep working
  with no agent and no MCP server.

## 7. Recommended sequence

1. `@tokenspark/core` extraction with a CLI (`validate`, `diff`, `build`) —
   valuable independent of any agent.
2. Repo-only MCP (A) over the core, tested with real PRs.
3. Read-only Figma access (B): Figma → diff, no writes.
4. Writes via a wrapped apply routine, on a Figma branch/duplicate, with
   read-back verification.
5. Before step 3: test `use_figma` and `get_variable_defs` against a real test
   file to settle the **[verify]** items (plan/seat requirements, rate limits,
   branching, whether the Plugin API surface Token Spark's apply code needs —
   variables, text styles, font loading — is fully available).

Don't build any of it speculatively ahead of a concrete need (DECISIONS.md Core
Priorities).

## See also

- `docs/design/canonical-model.md` §2 — the adapter boundary this reuses
- `docs/principles/no-lock-in.md` — the repo-is-truth principle an agent must not erode
- `docs/github-token-setup.md` — GitHub permissions
- `README.md` — "Why a Figma plugin and not a browser app?"
- `DECISIONS.md` §1 *Developer-First Toolchain*, §4 *Later / on demand*
