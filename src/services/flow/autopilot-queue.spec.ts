import { describe, expect, it } from 'vitest';

import {
  parseAutopilotSteps,
  renderAutopilotTurnMessage,
  selectNextStep,
  selectNextStepFromProgress,
  upsertSmokeFix,
  type AutopilotStep,
} from './autopilot-queue';
import type { FlowPlan } from './FlowPlanService';

/** A progress file in the shape `renderProgressMarkdown` writes it. */
const progress = (body: string): string =>
  ['# Progress — Sky Defender', '', 'One increment per turn.', '', body, ''].join('\n');

const titles = (steps: readonly AutopilotStep[]): string[] => steps.map(step => step.title);

describe('upsertSmokeFix', () => {
  it('records a P0, deduplicates it, and reopens a prematurely ticked defect', () => {
    const first = upsertSmokeFix(
      progress('- [x] drone flies'),
      'Runtime error at frame 12',
      'design/tests/r1.json',
      'runtime:game:wave crash',
      'scene-a1'
    );
    expect(first.markdown).toContain('## Found by playtest');
    expect(first.markdown).toContain('[source:scene-a1]');
    expect(selectNextStepFromProgress(first.markdown).step?.kind).toBe('fix-p0');
    const ticked = first.markdown.replace('- [ ] FIX', '- [x] FIX');
    const second = upsertSmokeFix(
      ticked,
      'Runtime error at frame 25',
      'design/tests/r2.json',
      'runtime:game:wave crash',
      'scene-b2'
    );
    expect(second.attempts).toBe(1);
    expect(second.signature).toBe(first.signature);
    expect(second.markdown.match(/FIX \(P0\)/g)).toHaveLength(1);
    expect(second.markdown).toContain('design/tests/r2.json');
    expect(second.markdown).toContain('[source:scene-b2]');
    expect(selectNextStepFromProgress(second.markdown).step?.kind).toBe('fix-p0');
    expect(
      upsertSmokeFix(second.markdown, 'Runtime error at frame 31', null, 'runtime:game:wave crash')
        .attempts
    ).toBe(2);
  });
});

describe('parseAutopilotSteps', () => {
  it('drops finished items and keeps the rest in file order', () => {
    const steps = parseAutopilotSteps(
      progress(['- [x] drone flies', '- [~] drone shoots', '- [ ] enemies spawn'].join('\n'))
    );
    expect(titles(steps)).toEqual(['drone shoots', 'enemies spawn']);
    expect(steps.map(step => step.kind)).toEqual(['active', 'todo']);
  });

  it('reads the spectacle beats as their own class, from the prose lead-in alone', () => {
    // The bootstrap writes no heading above them — just the "Spectacle beats…" sentence — so a
    // parser that only looked for `##` would rank an explosion above the unbuilt core loop.
    const steps = parseAutopilotSteps(
      progress(
        [
          '- [ ] enemies spawn',
          '',
          'Spectacle beats for the later increments. Fold one in whenever it is a one-liner.',
          '',
          '- [ ] screen shake on a kill',
        ].join('\n')
      )
    );
    expect(steps.map(step => step.kind)).toEqual(['todo', 'wow']);
  });

  it('reads a playtest defect and strips the FIX prefix from its title', () => {
    const steps = parseAutopilotSteps(
      progress(
        [
          '- [ ] enemies spawn',
          '',
          '## Found by playtest',
          '',
          '- [ ] FIX: the screen pulses red forever after a loss — design/tests/reports/r1.json',
        ].join('\n')
      )
    );
    expect(steps[1]).toMatchObject({
      kind: 'fix-p0',
      title: 'the screen pulses red forever after a loss',
      note: 'design/tests/reports/r1.json',
    });
  });

  it.each([
    ['- [ ] FIX(P1): the coin reads as a button', 'fix-p1'],
    ['- [ ] FIX P1: the coin reads as a button', 'fix-p1'],
    ['- [ ] FIX(P0): it crashes on the second wave', 'fix-p0'],
    // No class marker at all is the format the plan documents — and it defaults to P0, because
    // being wrong that way costs one early increment and being wrong the other way ships a crash.
    ['- [ ] FIX: it crashes on the second wave', 'fix-p0'],
  ])('classes %s as %s', (line, kind) => {
    expect(parseAutopilotSteps(progress(line))[0].kind).toBe(kind);
  });

  it('reads the numbered checklist models keep rewriting the file into', () => {
    const steps = parseAutopilotSteps(
      progress(['1. drone flies ← DONE', '2. drone shoots'].join('\n'))
    );
    expect(titles(steps)).toEqual(['drone shoots']);
  });
});

describe('selectNextStep', () => {
  const step = (kind: AutopilotStep['kind'], title: string): AutopilotStep => ({
    kind,
    title,
    status: kind === 'active' ? 'active' : 'todo',
  });

  it('takes a P0 defect ahead of everything else', () => {
    const selection = selectNextStep([
      step('active', 'half-built mechanic'),
      step('fix-p0', 'crashes on wave two'),
    ]);
    expect(selection.step?.title).toBe('crashes on wave two');
  });

  /**
   * An unfinished `- [~]` is the increment the verify gate would not let close honestly. Starting a
   * fresh one on top of it is how a prototype ends up with two half-built mechanics and no proof
   * for either.
   */
  it('finishes the item already in progress before starting a new one', () => {
    const selection = selectNextStep([step('todo', 'enemies'), step('active', 'shooting')]);
    expect(selection.step?.title).toBe('shooting');
  });

  it('ranks a P1 defect below the main list and above the spectacle beats', () => {
    expect(
      selectNextStep([step('wow', 'screen shake'), step('fix-p1', 'coin reads as a button')]).step
        ?.title
    ).toBe('coin reads as a button');
    expect(selectNextStep([step('wow', 'screen shake'), step('todo', 'enemies')]).step?.title).toBe(
      'enemies'
    );
  });

  it('reports an empty queue as done rather than as an error', () => {
    expect(selectNextStep([])).toEqual({ step: null, done: true, ready: true });
  });

  it('reports ready when only optional spectacle or P1 work remains', () => {
    const selection = selectNextStep([step('wow', 'screen shake'), step('fix-p1', 'dim coin')]);
    expect(selection.ready).toBe(true);
    expect(selection.done).toBe(false);
    expect(selection.step?.kind).toBe('fix-p1');
  });

  it('reports done for a checklist whose every item is ticked', () => {
    expect(selectNextStepFromProgress(progress('- [x] drone flies')).done).toBe(true);
  });
});

describe('renderAutopilotTurnMessage', () => {
  const plan: FlowPlan = { title: 'Sky Defender', pitch: 'shoot down the swarm', steps: [] };

  it('asks for one increment, proven in the running game, written back to the checklist', () => {
    const message = renderAutopilotTurnMessage(
      { kind: 'todo', status: 'todo', title: 'enemies spawn in waves' },
      plan
    );
    expect(message).toContain('[Autopilot]');
    expect(message).toContain('enemies spawn in waves');
    expect(message).toContain('only this one');
    expect(message).toContain('game_run');
    expect(message).toContain('design/progress.md');
    // The instruction that only exists because nobody is watching: choose the small things.
    expect(message).toContain('Decide the small things yourself');
  });

  it('frames a playtest item as a defect to fix, not an increment to build', () => {
    const message = renderAutopilotTurnMessage(
      { kind: 'fix-p0', status: 'todo', title: 'the screen pulses red forever', note: 'r1.json' },
      plan
    );
    expect(message).toContain('Fix this defect');
    expect(message).toContain('r1.json');
  });

  it('survives a project whose brief has no title yet', () => {
    const message = renderAutopilotTurnMessage(
      { kind: 'todo', status: 'todo', title: 'x' },
      {
        title: null,
        pitch: null,
        steps: [],
      }
    );
    expect(message).not.toContain('null');
  });
});
