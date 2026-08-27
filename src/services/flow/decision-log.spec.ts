import { describe, expect, it } from 'vitest';

import {
  appendDecision,
  extractDecisionEntries,
  formatDecisionLine,
  sameQuestion,
  todayStamp,
} from './decision-log';

const DATE = '2026-08-28';

describe('todayStamp', () => {
  /**
   * The stamp is the user's calendar day, not UTC's. Caught live: a decision settled at 00:15
   * local, east of Greenwich, was filed as the previous day in a log the user reads as a diary.
   */
  it('uses the local calendar day, not the UTC one', () => {
    // 2026-08-28T00:15 in a UTC+3 zone is still 2026-08-27 in UTC.
    const justAfterLocalMidnight = new Date(2026, 7, 28, 0, 15);
    expect(todayStamp(justAfterLocalMidnight)).toBe('2026-08-28');
  });

  it('pads single-digit months and days', () => {
    expect(todayStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('formatDecisionLine', () => {
  it('writes the canonical one-liner', () => {
    expect(
      formatDecisionLine({
        question: 'Portrait or landscape?',
        choice: 'Portrait',
        reason: 'Matches the ad slot',
        rejected: ['landscape'],
        date: DATE,
      })
    ).toBe(
      `- **Portrait or landscape?** → Portrait. Matches the ad slot. _(rejected: landscape)_ — ${DATE}`
    );
  });

  it('omits every optional part rather than writing an empty one', () => {
    expect(
      formatDecisionLine({ question: 'Coop?', choice: 'Solo first', reason: '', date: DATE })
    ).toBe(`- **Coop?** → Solo first. — ${DATE}`);
  });

  it('normalises whitespace and strips markdown that would break the parse', () => {
    // A `*` inside the question would close the bold span early, and the line would stop reading
    // as a decision — silently, on the read side, which is the worst way for it to fail.
    const line = formatDecisionLine({
      question: 'Win by *score*\n  or timer?',
      choice: 'By `timer`',
      reason: '',
      date: DATE,
    });
    expect(line).toBe(`- **Win by score or timer?** → By timer. — ${DATE}`);
    expect(extractDecisionEntries(line)).toEqual([
      {
        question: 'Win by score or timer?',
        choice: 'By timer',
        reason: '',
        rejected: [],
        date: DATE,
      },
    ]);
  });

  it('does not double the sentence stop when the choice already ends in one', () => {
    expect(
      formatDecisionLine({ question: 'Q', choice: 'A.', reason: 'Because.', date: DATE })
    ).toBe(`- **Q** → A. Because. — ${DATE}`);
  });
});

describe('extractDecisionEntries', () => {
  it('round-trips what formatDecisionLine writes', () => {
    const entry = {
      question: 'How long is a run?',
      choice: 'About two minutes',
      reason: 'Matches an ad-break attention span',
      rejected: ['ten minutes', 'endless'],
      date: DATE,
    };
    expect(extractDecisionEntries(formatDecisionLine(entry))).toEqual([entry]);
  });

  it('still reads the block shape projects were seeded with before the tool existed', () => {
    const markdown = [
      '## Portrait or landscape?',
      '- **Chosen:** Portrait',
      '- **Why:** Ad slot',
    ].join('\n');
    expect(extractDecisionEntries(markdown)).toEqual([
      {
        question: 'Portrait or landscape?',
        choice: 'Portrait',
        reason: 'Ad slot',
        rejected: [],
        date: '',
      },
    ]);
  });

  it('ignores a fenced example, so a template never reads as a decision', () => {
    const markdown = [
      '# Decisions',
      '',
      '```',
      '## <the question>',
      '- **Chosen:** <the answer>',
      '```',
      '',
      `- **Coop?** → Local. — ${DATE}`,
    ].join('\n');
    expect(extractDecisionEntries(markdown).map(entry => entry.question)).toEqual(['Coop?']);
  });

  it('is empty for a log nobody has written to', () => {
    expect(extractDecisionEntries('# Decisions\n\nOne line per decision.\n')).toEqual([]);
  });
});

describe('appendDecision', () => {
  it('appends under whatever the file already holds', () => {
    const { text, replaced } = appendDecision(`# Decisions\n\n- **A?** → One. — ${DATE}\n`, {
      question: 'B?',
      choice: 'Two',
      reason: '',
      date: DATE,
    });
    expect(replaced).toBe(false);
    expect(extractDecisionEntries(text).map(entry => entry.question)).toEqual(['A?', 'B?']);
  });

  it('seeds a heading when there is no file yet', () => {
    const { text } = appendDecision('', { question: 'A?', choice: 'One', reason: '', date: DATE });
    expect(text.startsWith('# Decisions')).toBe(true);
    expect(extractDecisionEntries(text)).toHaveLength(1);
  });

  /**
   * The documented path, not a corner case: the answer to an `ask_user` question is filed by code
   * the moment it arrives, and the agent is then invited to add the reason it learned. Two lines
   * for one fork would have the planner read a contradiction.
   */
  it('replaces the entry for a fork already settled instead of stacking a second line', () => {
    const first = appendDecision('', {
      question: 'Coop?',
      choice: 'Solo first',
      reason: '',
      date: DATE,
    });
    const second = appendDecision(first.text, {
      question: 'coop',
      choice: 'Solo first',
      reason: 'Networking can wait',
      date: DATE,
    });
    expect(second.replaced).toBe(true);
    // The wording the user was actually asked survives the model's paraphrase.
    expect(extractDecisionEntries(second.text)).toEqual([
      {
        question: 'Coop?',
        choice: 'Solo first',
        reason: 'Networking can wait',
        rejected: [],
        date: DATE,
      },
    ]);
  });

  it('reports the line it wrote, so the tool result can show it back', () => {
    const { line } = appendDecision('', { question: 'A?', choice: 'One', reason: '', date: DATE });
    expect(line).toBe(`- **A?** → One. — ${DATE}`);
  });
});

describe('sameQuestion', () => {
  it('matches the same fork across casing and trailing punctuation', () => {
    expect(sameQuestion('Coop?', 'coop')).toBe(true);
    expect(sameQuestion('Portrait or landscape?', 'Portrait or landscape')).toBe(true);
  });

  it('does not merge two different forks', () => {
    expect(sameQuestion('Coop?', 'Co-op mode?')).toBe(false);
  });
});
