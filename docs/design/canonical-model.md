# Canonical model & the Token Studio off-ramp

Status: **direction decided, mechanics under analysis.** This is not an implementation
plan yet — it is the reasoning that any implementation plan must be consistent with.
Do not start building the adapter architecture from this document alone; the open
questions in §6 need answers first.

---

## 1. The problem this solves

Most adopters will arrive from Token Studio or a similar tool, not from a blank
repo. Token Studio has done a lot of things well — the three-layer model, the
global/brand split, composite typography tokens — and `docs/interop/` documents
that work in detail. But all of it is gated behind their plugin: the repository is
an export target, not the source of truth, and a team cannot step away without the
project degrading. See `docs/principles/no-lock-in.md` for the full argument.

The naive response is to add a Token Studio reader to Token Sync. That is the wrong
shape of fix. If Token Sync's core is built around `$themes.json`, `enabled`/`source`,
and groups-as-dimensions, it has inherited Token Studio's concepts wholesale — the
lock-in has just moved to a different logo. **The goal is not "support Token
Studio." The goal is: own a neutral canonical model, and make Token Studio one
adapter into it.**

---

## 2. The adapter boundary

```
Token Studio repo ─┐
Plain DTCG repo    ─┼─▶ [adapter] ─▶ canonical model ─▶ diff / resolve / transform / Figma apply
Style Dictionary   ─┤                (DTCG-based, +$extensions)
Figma variables    ─┘
```

Everything downstream of the adapter — diff engine, reference resolution, the
CSS/JS/Dart/Swift transformers, the Figma apply — sees only the canonical model.
No adapter's concepts leak past that line. A Token Studio adapter translates
`$themes.json` away immediately; nothing downstream ever sees a `group`, a
`selectedTokenSets` map, or an `enabled`/`source` flag. Add a Style Dictionary or
Supernova adapter later and nothing downstream changes.

This boundary already half-exists in the code: `parseRepository` in
`plugin/src/shared/token-merger.ts` produces `ResolvedCollection[]`, and diff,
transform, and apply all consume that shape already. The concrete refactor is
therefore small: (1) firm up `ResolvedCollection`/`TokenValue` into a documented,
versioned IR; (2) treat today's parser as "the native DTCG adapter," one of
several; (3) add a Token Studio adapter that produces the *same* `ResolvedCollection[]`.
The ~800 lines of downstream logic do not move. This is also the natural place for
the `@tokensync/core` extraction already planned in DECISIONS.md §1 — the adapter
boundary and the core package boundary are the same boundary.

**The canonical model is DTCG.** Token Sync already uses it natively. Betting the
core on the open W3C standard — rather than on any one tool's format — is the
concrete form of "better for everybody": a Token Sync repo stays readable by any
DTCG-aware tool with zero adapter, which is the direct opposite of `$themes.json`'s
unreadability.

---

## 3. Migrate-once, not interoperate-forever

There are two different things "off-ramp" could mean:

- **(A) Import once** — read a Token Studio repo, convert it to Token Sync's
  native layout, and the team never opens Token Studio again.
- **(B) Interoperate continuously** — keep `$themes.json` as the ongoing source
  format and sync against it indefinitely.

**Decision: lead with (A).** Every failure mode catalogued in
`docs/interop/token-studio.md` — silent `source`-set loss on import, plugin cache
overwriting the repo, stale references after a rename — is a failure mode of
*continuous* sync against a format Token Sync doesn't own. Path (A) only needs a
one-time, well-tested *reader*; after conversion, the repo is a Token Sync repo
like any other, and none of those failure modes have anywhere to live. Path (B)
would require building a permanent, bidirectional, drift-resistant Token Studio
sync engine into the core — exactly the kind of format-specific complexity the
adapter boundary exists to keep out.

(B) can exist later as a thin, optional evaluation bridge if real demand shows up
for teams that want to trial Token Sync without committing. It is explicitly not
the design center.

---

## 4. What the canonical model must express

Reading the Token Studio-specific mechanisms in `docs/interop/` as instances of
general concepts:

| Token Studio calls it | General concept | Token Sync today |
|---|---|---|
| token sets, folder = set name | layers with a declared export role | 4 fixed layers (primitives/global/themes/semantic) |
| `enabled` / `source` | per-layer export contract | collection-level `ignoredCollections` (coarser — see below) |
| `group` → dimension | an **axis** — see §4.1, not all axes are the same kind | 2 fixed axes (themes × colorSchemes) |
| `{dot.path}` resolved against merged active sets | alias resolution over a composed permutation | already this |
| composite typography / shadow / math | structured value types | string `$value` only — see §5 |
| plugin-only sets (no Figma type) | provenance: not Figma-representable | none — this is why Clean Apply is dangerous, see §5.2 |

### 4.1 Axes: composing vs. modifier, not N peers

Initial framing ("N independent axes, detect orthogonality between all pairs") was
wrong. The real Coop system has three axes and they are not peers:

- **Composing axes** — brand and colour-mode. Every brand needs both light and
  dark; together they *select* which value a token resolves to. This is what
  Token Sync's `themes × colorSchemes` already models, and it should stay a small,
  closed set (realistically ≤3) rather than open-ended.
- **Modifier axes** — size (and, generically, anything like it: density, a future
  reduced-motion mode). A modifier axis declares which token *categories* it
  affects (`["typography", "spacing"]` for size) and is layered on top of whatever
  the composing axes selected. It never participates in selecting brand or colour
  values, and composing axes never look at it.

This is a direct generalisation of the observed fact in
`docs/interop/migration-patterns.md`: *"colour mode and size are orthogonal — no
token varies by both."* Encoding axis kind + declared affected categories lets a
generator **derive** that orthogonality (three CSS blocks, not four) instead of
having it hardcoded per project.

---

## 5. Composite tokens: the DTCG gap and the Figma gap

Two separate findings here, both concrete rather than hypothetical.

### 5.1 DTCG's `typography` type is a strict subset of what tools store

The DTCG spec defines composite `$type`s: `typography`, `shadow`, `gradient`,
`border`, `transition`, `strokeStyle`. Checked against the spec directly: DTCG
`typography` has exactly **5** properties — `fontFamily`, `fontSize`, `fontWeight`,
`lineHeight`, `letterSpacing`. Token Studio's composite typography token has **9**
— those five plus `paragraphSpacing`, `paragraphIndent`, `textDecoration`, and
`textCase`. (This mismatch isn't unique to us — Penpot has an open issue about the
same gap.)

**Resolution:** canonical model = DTCG's 5 properties, plus the 4 extras carried in
`$extensions` (which DTCG defines for exactly this purpose — vendor-namespaced
data alongside a token). Nothing is lost on import from a richer source, nothing is
invented on export from a plainer one. `shadow`, `gradient`, and `border` need the
same audit against real-world tool output before the model is trusted — not done
yet, see §6.

### 5.2 Figma has no composite variable type — Text/Effect Styles are a separate API surface

Checked against Figma's plugin docs and forum directly, because this changes scope,
not just a transformer:

- Figma Variables have exactly **4** scalar `resolvedType`s: `COLOR`, `FLOAT`,
  `STRING`, `BOOLEAN`. There is no composite/typography variable type.
- "Typography Variables" (Figma, 2024) is *not* a new variable type. It's the
  ability to bind those same 4 scalar types to individual fields — font family →
  `STRING`, weight → `STRING`/`FLOAT`, size/line-height/letter-spacing/paragraph-
  spacing/paragraph-indent → `FLOAT` — on a **`TextStyle`**, a distinct Plugin API
  object with its own `boundVariables` map per field. Effect Style is the parallel
  object for shadows.
- Token Studio's typography export already does exactly this dual thing: it
  creates/updates a Figma **Text Style** as the composite container, and — when
  variable-reference export is enabled — also creates and binds scalar Variables
  into that style's individual fields.

**Consequence:** README currently lists "Figma Styles export — Not planned." That
is no longer viable if typography/shadow tokens are to round-trip at all — this
affects native Token Sync users too, not only Token Studio migrants, because it's
a Figma platform limitation, not a Token Studio quirk. This needs its own Plugin
API surface (`figma.getLocalTextStylesAsync`, `figma.createTextStyle`,
`TextStyle.setBoundVariable`, and the Effect Style equivalents), separate from the
Variables code the plugin has today. Scoped as new work, not yet built — see
DECISIONS.md §4.

### 5.3 Why this makes merge-not-replace mandatory, not optional

Composite typography tokens have no Figma Variable representation at all — only a
Text Style can hold them. `docs/interop/token-studio.md` §"Observed failure modes
#2" documents exactly this being destroyed: a Token Studio variable import rebuilt
everything from Figma collections and deleted the plugin-only typography sets,
because no Figma collection produced them. Token Sync's `handleCleanApplyAll`
currently deletes variables and modes wholesale; on a repo with file-only
composite tokens (which, per §5.2, typography now unavoidably is), that is the
identical failure. Merge-on-import must be the default; destructive rebuild must
be an explicit, scoped, confirmed action — this is now a correctness requirement
tied to a specific data-loss mechanism, not a general good-hygiene preference.

---

## 6. Default behaviour: convert faithfully, suggest separately

Most teams migrating in want it to work, not to be restructured. Decision:

- **The importer converts. It does not improve.** Structure is transcribed
  faithfully; nothing is reorganised, split, or renamed without being asked.
- Any analysis of *how the repo could be better structured* — e.g. the mechanical
  global/brand classification described in `docs/interop/migration-patterns.md`,
  which classified 295 tokens correctly with no manual review — is a **separate,
  optional report** a team can run and read. It never runs as part of, or blocks,
  a plain migration.

---

## 7. Token Studio exporter (symmetry)

Committed as a direction, lower priority than the importer. Exporting a Token
Sync repo back into Token Studio's format is the strongest concrete proof of
no-lock-in available: "we'll hand you back a Token Studio repo if you want to
leave." Same adapter boundary, opposite direction, low marginal cost once the
canonical model and one adapter exist.

---

## 8. Open questions (not yet resolved — do not treat §1–7 as a build spec until these are)

1. **Shadow/gradient/border DTCG coverage.** §5.1 audited `typography` concretely.
   The other composite types need the same treatment against real Style
   Dictionary / Token Studio output before the `$extensions` strategy can be
   trusted generally.
2. **Axis-to-Figma-collection mapping under the 40-mode ceiling.** A Figma
   collection cannot exceed 40 modes (`docs/interop/token-studio.md` §6). 14
   brands × 2 colour-modes already uses 28. How many composing axes, and how many
   values per axis, can actually live in Figma vs. only in files? This bounds the
   model's ambition specifically on the Figma side.
3. **Provenance tagging mechanics.** §5.3 established *that* merge-not-replace is
   required. Not yet designed: how a token gets marked "no Figma representation,
   protect on rebuild" — inferred from shape (composite types), explicit metadata,
   or both.
4. **Exporter scope and timing.** §7 is a direction, not a plan — what subset of
   the canonical model an initial Token Studio exporter needs to cover, and when
   it's worth building relative to the importer and the core extraction.

---

## 9. Validation plan: three-corpus round-trip

Before writing an adapter, prove the canonical model isn't over-fit to Token
Studio by testing it against three independently-structured repos:

1. Token Sync's own `tokens/` (native DTCG) — in this repo.
2. `@kilden/design-tokens` (`~/projects/designsystem/packages/design-tokens`) — a
   real Token Studio repo, 14 brands, ~2800 tokens, the source of
   `docs/interop/`.
3. A plain vanilla DTCG repo with no tool-specific config at all.

If the canonical model ingests all three and regenerates correct platform output,
it's general. If it only works for Token Studio, the model has silently absorbed
Token Studio's shape and needs to be reworked before any adapter code is trusted.

---

## See also

- `docs/principles/no-lock-in.md` — why this matters, what it rules out and enables
- `docs/interop/token-studio.md` — the format contract and six observed failure modes
- `docs/interop/migration-patterns.md` — the layer model, axis data, and CSS shapes
  actually observed in a 14-brand migration
- `DECISIONS.md` §1 and §4 — where this direction is recorded as a project decision
  and where the resulting work items are tracked
