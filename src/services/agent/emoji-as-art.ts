/**
 * Emoji are never game art.
 *
 * `AGENTS.md` has banned emoji in editor chrome since the icon system shipped, with a carve-out for
 * "user-authored content". A generated game fell through that gap: an agent built a coin-tapper
 * whose coin was a `Button2D` with `label: 🪙` at 140px sitting on a stock blue button skin. It is
 * content by the letter of the rule and a placeholder by any other measure — it renders differently
 * on every platform (Apple, Google, Microsoft and Samsung all draw a different coin), it cannot be
 * recoloured, scaled cleanly, animated, atlased or art-directed, and on a machine missing that
 * codepoint it is a hollow box.
 *
 * **What is refused is narrow on purpose: text that is ONLY emoji.** A label reading "Счёт: 10 🪙"
 * is content — a person wrote that sentence and the emoji is punctuation in it. A label that is
 * nothing but emoji is a picture, and a picture belongs in a sprite. The distinction is mechanical,
 * so the guard can be enforced by the harness instead of hoped for in a prompt: a rule the harness
 * does not enforce is a rule that holds only when the model feels like it.
 */

/**
 * What counts as "a picture, not text".
 *
 * Unicode's own property is the right tool here: `Extended_Pictographic` is precisely the set of
 * codepoints meant to be drawn as an image, which also catches the symbol glyphs `AGENTS.md` already
 * bans as icons (▶ ⏸ ●). Deliberately outside it and therefore still text: arrows (→), currency,
 * punctuation, box-drawing and CJK — a label may legitimately consist of those.
 */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const PICTOGRAPH_GLOBAL = /\p{Extended_Pictographic}/gu;

/**
 * Everything that may sit between pictographs without making the string readable text: whitespace,
 * the variation selector and zero-width joiner that fuse a sequence into one glyph, skin-tone and
 * gender modifiers, and the keycap mark. Written as an alternation rather than a character class —
 * these combine with their neighbours, and a class of combining marks is a lint error for good
 * reason (it matches halves of a grapheme).
 */
const FILLER = /\s|\u{FE0F}|\u{200D}|\u{20E3}|\u{FE0E}|\p{Emoji_Modifier}|\p{Emoji_Component}/gu;

/**
 * Property names that carry rendered text. A value is only judged when it lands on one of these —
 * an emoji in a node NAME, a file path or a script string is none of this guard's business.
 */
const TEXT_PROPERTIES: ReadonlySet<string> = new Set([
  'label',
  'text',
  'placeholder',
  'title',
  'caption',
  'buttonText',
  'labelText',
  'content',
]);

/** True when the string, once the pictographs are removed, has nothing left to read. */
export const isEmojiOnlyText = (value: string): boolean => {
  if (!PICTOGRAPH.test(value)) return false;
  const remainder = value.replace(PICTOGRAPH_GLOBAL, '').replace(FILLER, '');
  return remainder.trim().length === 0;
};

/** Whether this property is one whose value gets drawn as text on screen. */
export const isTextProperty = (propertyPath: string): boolean =>
  TEXT_PROPERTIES.has(propertyPath.split('.').pop() ?? propertyPath);

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

/** `label: 🪙` written straight into scene YAML — the path that bypasses every property setter. */
const YAML_TEXT_LINE = new RegExp(
  `^\\s*(${[...TEXT_PROPERTIES].join('|')}):\\s*(?:"([^"]*)"|'([^']*)'|(.+?))\\s*$`,
  'gmu'
);

/**
 * Emoji-only text values written directly into a `.pix3scene`, as `property: value` pairs.
 *
 * Returns every offending line, because a scene write is wholesale: telling the agent about the
 * first one only would have it fix one and resubmit.
 */
export const findEmojiArtInSceneYaml = (
  yaml: string
): Array<{ property: string; value: string }> => {
  const found: Array<{ property: string; value: string }> = [];
  for (const match of yaml.matchAll(YAML_TEXT_LINE)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (isEmojiOnlyText(value)) found.push({ property: match[1], value: value.trim() });
  }
  return found;
};
