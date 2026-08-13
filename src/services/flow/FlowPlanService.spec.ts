import { describe, expect, it } from 'vitest';
import { parseChecklist } from './FlowPlanService';

describe('parseChecklist', () => {
  it('maps checkbox markers onto plan-step statuses', () => {
    const steps = parseChecklist(
      ['- [x] Controls', '- [~] Enemies', '- [ ] Win / lose', '- [ ] Art'].join('\n')
    );
    expect(steps.map(step => [step.title, step.status])).toEqual([
      ['Controls', 'done'],
      ['Enemies', 'active'],
      ['Win / lose', 'todo'],
      ['Art', 'todo'],
    ]);
  });

  it('treats a trailing "(in progress)" as the active increment', () => {
    const [step] = parseChecklist('- [ ] Enemies (in progress)');
    expect(step).toMatchObject({ title: 'Enemies', status: 'active' });
  });

  it('splits an em-dash tail into the note so the chip label stays short', () => {
    const [step] = parseChecklist('- [x] Enemies — proved with game_input, 3 waves spawn');
    expect(step.title).toBe('Enemies');
    expect(step.note).toBe('proved with game_input, 3 waves spawn');
  });

  it('ignores prose, headings and non-checklist bullets', () => {
    const steps = parseChecklist(
      ['# Progress', 'Some notes about the build.', '- just a bullet', '- [ ] Real item'].join('\n')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toBe('Real item');
  });

  it('accepts indented and asterisk-bulleted items (models write both)', () => {
    const steps = parseChecklist(['  - [X] Done thing', '* [ ] Pending thing'].join('\n'));
    expect(steps.map(step => step.status)).toEqual(['done', 'todo']);
  });
});

describe('parseChecklist — numbered plans', () => {
  it('reads a numbered plan an agent rewrote in its own words', () => {
    // Live regression: this exact file shape emptied the tracker to "No plan yet" while the agent
    // was reporting progress against it.
    const steps = parseChecklist(
      [
        '# Progress — Coin Tapper',
        '',
        '## Plan',
        '1. tap coins to score, basic spawn loop, timer countdown ← DONE (this turn)',
        '2. add bomb hazard that ends run early if tapped',
        '3. win/lose screens with score target and retry',
      ].join('\n')
    );

    expect(steps).toHaveLength(3);
    expect(steps[0].status).toBe('done');
    expect(steps[0].title).toBe('tap coins to score, basic spawn loop, timer countdown');
    expect(steps[1].status).toBe('todo');
  });

  it('reads a status wrapped in markdown emphasis', () => {
    // Live: `1. move snake ... — **DONE**` showed as todo with a stray `**` in the label.
    const steps = parseChecklist('1. move snake in four directions — **DONE**');

    expect(steps[0].status).toBe('done');
    expect(steps[0].title).toBe('move snake in four directions');
  });

  it('marks the step a numbered plan calls current', () => {
    const steps = parseChecklist('1. build the loop — DONE\n2. add bombs (in progress)');

    expect(steps.map(step => step.status)).toEqual(['done', 'active']);
  });

  it('still prefers real checkboxes when both shapes are present', () => {
    const steps = parseChecklist('- [x] shipped\n1. a numbered one');

    expect(steps.map(step => step.status)).toEqual(['done', 'todo']);
  });
});
