# Token Sync

## Design principles

**The repository is the source of truth. The plugin holds a cache.**

Token Sync must never become required to keep a project working. A team with the
repo and no plugin can build, configure and generate. See
`docs/principles/no-lock-in.md` for what this requires concretely.

## Interop context

Most adopters will arrive from Token Studio. `docs/interop/` documents its
repository format and the failure modes worth defending against — all observed
during a real 14-brand migration, not inferred from documentation.

- `docs/interop/token-studio.md` — `$themes.json` contract, `enabled` vs `source`,
  multi-dimensional theming, value formats that need transformation, six concrete
  ways Token Studio repos break
- `docs/interop/migration-patterns.md` — what a large token system actually looks
  like, how global and brand-specific tokens split, what CSS generators need
- `docs/design/canonical-model.md` — the resulting direction: a neutral canonical
  model (DTCG-based) with Token Studio as one adapter into it, not absorbed into
  the core. Status: direction decided, mechanics under analysis — read the open
  questions section before treating it as a build spec.

Two findings that shape most decisions:

1. **`enabled` vs `source` is the export contract.** Getting it wrong leaks
   primitives into output. Enforce it rather than treating it as advisory.
2. **Colour mode and size are orthogonal.** No token varies by both. Generators
   should detect this instead of emitting the full cartesian product.

## When working on import

Import must merge, never replace. Some tokens — composite typography especially —
have no Figma representation and will be destroyed by a rebuild. Token Studio's
import deleted plugin-only sets and every `source` reference; both were
unrecoverable. See `docs/design/canonical-model.md` §5.3.

## When working on renames

A set name is its file path. A rename touches the file, `$themes.json` and
`$metadata.json` (or, natively, the token file path and `metadata.json`). All
affected files change in one commit or the repo is broken for anyone who pulls in
between.

## Where decisions and open work live

`DECISIONS.md` is the changelog and the priority-ordered backlog. Read it before
starting non-trivial work — it records why things are the way they are, code
invariants that caused real bugs when violated, and what's already been decided
vs. what's still open.
