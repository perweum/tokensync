# Stage 0 spike: does `fontWeight` or `fontStyle` actually bind a font's style name?

Text Styles work is blocked on this. Figma's `VariableBindableTextField` type
lists **both** `'fontWeight'` and `'fontStyle'` as separate bindable fields, but
no Figma doc found gives an example of what each one actually does — whether
`fontStyle` binds the literal installed font style name (`"SemiBold"` — what
this repo's `fontWeight`-typed tokens already hold), `fontWeight` binds a
numeric OpenType weight axis (only meaningful for true variable fonts), both,
or something else. Binding the wrong field could silently do nothing, throw,
or bind something we don't intend. This needs answering in a real Figma file
before Stage 3 (the write path) is built.

## How to run it

This needs to execute inside a Figma plugin sandbox — it can't run from a
browser console or Node. Two ways to get it there:

**Option A — Figma's built-in code console**, if your Figma version has one
(Menu → Plugins → Development → look for "Console" or a code-snippet runner).
Paste the script below directly.

**Option B — temporary addition to this plugin.** Paste the script into
`plugin/src/plugin/main.ts` right after `figma.showUI(...)`, run `npm run dev`
or `npm run build:plugin`, load the plugin in Figma (Plugins → Development →
Token Sync), and open the console (Plugins → Development → Show/Hide Console)
to see the `console.log` output. **Revert the paste afterward** — this is a
throwaway spike, not part of the real implementation.

## The script

```ts
async function spike() {
  const collection = figma.variables.createVariableCollection("Spike");
  const mode = collection.modes[0].modeId;

  // A STRING variable holding a literal font style name — exactly what this
  // repo's fontWeight-typed tokens already contain, e.g. "SemiBold".
  const weightVar = figma.variables.createVariable("spike/weight-string", collection, "STRING");
  weightVar.setValueForMode(mode, "Bold");

  // Try binding it to 'fontWeight' on one style...
  const styleA = figma.createTextStyle();
  styleA.name = "Spike/Bound via fontWeight";
  try {
    styleA.setBoundVariable("fontWeight", weightVar);
    console.log("fontWeight bind: no error thrown");
  } catch (e) {
    console.log("fontWeight bind: THREW —", String(e));
  }

  // ...and to 'fontStyle' on a separate style, so each is isolated.
  const styleB = figma.createTextStyle();
  styleB.name = "Spike/Bound via fontStyle";
  try {
    styleB.setBoundVariable("fontStyle", weightVar);
    console.log("fontStyle bind: no error thrown");
  } catch (e) {
    console.log("fontStyle bind: THREW —", String(e));
  }

  console.log("styleA.boundVariables:", JSON.stringify(styleA.boundVariables));
  console.log("styleB.boundVariables:", JSON.stringify(styleB.boundVariables));
  console.log("styleA.fontName:", JSON.stringify(styleA.fontName));
  console.log("styleB.fontName:", JSON.stringify(styleB.fontName));

  figma.notify("Spike done — check the console, then inspect the two styles in the Assets panel");
}

spike();
```

## What to check afterward, in Figma's UI

1. **Console output** — did either `setBoundVariable` call throw? If one did
   and the other didn't, that alone answers most of the question.
2. **`boundVariables` on each style** — does it show the variable bound under
   the key you'd expect (`fontWeight` vs `fontStyle`)?
3. **Open the Assets panel → local text styles** — do "Spike/Bound via
   fontWeight" and "Spike/Bound via fontStyle" show a variable-link icon next
   to the weight/style field? Which field, specifically?
4. **Create a text layer, apply each style, then edit `spike/weight-string`'s
   value** (e.g. change `"Bold"` to `"Regular"`) — does the applied text
   update live for one, both, or neither style?
5. **Cleanup**: delete the `Spike` variable collection and the two `Spike/...`
   text styles when done.

## Report back

Whichever field(s) actually bind the literal style name string correctly is
what `figma-text-styles.ts` (Stage 3) should use for our `fontWeight`-typed
tokens. If both work, or neither does cleanly, that changes the plan — report
the raw findings rather than just a conclusion, in case something looks like a
bug worth filing with Figma rather than a real semantic split.
