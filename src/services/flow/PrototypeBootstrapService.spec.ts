import { describe, expect, it } from 'vitest';

import {
  extractJsonObject,
  fallbackBrief,
  deriveTitle,
  renderBriefMarkdown,
  renderProgressMarkdown,
  summarizeDocument,
  validateBrief,
  FALLBACK_RECIPE_ID,
} from './PrototypeBootstrapService';
import { parseChecklist } from './FlowPlanService';
import { resolveTunables, type RecipeTunable } from './recipe-contract';

/**
 * The planner is the one place in Flow where a model's output is load-bearing, and not every
 * provider honours a structured-output request — so the contract under test is that NOTHING a model
 * can emit stops a project from being created. Every case here is a real failure shape: fenced
 * output, a preamble, prose instead of JSON, a hallucinated recipe id, wrong types.
 */
describe('extractJsonObject', () => {
  it('reads a bare JSON object', () => {
    expect(extractJsonObject('{"title":"Bubbles"}')).toEqual({ title: 'Bubbles' });
  });

  it('strips markdown fences', () => {
    expect(extractJsonObject('```json\n{"title":"Bubbles"}\n```')).toEqual({ title: 'Bubbles' });
  });

  it('finds the object inside a preamble and a trailing explanation', () => {
    const raw = 'Sure! Here is the brief:\n{"title":"Bubbles"}\nLet me know if you want changes.';
    expect(extractJsonObject(raw)).toEqual({ title: 'Bubbles' });
  });

  it('keeps braces that appear inside strings', () => {
    const raw = '{"pitch":"pop {every} bubble","title":"B"}';
    expect(extractJsonObject(raw)).toEqual({ pitch: 'pop {every} bubble', title: 'B' });
  });

  it('matches the outermost object, not the first nested one', () => {
    const parsed = extractJsonObject('{"style":{"mood":"calm"},"title":"B"}');
    expect(parsed).toEqual({ style: { mood: 'calm' }, title: 'B' });
  });

  it('recovers the brief from a model that wrapped it in an array', () => {
    expect(extractJsonObject('[{"title":"B"}]')).toEqual({ title: 'B' });
  });

  it('returns null for prose, empty output and truncated JSON', () => {
    expect(extractJsonObject('I would build a tapper.')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('{"title":"B"')).toBeNull();
  });
});

describe('validateBrief', () => {
  const wellFormed = {
    title: 'Bubble Pop',
    pitch: 'Pop bubbles before the timer runs out.',
    recipeId: 'recipe-tapper-2d',
    style: { palette: ['#101820', '#F5AE39'], artStyle: 'flat vector', mood: 'playful' },
    entities: [
      { role: 'player', name: 'Cursor', assetSpec: { prompt: 'a finger', sizeHint: 96 } },
      { role: 'collectible', name: 'Bubble', assetSpec: { prompt: 'a soap bubble' } },
    ],
    tunables: { spawnRate: 2.5, bgColor: '#101820' },
    winLose: { win: 'Pop 50 bubbles', lose: 'Timer hits zero' },
    increments: ['tap to pop', 'timer', 'win screen'],
  };

  it('passes a well-formed brief through unchanged', () => {
    const { brief, issues } = validateBrief(wellFormed, 'a bubble tapper');

    expect(issues).toEqual([]);
    expect(brief.recipeId).toBe('recipe-tapper-2d');
    expect(brief.style.palette).toEqual(['#101820', '#F5AE39']);
    expect(brief.entities).toHaveLength(2);
    expect(brief.entities[0].assetSpec.sizeHint).toBe(96);
    expect(brief.tunables).toEqual({ spawnRate: 2.5, bgColor: '#101820' });
    expect(brief.increments).toEqual(['tap to pop', 'timer', 'win screen']);
  });

  it('falls back to the arena recipe when the planner invents an id', () => {
    const { brief, issues } = validateBrief(
      { ...wellFormed, recipeId: 'recipe-metroidvania-3d' },
      'a bubble tapper'
    );

    expect(brief.recipeId).toBe(FALLBACK_RECIPE_ID);
    expect(issues.join(' ')).toContain('recipe-metroidvania-3d');
  });

  it('falls back when the recipe id is missing entirely', () => {
    const { recipeId, ...withoutRecipe } = wellFormed;
    void recipeId;
    const { brief, issues } = validateBrief(withoutRecipe, 'a bubble tapper');

    expect(brief.recipeId).toBe(FALLBACK_RECIPE_ID);
    expect(issues.join(' ')).toContain('no recipeId');
  });

  it('drops tunables whose value is not a scalar rather than coercing them', () => {
    const { brief, issues } = validateBrief(
      { ...wellFormed, tunables: { speed: 400, waves: { count: 3 }, hard: true, name: 'fast' } },
      'a bubble tapper'
    );

    expect(brief.tunables).toEqual({ speed: 400, hard: true, name: 'fast' });
    expect(issues.join(' ')).toContain('waves');
  });

  it('keeps only real hex colours in the palette', () => {
    const { brief } = validateBrief(
      { ...wellFormed, style: { palette: ['#fff', 'cornflower', 42, '#123456'] } },
      'a bubble tapper'
    );

    expect(brief.style.palette).toEqual(['#fff', '#123456']);
    expect(brief.style.artStyle).toBe('');
  });

  it('skips entities that are missing a name or a role', () => {
    const { brief } = validateBrief(
      {
        ...wellFormed,
        entities: [
          { role: 'player', name: 'Hero', assetSpec: { prompt: 'a hero' } },
          { role: 'enemy' },
          'a bat',
          { name: 'Bat' },
        ],
      },
      'a bubble tapper'
    );

    expect(brief.entities.map(entity => entity.name)).toEqual(['Hero']);
  });

  it('substitutes the default checklist when the planner returns no increments', () => {
    const { brief, issues } = validateBrief({ ...wellFormed, increments: [] }, 'a bubble tapper');

    expect(brief.increments).toEqual(fallbackBrief('a bubble tapper').increments);
    expect(issues.join(' ')).toContain('no increments');
  });

  it('survives a reply where every single field is the wrong type', () => {
    const { brief, issues } = validateBrief(
      {
        title: 42,
        pitch: null,
        recipeId: [],
        style: 'colourful',
        entities: 'a hero and a bat',
        tunables: 'fast',
        winLose: 'score 50',
        increments: 'do everything',
      },
      'сделай тапалку про монетки'
    );

    // Garbage in, still a usable brief out: the prompt survives as the title/pitch and the flow
    // continues with the fallback recipe.
    expect(brief.recipeId).toBe(FALLBACK_RECIPE_ID);
    expect(brief.title).toBe(deriveTitle('сделай тапалку про монетки'));
    expect(brief.pitch).toContain('тапалку');
    expect(brief.style.palette).toEqual([]);
    expect(brief.entities).toEqual([]);
    expect(brief.tunables).toEqual({});
    expect(brief.increments).toHaveLength(4);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('deriveTitle', () => {
  it('takes the first few words and capitalizes them', () => {
    expect(deriveTitle('a runner with obstacles and coins and more')).toBe(
      'A runner with obstacles and'
    );
  });

  it('never returns an empty title', () => {
    expect(deriveTitle('   ')).toBe('New Prototype');
  });
});

describe('summarizeDocument', () => {
  it('passes a short document through whole', () => {
    expect(summarizeDocument('# GDD\n\nMatch three gems.')).toBe('# GDD\n\nMatch three gems.');
  });

  it('budgets a long document down to an excerpt plus its outline', () => {
    const body = 'x'.repeat(500);
    const doc = ['# GDD', body, '## Mechanics', body, '## Balance', body].join('\n');

    const summary = summarizeDocument(doc, 400);

    // The whole point: a 20-page GDD never reaches the prompt in full (design §5.7).
    expect(summary.length).toBeLessThan(500);
    expect(summary).toContain('OUTLINE:');
    expect(summary).toContain('## Mechanics');
    expect(summary).toContain('## Balance');
  });
});

describe('generated design docs', () => {
  const brief = fallbackBrief('a coin tapper');

  it('writes a progress checklist FlowPlanService can parse, with exactly one active step', () => {
    const steps = parseChecklist(renderProgressMarkdown(brief));

    expect(steps).toHaveLength(brief.increments.length);
    expect(steps.filter(step => step.status === 'active')).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'active', title: 'Controls and the core loop' });
    expect(steps[1].status).toBe('todo');
  });

  it('writes a brief whose title and pitch lines the Flow header can read back', () => {
    const markdown = renderBriefMarkdown(
      brief,
      'a coin tapper',
      { applied: [], unknown: [], rejected: [] },
      []
    );

    expect(markdown).toMatch(/^# A coin tapper$/m);
    expect(markdown).toMatch(/^\*\*Pitch:\*\* a coin tapper$/m);
  });

  it('records unknown tunables for the agent instead of applying them', () => {
    const declared = new Map<string, RecipeTunable>([
      ['playerSpeed', { key: 'playerSpeed', node: 'player', property: 'speed', min: 100, max: 900 }],
    ]);
    const resolution = resolveTunables({ playerSpeed: 5000, enemyWaves: 3 }, declared);

    const markdown = renderBriefMarkdown(brief, 'a coin tapper', resolution, ['a bootstrap note']);

    expect(markdown).toContain('`playerSpeed` = 900 (clamped from 5000)');
    expect(markdown).toContain('For the agent — asked for, not applied');
    expect(markdown).toContain('`enemyWaves`: 3');
    expect(markdown).toContain('- a bootstrap note');
  });
});
