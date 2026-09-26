/**
 * Emoji are never game art — the agent-tool side of the rule.
 *
 * The detection (what counts as "nothing but emoji", which properties carry rendered text, the raw
 * YAML scan) lives in `@pix3/runtime` (`core/emoji-as-art.ts`) so `pix3 validate` enforces exactly
 * the same rule outside the editor. This file keeps what is specific to the agent tools: the
 * refusal sentence, which names the tools the model should reach for instead.
 */
import { isEmojiOnlyText, isTextProperty } from '@pix3/runtime';

export { findEmojiArtInSceneYaml, isEmojiOnlyText, isTextProperty } from '@pix3/runtime';

export const emojiAsArtRefusal = (propertyPath: string, value: string): string =>
  `Refused: "${propertyPath}" would be ${value.trim()} — an emoji used as artwork. Emoji are not art: every platform draws a different picture (the same codepoint is a different coin on Apple, Google, Samsung and Windows), they cannot be recoloured, atlased, animated or art-directed, and a device without that codepoint shows a hollow box. Use a real image: generate_asset a sprite and put it on a Sprite2D (or a Button2D's textureNormal/Hover/Pressed). If you need a placeholder RIGHT NOW, a ColorRect2D of the right size and colour is an honest one — it reads as unfinished instead of pretending to be finished. An emoji INSIDE a sentence ("Счёт: 10 🪙") is fine; a label that is nothing but emoji is a picture.`;

/**
 * The refusal for a property write, or null when there is nothing to refuse.
 *
 * Shared by `set_property`, `create_node` and `set_component_property` so the rule cannot be reached
 * around by picking a different tool.
 */
export const emojiAsArtError = (propertyPath: string, value: unknown): string | null => {
  if (typeof value !== 'string' || !isTextProperty(propertyPath)) return null;
  return isEmojiOnlyText(value) ? emojiAsArtRefusal(propertyPath, value) : null;
};
