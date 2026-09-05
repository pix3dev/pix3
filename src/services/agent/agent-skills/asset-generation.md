# Skill: asset-generation

> Reliable defaults for this editor. Follow the tool/format specifics exactly; adapt the
> _process_ to the task if you have a better plan.

How to generate game art with `generate_asset` that looks good **and matches the design**,
then wire it onto nodes. The tool already post-processes images (background removal, trim,
downscale) — your job is a good prompt, the right preset, and applying the result.

## 0. Pick the lane: vector or raster

Two kinds of provider sit behind `generate_asset`, and picking wrong costs either money or a
usable result.

- **`providerId: 'svg-llm'` — vector, drawn by your own model.** It writes SVG and the editor
  bakes it to a PNG locally. You get the **exact** `width`/`height` you ask for, real
  transparency (no background-removal pass to go wrong), an answer in seconds, and the price of
  a text completion. Use it for icons, buttons, bars, meters, arrows, frames, flat props,
  schematic art and every blockout/placeholder. Pass `width` and `height` — that is the whole
  point of this lane; a UI element sized to its slot needs no trim and no downscale.
- **The default (raster) providers** — a metered image model. Use them when the art wants
  painterly rendering, texture, lighting or photographic detail: hero sprites, backgrounds, key
  illustrations. They do not honour `width`/`height`; you get their aspect-ratio grid.

Prototype rule of thumb: everything vector first, then upgrade the two or three pieces that
actually carry the game's look.

## 1. Extract style tokens once, reuse them everywhere

Before generating anything, get the game's visual style as a reusable phrase:

- Call `analyze_image` on the main design reference in `design/` with
  `question: "list style tokens for an image prompt: palette hex, rendering style, line/shading,
lighting, camera angle, mood"`.
- Keep that comma-separated answer. Paste it into **every** `generate_asset` prompt so all
  assets share one look.
- **Be careful with the `references` array — the generator copies composition, not just
  style.** Passing a full gameplay screenshot as a reference for a single-object sprite
  routinely produces the _whole scene_ (track, several cars, UI) instead of the one object.
  For single-object sprites/icons, carry the style in words (the tokens above) and omit
  `references`, or reference only a tight crop of a single object. Full-scene references are
  fine when you actually want a scene (backgrounds, mockups).

## 2. Pick the right preset (this controls post-processing)

`generate_asset` `postProcess` presets:

- **sprite** — remove background + trim to content + downscale. Use for characters, items,
  props, the player, enemies. Always pair with `transparent: true`.
- **icon** — sprite + pad to a centered square. Use for UI icons / upgrade icons so a grid
  lines up.
- **texture** — downscale only, keep the background. Use for backgrounds, tiles, photos, skies.
- **none** — raw save, no processing. Rarely needed.

Default when you omit it: `transparent:true`→sprite, otherwise→texture.

## 3. Write a prompt that post-processing can succeed on

- One subject, centered, on a **plain/solid background** (background removal needs contrast).
  e.g. `"a red sports car seen from top-down, centered, plain flat background, <style tokens>"`.
- For icons: `"a single <thing> icon, centered, plain background, <style tokens>"`.
- Always set `transparent: true` for sprite/icon.
- Save into the asset-type folder at the **project root** — images go under `sprites/`, e.g.
  `sprites/<kind>/<name>.png`. Projects use a flat layout (`sprites/`, `models/`, `audio/`,
  `spine/`, `scenes/`, `scripts/`); never nest assets under an `assets/` folder, and never
  drop a file in the project root.
- Omit `maxSize` to use the project default (keeps files small). Pass it only when you need a
  specific size (e.g. a small 128px icon).

## 4. Check the result, then apply it

- **Transparency is already handled — trust the `transparency` field in the result, do NOT
  check it with vision.** `generate_asset`/`process_asset` remove the background and report
  `transparency.hasAlpha` measured from the alpha channel. **Never** ask `analyze_image` "is the
  background transparent/white?" — vision models see transparent pixels as _white_ and will
  falsely tell you the cutout failed, sending you into a pointless regeneration loop. If
  `hasAlpha` is true, the background is transparent, full stop.
- Use `analyze_image` only for **content/framing** questions your model can't see for itself
  — never for transparency. Ask a **pass/fail checklist, not "describe the image"**: a vision
  model will happily describe a wrong image in neutral words and you will misread it as
  success. e.g. `question: "Answer each with yes/no: (1) exactly ONE subject (a single
top-down car), not a whole scene? (2) subject centered and not cut off? (3) no UI, track or
other objects around it?"`. Any "no" → the content is wrong.
- If the _content_ is wrong (wrong subject, cropped, bad framing): regenerate with a better
  prompt. If only the _processing_ is off (`hasAlpha` false = background not removed, or too
  large): call `process_asset` on the saved path (preset `sprite`) — no regeneration needed.
- **If only the _orientation_ is wrong, DON'T regenerate — rotate/flip it.** Top-down sprites
  (cars, arrows, ships) frequently generate pointing sideways/down even when the prompt says
  "nose up", and the aspect ratio isn't controllable. Pass `rotate` (90/180/270, clockwise)
  and/or `flip` (`horizontal`/`vertical`) to `generate_asset`/`process_asset` to snap the sprite
  to the orientation your controller expects (this engine treats **+Y / up** as "forward" for
  top-down movement). Verify with an `analyze_image` checklist, e.g. `"Answer yes/no: does the
car's nose/front point UP toward the top edge?"`, then rotate until it does.
- **Accept and move on.** One good result is enough; do not regenerate to chase small nits —
  each generation costs money.
- **Apply it to a node**: find the node (`find_nodes` / `scene_tree`), then `set_property` its
  texture/skin property to the saved `res://…` path. Common targets: `Sprite2D.texture`,
  `ColorRect2D` → swap for a `Sprite2D`, `Button2D` state skins (normal/hover/pressed/
  disabled), panel/background skins. Use `node_inspect` to see the exact property names.
  (Tip: generating straight into the path a node already references updates it automatically.)

## 5. Batch related icons cheaply

Need several small icons in one style? Generate them one at a time with the same style tokens
and the `icon` preset — consistent size and framing make them drop into a grid cleanly.

## 6. UI chrome is a KIT, not a pile of separate generations

Buttons, panels, sliders, bars and checkboxes are the one part of the art where independent
generations always lose: drawn one at a time, a button and the panel behind it never quite agree
on radius, outline weight or highlight, and the screen reads as assembled from three games.

`skin_ui` solves that by construction — one theme, procedurally rendered into every part, no
image model in the loop (no key, no cost, seconds):

- `skin_ui { action: 'bake', preset: 'Candy Pop' }` renders the kit into `sprites/ui/<kitId>/`
  and saves the recipe as `design/ui-theme.json`. Presets: Standard, Brawl Stars, Bombastic,
  Candy Pop, Soft shadow, Puffy (capsule), Flat. Add `theme: { radius, bevel, outline, glossOn,
  glossType, glossA, shadowMode, darkTone, palette }` to push individual knobs; `palette` pins
  absolute hexes per semantic role, which is how the kit ends up in the project's own colours.
- `skin_ui { action: 'apply', targets: 'scene' }` puts the baked textures and their nine-slice
  insets on every UI control of the active scene (or pass `nodeIds`, or leave both out to use the
  selection). `colorRole` decides the colour: **green = the single primary action on a screen,
  blue = secondary, red = destructive.** It goes through the undoable property path, so Ctrl+Z
  takes it back off — and the scene still needs saving afterwards.
- `skin_ui { action: 'restyle', theme: { radius: 30, glossOn: 0 } }` is the answer to "rounder,
  darker, less gloss": it re-renders the recipe and re-dresses everything already wearing a kit.
  Use this rather than baking a fresh look each time — a restyle moves the whole UI together,
  while a re-roll would leave one button in a different style.

The kit's captions are NOT baked into the pictures (the engine draws `label`), so the skin stays
valid in every locale. Use `generate_asset` for what a kit cannot make: hero art, props,
backgrounds, one-off illustrations.

## 7. Sound is a separate lane with the same shape

Audio is not image generation and does not belong in this skill's loop, but the ladder is the
same: `scene.audio.sfx(preset)` for the nine built-in synth sounds (no file, no cost),
`generate_sfx` for a named sound with its own character (a procedural recipe written by your own
model and rendered locally into `res://sfx/<name>.wav`, for the price of a text completion), and a
sound designer's final file overwriting that same path on polish. Keep the `soundline` a call
returns so a tweak is an edit rather than a re-roll, and never ask it for music, ambience or
voices — it declines those by design.

## Rules

- Ask the user before spending on generation if they haven't clearly asked for art — image
  generation costs money on their key.
- Never leave a raw, un-cut, full-size generation on a sprite node; that is what looks bad.
  sprite/icon presets exist precisely to avoid it.
