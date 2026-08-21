import { describe, expect, it } from 'vitest';
import {
  FLOW_BRIEF_PATH,
  FLOW_GDD_PATH,
  FLOW_PROGRESS_PATH,
  FlowPlanService,
  parseChecklist,
} from './FlowPlanService';

/** A FlowPlanService reading from an in-memory project instead of the real storage service. */
const planServiceOver = (files: Record<string, string>): FlowPlanService => {
  const service = new FlowPlanService();
  Object.defineProperty(service, 'storage', {
    value: {
      readTextFile: async (path: string) => {
        const contents = files[path];
        if (contents === undefined) {
          throw new Error(`no such file: ${path}`);
        }
        return contents;
      },
    },
    configurable: true,
  });
  return service;
};

describe('FlowPlanService.load', () => {
  it('takes the header title from the brief when there is one', async () => {
    const plan = await planServiceOver({
      [FLOW_BRIEF_PATH]: '# Coin Tapper\n\n**Pitch:** tap the coins\n',
      [FLOW_PROGRESS_PATH]: '- [~] Controls\n',
    }).load();

    expect(plan.title).toBe('Coin Tapper');
    expect(plan.pitch).toBe('tap the coins');
    expect(plan.steps).toHaveLength(1);
  });

  it('falls back to the design document at the idea stage, where no brief exists', async () => {
    // There is no recipe and no planner run yet, so `brief.md` is absent — without this fallback the
    // header would show the derived project name instead of the game the two of them are naming.
    const plan = await planServiceOver({
      [FLOW_GDD_PATH]: '# Ant Wars\n\n**Pitch:** _to be filled_\n\n## Concept\n',
    }).load();

    expect(plan.title).toBe('Ant Wars');
    // The pitch stays a brief-only field: the seeded placeholder is not a pitch.
    expect(plan.pitch).toBeNull();
    expect(plan.steps).toEqual([]);
  });

  it('is empty when the project has none of the three documents', async () => {
    const plan = await planServiceOver({}).load();
    expect(plan).toEqual({ pitch: null, title: null, steps: [] });
  });
});

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
