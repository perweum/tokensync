# No lock-in

The design principle behind Token Sync, and what it requires concretely.

---

## The problem being avoided

Token Studio holds authoritative state inside the plugin. The repository is an
export target, not the source of truth. Three consequences follow, all observed
during a real migration:

- Editing `$themes.json` in Git works until the next plugin push overwrites it.
- After a rename, the plugin kept pointing at old set names and reported every
  token broken, while the repo was entirely correct.
- Variable import silently deleted configuration the plugin could not derive from
  Figma, including token sets that have no Figma representation.

The team could not step away from the plugin without the project degrading. That
is the lock-in — not a licence or a format, but an operational dependency.

---

## The inversion

**The repository is the source of truth. The plugin holds a cache.**

Every consequence below follows from taking that literally.

### The repo must be complete

Configuration, topology and tokens all live in files. A person with the repo and
no plugin can build the design system, change a theme, add a brand, and generate
CSS. The plugin makes that pleasant; it is never required.

Test: delete the plugin's local state entirely. Pull. Nothing is lost.

### The plugin must be able to rebuild from the repo

If plugin state and repo disagree, the repo wins and the plugin rebuilds. There is
no merge dialogue where the plugin's opinion can survive contact with the file
that is under version control.

### Sync state must be visible

The failure that cost the most time was invisible drift — the plugin showing
broken tokens while the repo was fine. Show whether local matches remote, and
make refreshing obvious. Silence is the bug.

### Import merges, never replaces

Some tokens cannot exist as Figma variables — composite typography most obviously.
An import that rebuilds from Figma must preserve everything it did not produce.

Token Studio's import deleted plugin-only sets and every `source` reference in the
theme configuration. Both were unrecoverable without a backup.

### Renames are atomic

A set name is its file path. Renaming touches the file, `$themes.json` and
`$metadata.json`. All three change together in one commit, or the repo is broken
for anyone who pulls in between.

Offer this as a command. Doing it by hand is where people lose an afternoon.

### Config is hand-editable

Someone will need to fix configuration in a text editor at some point — during a
migration, a merge conflict, or a CI failure. The format should reward that:
readable keys, stable ordering, meaningful diffs. Avoid generated ids where a
name would do.

---

## What this rules out

- Configuration that exists only in plugin memory or `clientStorage`
- Any push that writes cached state over newer repo content without asking
- Import paths that assume the plugin produced everything it sees
- Formats requiring the plugin to interpret them

---

## What it enables

Consequences worth designing toward, not just avoiding harm:

- **CI can build without Figma.** The generator reads files. No plugin, no
  browser, no Figma token.
- **Other tools can interoperate.** A repo that is complete and documented can be
  read by a bespoke script, another plugin, or a future replacement.
- **Migration in is cheap, migration out is possible.** Both matter for adoption.
  A team evaluating the plugin should be able to see the exit before committing.
- **Review works.** Token changes appear in pull requests as readable diffs
  because the repo holds the real state.

---

## Migration from Token Studio specifically

Most adopters will arrive from Token Studio. Interoperating with its format is a
migration path, not a permanent commitment.

Reading `$themes.json` and `$metadata.json` natively means a team can adopt Token
Sync without restructuring first, then restructure later if they want. Requiring
conversion up front makes evaluation expensive and adoption unlikely.

See `docs/interop/token-studio.md` for the format contract and the failure modes
worth defending against.
