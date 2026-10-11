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
 *
 * This module is the detection only — pure string work, no DOM, no editor imports — so the two
 * enforcers share one definition: the editor's agent tools (`src/services/agent/emoji-as-art.ts`,
 * which owns the tool-facing refusal wording) and `pix3 validate` (`E_EMOJI_AS_ART`).
 */
/**
 * Property names that carry rendered text. A value is only judged when it lands on one of these —
 * an emoji in a node NAME, a file path or a script string is none of this guard's business.
 */
export declare const EMOJI_GUARDED_TEXT_PROPERTIES: ReadonlySet<string>;
/** True when the string, once the pictographs are removed, has nothing left to read. */
export declare const isEmojiOnlyText: (value: string) => boolean;
/** Whether this property is one whose value gets drawn as text on screen. */
export declare const isTextProperty: (propertyPath: string) => boolean;
/**
 * Emoji-only text values written directly into a `.pix3scene`, as `property: value` pairs.
 *
 * Returns every offending line, because a scene write is wholesale: telling the agent about the
 * first one only would have it fix one and resubmit.
 */
export declare const findEmojiArtInSceneYaml: (yaml: string) => Array<{
    property: string;
    value: string;
}>;
