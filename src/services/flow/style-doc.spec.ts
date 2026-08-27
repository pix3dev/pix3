import { describe, expect, it } from 'vitest';

import { parseStylePalette } from './PrototypeBootstrapService';
import { STYLE_DECISION_QUESTION, renderStyleFromReference } from './style-doc';

const base = {
  title: 'Ant Strategy',
  referencePath: 'references/mood-2.png',
  caption: 'flat vector, warm dusk palette',
  palette: ['#2b1a0e', '#8a5a2b', '#e8c07d'],
};

describe('renderStyleFromReference', () => {
  /**
   * The load-bearing assertion of this module: the transition reads the palette back out of the
   * document to tint the recipe's placeholder art. A prettier line that `parseStylePalette` cannot
   * read would fail silently, as a project that expands grey.
   */
  it('writes a palette line the transition can read back', () => {
    expect(parseStylePalette(renderStyleFromReference(base))).toEqual(base.palette);
  });

  it('names the image the style came from', () => {
    const doc = renderStyleFromReference(base);
    expect(doc).toContain('`references/mood-2.png`');
    expect(doc).toContain('flat vector, warm dusk palette');
    expect(doc).toContain('# Style — Ant Strategy');
  });

  it('drops the look line rather than writing an empty one', () => {
    expect(renderStyleFromReference({ ...base, caption: '' })).not.toContain('**Look:**');
  });

  it('says so honestly when no colour could be measured', () => {
    const doc = renderStyleFromReference({ ...base, palette: [] });
    expect(doc).toContain('(none measured)');
    expect(parseStylePalette(doc)).toEqual([]);
  });
});

describe('STYLE_DECISION_QUESTION', () => {
  /**
   * Constant so that changing your mind about the look REPLACES the decision-log line instead of
   * leaving a log that names two styles — see `appendDecision`.
   */
  it('is a fixed question, not derived from the file', () => {
    expect(STYLE_DECISION_QUESTION).toBe('Visual style');
  });
});
