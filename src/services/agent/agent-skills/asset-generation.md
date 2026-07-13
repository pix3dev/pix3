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
  assets share one look. Also pass the reference file path(s) in the `references` array.

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

- The tool returns a preview image and the original→saved sizes. If your model can see
  images, look at the preview. If not, call `analyze_image` on the saved path with
  `question: "is the subject cleanly cut out with a transparent background, centered and not
  cropped? any leftover background or halo?"`.
- If it looks wrong (leftover background, too big, not cropped): call `process_asset` on the
  saved path with an explicit preset (usually `sprite`) to reprocess in place — no need to
  regenerate. Regenerate only if the *content* is wrong.
- **Apply it to a node**: find the node (`find_nodes` / `scene_tree`), then `set_property` its
  texture/skin property to the saved `res://…` path. Common targets: `Sprite2D.texture`,
  `ColorRect2D` → swap for a `Sprite2D`, `Button2D` state skins (normal/hover/pressed/
  disabled), panel/background skins. Use `node_inspect` to see the exact property names.

## 5. Batch related icons cheaply

Need several small icons in one style? Generate them one at a time with the same style tokens
and the `icon` preset — consistent size and framing make them drop into a grid cleanly.

## Rules

- Ask the user before spending on generation if they haven't clearly asked for art — image
  generation costs money on their key.
- Never leave a raw, un-cut, full-size generation on a sprite node; that is what looks bad.
  sprite/icon presets exist precisely to avoid it.
