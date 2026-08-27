/**
 * `design/style.md`, written from a chosen style reference — the deterministic half of the
 * moodboard (design §3.9).
 *
 * Picking a style is a UI action, not a turn: the user clicks one candidate, the palette is
 * quantized out of that image, and this renders the document. No model is asked what the colours
 * are, because quantization is exact and free while a guess is neither — the same reasoning
 * `extractPalette` is built on.
 *
 * The one hard constraint is the `- **Palette:**` line: `parseStylePalette` reads it at the
 * idea → prototype transition to tint the recipe's placeholder art, so the shape here has to match
 * what `renderStyleMarkdown` (the brief-driven writer) emits. Both are pinned by spec.
 */

/** Where the style document lives. Shared with the bootstrap's `FLOW_STYLE_PATH`. */
export const STYLE_DOC_PATH = 'design/style.md';

/**
 * The decision-log question a style choice is filed under.
 *
 * Constant on purpose: `record_decision` replaces the entry for a fork already settled, so changing
 * your mind about the look updates one line instead of leaving a log that names two styles.
 */
export const STYLE_DECISION_QUESTION = 'Visual style';

export interface StyleFromReference {
  /** Project title, for the heading. */
  readonly title: string;
  /** Project-relative path of the chosen image, e.g. `references/mood-2.png`. */
  readonly referencePath: string;
  /** What the candidate was generated from, when the index recorded it. */
  readonly caption: string;
  /** `#rrggbb` swatches measured from the image, strongest first. */
  readonly palette: readonly string[];
}

/**
 * The image the style document currently points at, or null.
 *
 * This is what makes "make it the style" idempotent across a change of mind: the file named here is
 * the one a previous click promoted, so it is the one — and the only one — safe to demote when a
 * new candidate wins. Anything else carrying the `style` role was set by the user's own role chip
 * and is not this action's to take away.
 */
export const parseStyleReference = (markdown: string): string | null =>
  /^[ \t]*[-*][ \t]*\*\*Reference:\*\*[ \t]*`([^`]+)`/im.exec(markdown)?.[1]?.trim() ?? null;

/** `design/style.md` for a style chosen from the references column. */
export const renderStyleFromReference = (input: StyleFromReference): string => {
  const palette = input.palette.length > 0 ? input.palette.join(', ') : '(none measured)';
  return [
    `# Style — ${input.title}`,
    '',
    'Paste these tokens into every `generate_asset` prompt so the art stays one set.',
    '',
    `- **Palette:** ${palette}`,
    `- **Reference:** \`${input.referencePath}\``,
    ...(input.caption ? [`- **Look:** ${input.caption}`] : []),
    '',
    `Chosen from the moodboard: the palette was measured from \`${input.referencePath}\`, not`,
    'guessed, so it is exactly the image the user picked.',
    '',
    'Use the tokens as WORDS. Pass the reference image to the generator only for the one asset it',
    'depicts — a full scene handed over as a reference comes back as a copied composition.',
    '',
  ].join('\n');
};
