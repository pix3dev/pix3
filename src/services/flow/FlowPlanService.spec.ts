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
