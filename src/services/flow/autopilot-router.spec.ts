import { describe, expect, it } from 'vitest';

import { routeQuestion } from './autopilot-router';
import type { DecisionEntry } from './decision-log';

const decision = (
  entry: Partial<DecisionEntry> & { question: string; choice: string }
): DecisionEntry => ({
  reason: '',
  rejected: [],
  date: '2026-09-20',
  ...entry,
});

describe('routeQuestion — step 1, the fork is already settled', () => {
  /**
   * The free win the plan calls out: after a compaction the model re-asks what the user answered
   * an hour ago, and the log is the only place that answer survived.
   */
  it('replays a logged choice even when the wording drifted', () => {
    expect(
      routeQuestion({
        question: 'coop',
        options: ['local', 'online'],
        decisions: [decision({ question: 'Coop?', choice: 'local' })],
        briefText: '',
      })
    ).toEqual({ choice: 'local', source: 'user', via: 'decision-log' });
  });

  it('keeps the provenance of the original line instead of restamping it', () => {
    // A replay writes nothing; if the caller ever did record it, it must not turn an autopilot
    // decision into a decision "the user made".
    expect(
      routeQuestion({
        question: 'Win by score or timer?',
        options: ['by score', 'by timer'],
        decisions: [
          decision({
            question: 'Win by score or timer?',
            choice: 'by score',
            source: 'auto-brief',
          }),
        ],
        briefText: '',
      })
    ).toMatchObject({ source: 'auto-brief', via: 'decision-log' });
  });

  it('does not treat a different fork as the same one', () => {
    expect(
      routeQuestion({
        question: 'Co-op mode?',
        options: ['yes', 'no'],
        decisions: [decision({ question: 'Coop?', choice: 'local' })],
        briefText: '',
      })
    ).toBeNull();
  });
});

describe('routeQuestion — step 2, the brief already says it', () => {
  it('answers with the option the brief spells out', () => {
    expect(
      routeQuestion({
        question: 'Win by score or by timer?',
        options: ['by score', 'by timer'],
        decisions: [],
        briefText: 'A one-minute arcade run. The player wins by score, not by surviving.',
      })
    ).toEqual({ choice: 'by score', source: 'auto-brief', via: 'brief' });
  });

  /**
   * The `ask_user` contract is "guessing wrong means rebuilding". Two options the brief mentions
   * equally is exactly that case, and an answer picked between them would be filed in the decision
   * log as though it had been reasoned.
   */
  it('refuses to choose when the brief mentions both options', () => {
    expect(
      routeQuestion({
        question: 'Waves or endless?',
        options: ['waves', 'endless'],
        decisions: [],
        briefText: 'Endless play, broken up by waves of enemies.',
      })
    ).toBeNull();
  });

  it('refuses when the brief says nothing about any option', () => {
    expect(
      routeQuestion({
        question: 'Portrait or landscape?',
        options: ['portrait', 'landscape'],
        decisions: [],
        briefText: 'A cozy tapper about feeding cats.',
      })
    ).toBeNull();
  });

  it('matches whole words, so "timer" is not answered by "timescale"', () => {
    expect(
      routeQuestion({
        question: 'Score or timer?',
        options: ['timer'],
        decisions: [],
        briefText: 'The recipe exposes a timescale tunable.',
      })
    ).toBeNull();
  });

  it('ignores common words, so an option is never carried by "по" or "the" alone', () => {
    expect(
      routeQuestion({
        question: 'Победа по счёту или по времени?',
        options: ['по счёту', 'по времени'],
        decisions: [],
        briefText: 'Аркада на минуту. Побеждает тот, у кого больше счёт.',
      })
    ).toEqual({ choice: 'по счёту', source: 'auto-brief', via: 'brief' });
  });

  it('has nothing to match against for a free-form question', () => {
    expect(
      routeQuestion({
        question: 'What should the boss be called?',
        options: [],
        decisions: [],
        briefText: 'A space shooter.',
      })
    ).toBeNull();
  });
});

describe('routeQuestion — step 3, the advisor (the shape phase C fills in)', () => {
  it('honours an advisor pick that names one of the offered options', () => {
    expect(
      routeQuestion({
        question: 'Waves or endless?',
        options: ['waves', 'endless'],
        decisions: [],
        briefText: 'Endless play, broken up by waves of enemies.',
        advisorChoice: 'endless',
      })
    ).toEqual({ choice: 'endless', source: 'auto-advisor', via: 'advisor' });
  });

  it('ignores an advisor that answered in prose instead of naming an option', () => {
    expect(
      routeQuestion({
        question: 'Waves or endless?',
        options: ['waves', 'endless'],
        decisions: [],
        briefText: '',
        advisorChoice: 'I would go with something in between',
      })
    ).toBeNull();
  });
});
