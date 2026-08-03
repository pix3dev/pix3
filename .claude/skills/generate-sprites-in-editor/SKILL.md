---
name: generate-sprites-in-editor
description: Generate image/sprite assets with the Pix3 editor's AI Sprite Editor by driving it through the chrome-devtools MCP — using existing project assets as style references — then save them into the project and wire them into scenes (Button2D normal/hover/pressed/disabled state sprites, ScrollContainer2D thumb/track, Sprite2D/panel skins). Use when asked to create game UI graphics, buttons, panels, icons or sprites and apply them to nodes. Requires the dev server + editor open in an MCP-attachable Chrome with a project loaded and a Gemini/OpenAI API key already configured in that browser.
---

# Generating sprites in the running Pix3 editor and wiring them into a scene

You cannot generate images yourself — the editor's image generation runs **in the
browser** and calls Gemini/OpenAI with the **user's API key** (stored encrypted
per-browser via `SecretStorageService`, never in any file). You drive it through the
**chrome-devtools MCP** against the live editor, and only if a key is already
configured there.

Two panels are involved when you drive the UI: the **Generate** panel
(`pix3-generate-panel`) makes the image, the **Sprite Editor**
(`pix3-sprite-editor-panel`) edits and saves it — including, for a `.pix3anim`, its
clips rail and frame timeline, where a generated image lands in the selected frame.

There are two ways to drive it, and **you should prefer the first**:

- **§A — the headless `__PIX3_DEBUG__.assets` API** (bridge **v2+**, dev builds
  only): a programmatic contract for generate / resize / crop / compress /
  remove-background / preview / save, using the user's saved key. No fragile DOM
  poking; every call returns JSON-safe metadata. This is the right tool for
  agents.
- **§B — driving the panel DOM** (`pix3-sprite-editor-panel`): the older path.
  Use it only for interactive QC (the crop rubber-band UI, the history strip) or
  if the bridge is somehow unavailable.

For attaching, play-mode control, and inspection, see the sibling
[debug-running-game](../debug-running-game/SKILL.md) skill — the preconditions and
`window.__PIX3_DEBUG__` bridge are shared.

---

## §0. Preconditions (shared — check, don't assume)

- Dev server running (`npm run dev`, port **8123**). If nothing serves 8123, start it.
- Editor open in the MCP's Chrome with a **project loaded** (the MCP profile persists
  the File System Access handle, so `navigate_page http://localhost:8123` usually
  auto-restores the project + last scene — the `#editor?local=…` URL).
- **API key configured.** `assets.status().keyConfigured === true` (or, in the UI,
  `.gp-key-button.is-connected` on the Generate panel). If not, generation is
  disabled — the human must enter a key once (Editor Settings → AI, or the key
  popover in the Generate panel's prompt bar); you can't.
- The bridge is **dev-only** and the `assets` surface needs **v2+**: check
  `window.__PIX3_DEBUG__.version >= 2`. If `window.__PIX3_DEBUG__` is `undefined`
  you're on a prod build / wrong page.
- The editor renders the **pix3 runtime from `packages/pix3-runtime/src`** (the
  `@pix3/runtime` alias), so any runtime feature you just wrote is live in the editor
  even before `yalc:publish`. Consumers like DeepCore only get it after
  `yalc publish` (in the package) **and** `yalc update` (in the consumer).

---

## §A. The headless asset API (`__PIX3_DEBUG__.assets`) — preferred

Everything runs via chrome-devtools MCP `evaluate_script`. The whole pipeline is a
handle registry: generate/open returns an image **handle** (`{id,width,height,
bytes,mimeType,...}`); transforms take an id and return a **new** id; `save`
writes a handle into the project. Blobs live only in the editor session — reload
clears them.

### A1. Check status first (provider, model, key, project)

```js
async () => window.__PIX3_DEBUG__.assets.status()
// → { providerId, modelId, keyConfigured, projectReady, defaultSaveMaxSize,
//     capabilities:{ aspectRatios, imageSizes, qualities, maxReferenceImages,
//                    supportsReferenceImages, supportsTransparency }, handles }
```

If `keyConfigured` is false the human must enter a key once (Editor Settings → AI,
or the panel's 🔑 popover) — you can't. If `projectReady` is false, no project is
open, so `save` will fail.

### A2. Generate (references are just project resource paths)

```js
async () => window.__PIX3_DEBUG__.assets.generate({
  prompt: 'a wooden UI button plate, warm oak, in the exact art style of the ' +
          'reference; NO text, NO letters, fully opaque background, crisp edges',
  references: [
    'res://sprites/ui/shop-ui.png',       // style reference(s)
    'res://sprites/ui/btn_close_normal.png',
  ],
  aspectRatio: '1:1',      // must be in capabilities.aspectRatios; else omitted
  imageSize: '1K',         // must be in capabilities.imageSizes; else omitted
  transparent: false,      // only honoured if capabilities.supportsTransparency
})
// → { id:'img-…', width:1024, height:1024, bytes:…, mimeType:'image/png', source:'generated' }
```

Prompt recipe is the same as always (see §B3): **the prompt dominates the
reference** — describe the real aesthetic in words AND attach the reference; keep
text OFF button sprites (`Button2D` draws its own label). Generation takes
~5–20 s; the promise resolves when it's done. Errors throw with a readable
message (missing key, blocked, empty…).

### A3. Transform (each returns a new handle id)

```js
async () => {
  const a = window.__PIX3_DEBUG__.assets;
  const gen = await a.generate({ prompt: '…', references: ['res://…'] });
  // Downscale to the size the game actually needs (longest edge, aspect-preserving):
  const small = await a.resize(gen.id, { maxSize: 256 });
  // Or crop a pixel rect: a.crop(id, { x, y, width, height })
  // Or shrink bytes:      a.compress(id, { format: 'image/webp', quality: 0.8, maxSize: 256 })
  // Or cut out the bg:    a.removeBackground(id)   // local Web Worker → transparent PNG
  return small;   // { id, width:256, height:256, bytes, mimeType }
}
```

### A4. Preview (QC before saving)

`preview(id, maxSize=256)` returns a `data:` URL you can screenshot/inspect
without saving. Cheap way to eyeball quality:

```js
async () => window.__PIX3_DEBUG__.assets.preview('<id>', 256)  // → 'data:image/png;base64,…'
```

### A5. Save into the project (with optional downscale)

`save(id, name, opts?)` creates parent dirs and writes the file. `name` is
project-relative (a `res://` prefix is also accepted); the extension is derived
from the format when omitted. Pass `maxSize`/`format`/`quality` to downscale or
re-encode **at save time** — so you keep the full-res handle but write a small
game asset:

```js
async () => window.__PIX3_DEBUG__.assets.save(
  '<id>',
  'sprites/ui/btn_close_normal.png',
  { maxSize: 256 }        // longest edge ≤ 256; omit to keep full size
)
// → { path, width, height, bytes, mimeType }
```

Verify the bytes landed with a shell `ls` on the real path — don't trust the
return value alone. Then repeat A2–A5 per state/sprite (reuse the same reference
paths for a consistent set). Handle/cache management: `list()`, `get(id)`,
`history(limit)`, `openHistory(recordId)` (pull a cached generation back into a
handle), `open(path)` (load an existing asset to edit), `discard(id)`, `clear()`.

Then **wire the sprites into the scene** and **verify** exactly as in §B5 / §B6
below (that part is identical regardless of how the image was produced).

---

## §B. Driving the panel DOM (fallback / interactive QC)

**Generation and image editing live in two different panels now.** The **Generate**
panel (`pix3-generate-panel`, `.gp-*` classes) owns the prompt, references, model /
API-key chrome and the generation history; the **Sprite Editor**
(`pix3-sprite-editor-panel`, `.ag-*` classes) owns the canvas — crop, rotate/flip,
background removal, slice, save, and (for a `.pix3anim`) the clips rail + frame
timeline. Both are light DOM, so those selectors query straight off `document`.

They are wired through `ImageEditTargetService`, never to each other: the Sprite
Editor registers itself as the active image-edit target while its tab is focused, and
the Generate panel **delivers a finished image straight onto that canvas** (into the
selected *frame*, when a `.pix3anim` is open). With no editor open the result stays in
the Generate panel with its own Save to project / Save to Library / Open in Sprite
Editor / Download actions — the old standalone Asset Generator behaviour. The panel
header (`.gp-head`) states which of the two is in effect.

TS-`private` is not runtime-private, so `addReferenceFromProject` / `prompt` /
`aspectRatio` / `references` / `generating` / `result` / `saveName` /
`onSaveToProject` on the Generate panel — and `boundImagePath` / `current` /
`saveName` / `saveMaxSize` / `onSaveToProject` / `onSliceIntoFrames` /
`onCreateAnimation` on the Sprite Editor — are all reachable in dev builds.

## B1. Open the panels

```js
() => window.__PIX3_DEBUG__.command('editor.open-generate-panel')  // the Generate dock
// and, when you want the canvas too (crop / slice / frame editing):
() => window.__PIX3_DEBUG__.command('editor.open-sprite-editor')
// then read state (both return false if already open — fine):
() => {
  const g = document.querySelector('pix3-generate-panel');
  const key = document.querySelector('.gp-key-button');
  return { open: !!g, keyConnected: key?.classList.contains('is-connected'),
           model: document.querySelector('.gp-model-select')?.value,
           destination: document.querySelector('.gp-head')?.textContent?.trim() };
}
```

## B2. Add project assets as style references (the key trick)

The Generate panel exposes `addReferenceFromProject(resourcePath)` — a normal
prototype method — that reads a `res://` asset via project storage and adds it as a
reference image. This is how you make new art match the game's existing look
**without** the native file picker:

```js
async () => {
  const g = document.querySelector('pix3-generate-panel');
  await g.addReferenceFromProject('res://sprites/ui/shop-ui.png');
  await g.addReferenceFromProject('res://.../an_already_generated_sibling.png'); // for state consistency
  return { refCount: g.references.length }; // model cap is usually 6
}
```

**Style gotcha:** the *prompt text dominates the reference.* If you write
"industrial metal" but the reference is wooden, you get metal. Describe the game's
actual aesthetic in words AND attach the reference. Look at the reference first
(screenshot the asset browser / preview) — don't assume the style from the file name.

## B3. Set aspect + prompt, then generate

Aspect options (Gemini "Nano Banana"): `Auto, 1:1, 3:4, 4:3, 16:9, 9:16` — **no
ultra-wide**; 16:9 is the widest. Button2D/Sprite2D **stretch** the texture to the
node's width×height, so pick the closest aspect and accept minor stretch. Set
`panel.aspectRatio` directly.

```js
async () => {
  const g = document.querySelector('pix3-generate-panel');
  g.aspectRatio = '1:1'; // '16:9' for wide buttons
  const ta = document.querySelector('.gp-prompt');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'YOUR PROMPT');            // native setter so Lit sees it
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('.gp-generate-button').click();
  await new Promise(r => setTimeout(r, 500));
  return { generating: g.generating, error: document.querySelector('.gp-error')?.textContent || null };
}
```

Prompt recipe for UI chrome (buttons/panels): describe the material + the game's
palette + "in the exact art style of the attached reference", then **`NO text, NO
letters, NO symbols, fully opaque background filling the entire image, crisp edges`**.
Keep text OFF the sprite — `Button2D` renders its `label` on top. For hover/pressed
states, reference the normal sprite and ask for "brighter glowing rim-light" /
"darker recessed pushed-in, inner shadow".

Poll for completion (generation ~5–20 s; often done by the time you re-check):

```js
async () => {
  const g = document.querySelector('pix3-generate-panel');
  const sprite = document.querySelector('pix3-sprite-editor-panel');
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (!g.generating) break; await new Promise(r => setTimeout(r, 1500)); }
  // The image lands EITHER on the Sprite Editor canvas (a target was registered)
  // OR in the Generate panel's own result block.
  return { done: !g.generating, hasResult: !!g.result, onCanvas: !!sprite?.current,
           error: document.querySelector('.gp-error')?.textContent || null };
}
```

Screenshot to QC before saving — the art quality is worth one look.

**Transparency:** Gemini can't output alpha (`supportsTransparency:false`); OpenAI
GPT-Image can (transparent toggle), or click "Remove background" in the Sprite Editor
(a Web Worker; tuned for subjects-on-background, unreliable for UI chrome).
Simplest: generate **opaque** button plates (no cutout needed).

## B4. Save into the project

Whichever panel holds the image, `onSaveToProject()` reads that panel's `saveName`,
creates parent dirs, writes via the File System Access API, and returns the saved path
(null on failure):

```js
// (a) the image is on the Sprite Editor canvas (a target was registered):
async () => {
  const p = document.querySelector('pix3-sprite-editor-panel');
  p.saveName = 'sprites/ui/btn_close_normal.png'; // project-relative; res:// prefix also accepted
  p.saveMaxSize = 256;  // OPTIONAL: longest-edge downscale on save (0 = keep full 1K/2K size)
  return await p.onSaveToProject();
}
// (b) the image stayed in the Generate panel (no image editor open):
async () => {
  const g = document.querySelector('pix3-generate-panel');
  g.saveName = 'sprites/ui/btn_close_normal.png';
  return await g.onSaveToProject();
}
```

**Frame write-back:** with a `.pix3anim` open in the Sprite Editor, a generated image
— and any crop / rotate / flip / background removal — is written **into the selected
frame** as a new `<clip>_<nnnn>.png` and the document is updated, so there is nothing
to save by hand and undo puts the frame back on its untouched original.

**Downscale on save:** generations come out at 1K/2K, but game UI rarely needs
that. The Sprite Editor's save popover has a "Resize on save (longest edge)"
dropdown; set `panel.saveMaxSize` (px, `0` = original) to downscale
aspect-preserving at write time. It also drives `Insert as Sprite2D`, `Overwrite
original`, and `Download`. The default comes from Editor Settings → AI ("Default save
size") and persists. (Headless equivalent: `assets.save(id, name, { maxSize: 256 })`.)

Verify the bytes landed with a shell `ls` on the real path — don't trust the return
value alone. Then loop steps B2–B4 for each state/sprite (reuse references for
consistency).

## B5. Wire the sprites into a scene

Edit the `.pix3scene` YAML directly (clean, version-controlled). Texture refs use a
block form — copy an existing `Sprite2D`'s `texture:` block as the template. For
`Button2D` state sprites, add under the node's `properties:`:

```yaml
          textureNormal:
            type: texture
            url: res://sprites/ui/btn_close_normal.png
          textureHover:
            type: texture
            url: res://sprites/ui/btn_close_hover.png
          texturePressed:
            type: texture
            url: res://sprites/ui/btn_close_pressed.png
          # textureDisabled optional; missing states fall back to normal
```

(ScrollContainer2D: `scrollbarThumbTexture` / `scrollbarTrackTexture`, same block.)

The editor does **not** auto-reload the file reliably, so **reload the page** to load
the edited scene from disk:

```js
// navigate_page type:'reload'  (the MCP profile keeps the FS permission; no re-prompt)
```

## B6. Verify

- **Inspector (definitive):** select the node; the live inspector renders one
  `pix3-texture-resource-editor` per sprite prop from the *real* node's schema. Read
  them — populated `resourceUrl` = the runtime node loaded the sprite:
  ```js
  () => Array.from(document.querySelectorAll('pix3-texture-resource-editor'))
             .map(e => e.resourceUrl)
  ```
- **Play mode:** `__PIX3_DEBUG__.play.start()`, then `liveFind('Node Name')` (a
  Button2D with a skin should show `childCount:2` = skin + label), and
  `__PIX3_DEBUG__.errors()` should be `[]` (a failed texture load logs a warning
  captured here). `play.stop()` when done.

## Gotchas (all learned the hard way)

- `__PIX3_DEBUG__.find(name)` returns a **serialized DTO** (ctor `Object`), not the
  live node — you can't read `.buttonMaterial`/`.textureNormal` off it. Use the
  inspector (§B6) or `liveFind` for the runtime object.
- The render **canvas is inside a shadow root** — `document.querySelector('canvas')`
  returns nothing. Driving precise in-game clicks needs the 2D ortho camera's logical
  size; usually not worth it — verify via inspector + `errors()` instead.
- **Two panels.** Prompt / references / model / history are `pix3-generate-panel`
  (`.gp-*`); the canvas, crop, background removal, slice and save are
  `pix3-sprite-editor-panel` (`.ag-*`). Reaching for `.ag-prompt` or
  `panel.addReferenceFromProject` on the Sprite Editor is the single most likely
  mistake — that chrome moved. Their `private` fields and methods are all reachable
  at runtime (TS-`private` ≠ runtime-private) in dev builds.
- A generated image goes to the Sprite Editor **only if one is open and focused** (it
  registers as the active `ImageEditTarget`); otherwise it stays in the Generate
  panel's result block. Read `.gp-head` if you are unsure which happened.
- Generated a spritesheet? On the **Sprite Editor**, `onSliceIntoFrames()` writes its
  cells into `<name>_frames/`, and `onCreateAnimation()` builds a managed sprite
  folder (`<dir>/<stem>/<stem>.pix3anim` + `idle_<nnnn>.png`) and opens it in the
  same editor (clips rail + frame timeline appear around the canvas). Both need the
  image **saved into the project first** — they act on `panel.boundImagePath`, so a
  purely in-memory generation has nothing to slice. Both open the shared slice
  dialog, so confirm it via
  `document.querySelector('pix3-animation-auto-slice-dialog')` before awaiting.
- After a page reload the Generate panel's references/history reset — re-add
  references.
- Design canvas size is in `pix3project.yaml` (`viewportBaseSize`); DeepCore is
  1080×1080.
