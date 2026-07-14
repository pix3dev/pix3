# Skill: asset-generation

> Reliable defaults for this editor. Follow the tool/format specifics exactly; adapt the
> *process* to the task if you have a better plan.

How to generate game art with `generate_asset` that looks good **and matches the design**,
then wire it onto nodes. The tool already post-processes images (background removal, trim,
downscale) — your job is a good prompt, the right preset, and applying the result.

## 1. Extract style tokens once, reuse them everywhere

Before generating anything, get the game's visual style as a reusable phrase:

- Call `analyze_image` on the main design reference in `design/` with
  `question: "list style tokens for an image prompt: palette hex, rendering style, line/shading,
  lighting, camera angle, mood"`.
- Keep that comma-separated answer. Paste it into **every** `generate_asset` prompt so all
  assets share one look.
- **Be careful with the `references` array — the generator copies composition, not just
  style.** Passing a full gameplay screenshot as a reference for a single-object sprite
  routinely produces the *whole scene* (track, several cars, UI) instead of the one object.
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
- Save under a sensible path, e.g. `src/assets/textures/<kind>/<name>.png`.
- Omit `maxSize` to use the project default (keeps files small). Pass it only when you need a
  specific size (e.g. a small 128px icon).

## 4. Check the result, then apply it

- **Transparency is already handled — trust the `transparency` field in the result, do NOT
  check it with vision.** `generate_asset`/`process_asset` remove the background and report
  `transparency.hasAlpha` measured from the alpha channel. **Never** ask `analyze_image` "is the
  background transparent/white?" — vision models see transparent pixels as *white* and will
  falsely tell you the cutout failed, sending you into a pointless regeneration loop. If
  `hasAlpha` is true, the background is transparent, full stop.
- Use `analyze_image` only for **content/framing** questions your model can't see for itself
  — never for transparency. Ask a **pass/fail checklist, not "describe the image"**: a vision
  model will happily describe a wrong image in neutral words and you will misread it as
  success. e.g. `question: "Answer each with yes/no: (1) exactly ONE subject (a single
  top-down car), not a whole scene? (2) subject centered and not cut off? (3) no UI, track or
  other objects around it?"`. Any "no" → the content is wrong.
- If the *content* is wrong (wrong subject, cropped, bad framing): regenerate with a better
  prompt. If only the *processing* is off (`hasAlpha` false = background not removed, or too
  large): call `process_asset` on the saved path (preset `sprite`) — no regeneration needed.
- **If only the *orientation* is wrong, DON'T regenerate — rotate/flip it.** Top-down sprites
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

## Rules

- Ask the user before spending on generation if they haven't clearly asked for art — image
  generation costs money on their key.
- Never leave a raw, un-cut, full-size generation on a sprite node; that is what looks bad.
  sprite/icon presets exist precisely to avoid it.
