# Transformer configurability vs. opt-out

Status: **researched, recommendation accepted and built.** §5's recommendation
— don't build configurable output shape, do build the missing platform-
selection UI and document bring-your-own-build-tool — is now live: the
**Output formats** screen (`OutputFormats.tsx`) and a new README section
("Already have a build step?"). Written in response to the Coop stress test's
real question — their `web-design-extractor` is already in production; would
Token Sync's CSS output ever replace it, and how does a team decide?

---

## 1. What exists today

Every transformer (`css.ts`, `js.ts`, `dart.ts`, `swift.ts`) is a fixed,
opinionated shape — its own selector convention, naming scheme, and file
layout, none of it configurable. The only control a project has is a binary
switch per platform in `metadata.json`:

```json
"platforms": {
  "css": { "enabled": true, "output": "dist/tokens.css" },
  "js": { "enabled": false }
}
```

There is no UI for this at all — it's a hand-edit-only field, discovered by
reading `metadata.json` or the README, the same class of gap the collection-
mapping UI just fixed for `figma.collections`.

## 2. The real question underneath "would Coop use our extractor"

Coop's `web-design-extractor` emits class selectors (`.christmas`,
`.size-desktop`) with its own naming; Token Sync's `css.ts` emits attribute
selectors (`[data-theme="christmas"]`, `[data-size="desktop"]`) with DTCG
dash-joined variable names. Different shapes, both valid, neither wrong. Two
ways Token Sync could close that gap:

- **(A) Make the transformer's output shape configurable** — selector
  strategy, attribute/class name, variable naming scheme, file split, becomes
  metadata.json-driven, so Coop could dial in a config that matches what's
  already wired into their codebase.
- **(B) Don't try — stay opt-out only, and make the *token JSON itself* the
  real interop surface**, clean and standard enough that Coop's *own* existing
  build tool can read it directly, no Token Sync transformer involved at all.

## 3. What the ecosystem actually does — checked, not assumed

Style Dictionary is the relevant precedent: it's the most widely adopted tool
in this space, and it's literally what Coop's own extractor is built on.
Two things confirmed directly against their docs, not memory:

- **Style Dictionary v4 has genuine, native DTCG support** — `$value`/`$type`/
  `$description` is a first-class input format, not a shim. (The newest
  2025.10 DTCG spec revision isn't fully supported yet — that's in progress
  for v5 — but the core `$value`/`$type` shape Token Sync already emits is
  solid v4 ground.) Token Sync's canonical model is already DTCG-native per
  `canonical-model.md` — this means Token Sync's raw `tokens/**/*.json` is,
  in principle, *already* valid Style Dictionary input, no adapter needed.
- **Even Style Dictionary's own built-in formats don't offer selector-shape
  configuration through options.** `css/variables` hardcodes `:root`. Getting
  a class-based, multi-theme selector scheme — exactly what Coop needed —
  requires writing a real custom format function against Style Dictionary's
  own plugin API. That's precisely what Coop's `web-design-extractor` is: not
  config, code.

That last point is the load-bearing finding. The most flexible, most mature
tool in this ecosystem doesn't solve "arbitrary output shape" with config
knobs — it solves it with an extension API and expects real code from teams
whose needs diverge from the sane default. Nobody in this space ships
"selector-strategy: class | attribute" as a JSON option, because the actual
space of things a team might want (selector kind, naming, file splitting,
breakpoint strategy, whatever a specific framework's CSS-in-JS wants) is open-
ended enough that a config surface trying to cover it becomes its own small
programming language — which is exactly the kind of premature, speculative
abstraction this project's own engineering principles already argue against.

## 4. Answering the three questions directly

**Does configurability make replacing Token Studio easier?** Mostly
orthogonal, and conflating them risks scope creep on both. The Token Studio
off-ramp (`canonical-model.md`) is about the *input* side — reading
`$themes.json` so a team doesn't need the Token Studio plugin anymore. The
transformer/output side is a separate concern the adapter boundary already
keeps separate on purpose. What *does* ease migration is (B) — a team stuck
on Token Studio today almost certainly also has *some* existing build step
consuming its export; letting that keep working against Token Sync's token
JSON removes "does the generated CSS match what I have" as a blocker to
switching away from Token Studio at all, without Token Sync needing to
reimplement whatever that build step does.

**Is configurability better for a brand-new design system?** No — the
opposite. A greenfield team has no existing convention to match, so a config
surface for selector strategy, naming, file layout is pure decision fatigue
with no payoff. They're better served by strong, documented, opinionated
defaults they can just accept — which is what the transformers already are.
Configurability is a migration-time need, specific to teams with existing
downstream consumers; it isn't a general improvement.

**Where do they choose which transformers run at all?** Nowhere today, and
this part is a real, standalone gap — unrelated to the configurability
question above, and worth fixing regardless of which way that one goes. Right
now `platforms.*.enabled` is invisible unless someone reads `metadata.json` by
hand. This deserves the same treatment collection-mapping got: a real screen
listing CSS/JS/TS/Dart/Swift with a checkbox each, writing the result to
`metadata.json` via a PR.

## 5. Recommendation

- **Don't build configurable output shape** (selector strategy, naming
  scheme, file split) into the transformers. It's a large, open-ended surface
  serving a migration-specific need that's better solved another way, and it
  cuts against this project's own stated preference for concrete defaults
  over speculative flexibility.
- **Do invest in the token JSON being a clean, documented, standards-correct
  interop surface** — verify Token Sync's `$type` vocabulary matches DTCG's
  actual names (`dimension`, not `size` — worth a direct audit, not assumed),
  and write down "already have a build step? Point it at `tokens/`, disable
  `platforms.*`" as a first-class supported path, not a thing a team has to
  reverse-engineer. Mostly documentation, not code — the model is already
  DTCG-native.
- **Do build the missing "which transformers do I want" UI.** Small, scoped,
  clearly valuable, and doesn't require resolving anything above first.

This serves both ends at once: strong opinionated defaults for a team
starting fresh, and a real, low-maintenance off-ramp for a team with existing
infrastructure like Coop's — without Token Sync trying to become a worse
version of Style Dictionary along the way.

## 6. Open questions

- **`$type` vocabulary — checked directly against the spec.** Token Sync's
  `color`/`dimension`/`fontFamily`/`fontWeight`/`number` (from
  `figma-to-tokens.ts`'s `inferType`) all match DTCG 2025.10's seven official
  base types exactly — no Style-Dictionary-v3-era naming like `size` in place
  of `dimension`. Two real gaps, not previously known: `boolean` and `string`
  are used for Figma `BOOLEAN`/`STRING` variables that don't map onto any of
  DTCG's seven types, and neither is an officially defined `$type` — the spec
  states every token *must* use one of the seven. Pragmatic (a Figma boolean
  toggle or an arbitrary string like an icon name genuinely isn't a "design
  value" in DTCG's sense), but technically non-conformant, and worth knowing
  before calling the token JSON fully spec-correct. Not a blocker for Style
  Dictionary interop specifically — it accepts arbitrary `$type` strings in
  practice — but matters if a stricter DTCG-conformant consumer is ever in
  scope.
- Should disabling all `platforms.*` become the literal *default* for a new
  project (opt-in generation) rather than today's defaults-on, given a
  meaningful fraction of adopters will already have a build step? Worth a
  first-run-experience decision, not decided here.

## See also

- `docs/design/canonical-model.md` §2 — the adapter boundary this reasoning
  extends to the output side
- `docs/principles/no-lock-in.md` — "other tools can interoperate," the
  principle this recommendation is a direct instance of
