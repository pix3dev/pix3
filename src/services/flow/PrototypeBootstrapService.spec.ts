import { describe, expect, it } from 'vitest';

import {
  buildPlannerPrompt,
  defaultThemeForRecipe,
  effectiveTheme,
  extractJsonObject,
  fallbackBrief,
  deriveTitle,
  renderBriefMarkdown,
  renderFirstTurnMessage,
  renderProgressMarkdown,
  renderStyleMarkdown,
  summarizeDocument,
  themedTunables,
  validateBrief,
  DEFAULT_THEME,
  FALLBACK_RECIPE_ID,
  FALLBACK_3D_RECIPE_ID,
  PLANNER_SYSTEM_PROMPT,
  THEME_TUNABLES,
  type PrototypeBrief,
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
      { ...wellFormed, recipeId: 'recipe-metroidvania-2d' },
      'a bubble tapper'
    );

    expect(brief.recipeId).toBe(FALLBACK_RECIPE_ID);
    expect(issues.join(' ')).toContain('recipe-metroidvania-2d');
  });

  it('keeps an invented 3D recipe in 3D instead of falling back to a 2D one', () => {
    // The incident: "3D puzzle" was answered with the 2D arena recipe, so the agent built the game
    // out of isometric sprites. An invented id that says 3d IS the planner reporting the dimension.
    const { brief, issues } = validateBrief(
      { ...wellFormed, recipeId: 'recipe-voxel-puzzle-3d' },
      'a 3d puzzle where you carve voxels off a cube'
    );

    expect(brief.recipeId).toBe(FALLBACK_3D_RECIPE_ID);
    expect(issues.join(' ')).toContain('recipe-voxel-puzzle-3d');
  });

  it('says nothing to the user while a 3D ask can be served in 3D', () => {
    // The notice is for the case the 3D recipe is missing; with one installed there is nothing to
    // apologise for. (The downgrade path itself is covered by the renderFirstTurnMessage test.)
    const { userNotices } = validateBrief(
      { ...wellFormed, recipeId: 'recipe-voxel-puzzle-3d' },
      'a 3d puzzle where you carve voxels off a cube'
    );

    expect(userNotices).toEqual([]);
  });

  it('stays quiet about dimensionality when the invented recipe is 2D', () => {
    const { userNotices } = validateBrief(
      { ...wellFormed, recipeId: 'recipe-match3-2d' },
      'a match three'
    );

    expect(userNotices).toEqual([]);
  });

  it('carries the notice into the first message the agent gets', () => {
    const message = renderFirstTurnMessage(fallbackBrief('a 3d puzzle'), 'a 3d puzzle', '', [
      'The idea reads as 3D but every recipe is 2D.',
    ]);

    expect(message).toContain('TELL THE USER FIRST:');
    expect(message).toContain('The idea reads as 3D but every recipe is 2D.');
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

  it('keeps a theme the packs know, whatever case the model wrote it in', () => {
    const { brief, issues } = validateBrief(
      { ...wellFormed, style: { ...wellFormed.style, theme: 'Neon' } },
      'a bubble tapper'
    );

    expect(brief.style.theme).toBe('neon');
    expect(issues).toEqual([]);
  });

  it('drops an unknown theme so the recipe default applies, and says which one was asked for', () => {
    const { brief, issues } = validateBrief(
      { ...wellFormed, style: { ...wellFormed.style, theme: 'vaporwave' } },
      'a bubble tapper'
    );

    expect(brief.style.theme).toBeUndefined();
    expect(effectiveTheme(brief)).toBe(defaultThemeForRecipe('recipe-tapper-2d'));
    expect(issues.join(' ')).toContain('vaporwave');
  });

  it('keeps the wow beats and drops the entries that are not text', () => {
    const { brief } = validateBrief(
      { ...wellFormed, wow: ['combo popups', 42, '  ', 'a board tilt'] },
      'a bubble tapper'
    );

    expect(brief.wow).toEqual(['combo popups', 'a board tilt']);
  });

  it('leaves wow absent when the planner returns none — spectacle is never defaulted', () => {
    expect(validateBrief(wellFormed, 'a bubble tapper').brief.wow).toBeUndefined();
    expect(
      validateBrief({ ...wellFormed, wow: 'lots of juice' }, 'a tapper').brief.wow
    ).toBeUndefined();
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

/**
 * Style packs are the deterministic half of the "wow" floor: the first frame has to look chosen
 * rather than defaulted, and it has to cost the agent nothing. So the pack is code, it reaches the
 * scene only through tunables the recipe declares, and anything it names that the recipe has not
 * caught up with must degrade into a sentence for the agent rather than a blind YAML edit.
 */
describe('style themes', () => {
  const briefWith = (patch: Partial<PrototypeBrief>): PrototypeBrief => ({
    ...fallbackBrief('a neon pinball'),
    ...patch,
  });
  const bouncer = briefWith({ recipeId: 'recipe-bouncer-2d' });

  it('takes the look from the recipe genre when the brief names none', () => {
    expect(effectiveTheme(bouncer)).toBe('neon');
    expect(effectiveTheme(briefWith({ recipeId: 'recipe-tapper-2d' }))).toBe(DEFAULT_THEME);
  });

  it('lets a theme the brief names beat the genre default', () => {
    const retro = briefWith({
      recipeId: 'recipe-bouncer-2d',
      style: { palette: [], artStyle: '', mood: '', theme: 'retro' },
    });

    expect(effectiveTheme(retro)).toBe('retro');
    expect(themedTunables(retro).bgColor).toBe(THEME_TUNABLES.retro.bgColor);
  });

  it('puts the pack UNDER the brief: a tunable the idea asked for always wins', () => {
    const values = themedTunables({ ...bouncer, tunables: { bloomIntensity: 0.2 } });

    expect(values.bloomIntensity).toBe(0.2);
    expect(values.boardColor).toBe(THEME_TUNABLES.neon.boardColor);
  });

  it('leaves the background to a palette measured from the user reference', () => {
    // The pack is a default, and a colour quantized out of the user's own image is not.
    const withPalette = briefWith({
      recipeId: 'recipe-bouncer-2d',
      style: { palette: ['#123456', '#abcdef'], artStyle: '', mood: '' },
    });

    expect(themedTunables(withPalette).bgColor).toBeUndefined();
    expect(themedTunables(withPalette).boardColor).toBe(THEME_TUNABLES.neon.boardColor);
  });

  it('degrades a pack key the recipe does not declare into a note, never a guessed patch', () => {
    // `bloomIntensity` exists in the bouncer recipe and nowhere else; the older recipes must not
    // acquire an invented tuning point just because the neon pack mentions one.
    const declared = new Map<string, RecipeTunable>([
      ['bgColor', { key: 'bgColor', node: 'game-background', property: 'color' }],
    ]);
    const resolution = resolveTunables(themedTunables(bouncer), declared);

    expect(resolution.applied.map(entry => entry.tunable.key)).toEqual(['bgColor']);
    expect(resolution.unknown.map(entry => entry.key)).toEqual(['boardColor', 'bloomIntensity']);

    const markdown = renderBriefMarkdown(bouncer, 'a neon pinball', resolution, []);
    expect(markdown).toContain('For the agent — asked for, not applied');
    expect(markdown).toContain('`bloomIntensity`');
  });

  it('records the chosen look in both documents the agent reads back', () => {
    const briefMarkdown = renderBriefMarkdown(
      bouncer,
      'a neon pinball',
      { applied: [], unknown: [], rejected: [] },
      []
    );

    expect(briefMarkdown).toMatch(/^- Theme: neon \(recipe default\)$/m);
    expect(renderStyleMarkdown(bouncer, [])).toContain('**Theme:** neon');
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

/**
 * What the planner is told about the skeleton is the difference between a first turn that builds
 * flippers and a first turn that rebuilds controls the project already shipped with — the single
 * most expensive way an increment can be wasted, so the rule text is held here.
 */
describe('planner prompt', () => {
  it('tells the planner the recipe already plays and the first increment is the mechanic', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('ALREADY ships a playable skeleton');
    expect(PLANNER_SYSTEM_PROMPT).toContain('never write "controls"');
    expect(PLANNER_SYSTEM_PROMPT).toContain('makes this game THIS game');
    expect(PLANNER_SYSTEM_PROMPT).toContain('`wow` is 2 to 4 spectacle beats');
    expect(PLANNER_SYSTEM_PROMPT).toContain('`style.theme` is one of neon, pastel, retro, minimal');
  });

  it('shows a JSON shape carrying a theme, wow beats and a mechanic-first plan', () => {
    const shape = extractJsonObject(buildPlannerPrompt({ prompt: 'a snake game' }, [], [], []));

    expect(shape).not.toBeNull();
    expect((shape?.style as { theme?: string }).theme).toBe('minimal');
    expect(shape?.wow).toHaveLength(2);
    const increments = shape?.increments as string[];
    expect(increments[0]).not.toMatch(/controls|core loop/i);
    // An em dash inside an item would be parsed as the tracker's note tail, so the example must
    // not teach the shape that breaks it.
    for (const item of [...increments, ...(shape?.wow as string[])]) {
      expect(item).not.toContain('—');
    }
  });
});

describe('generated design docs', () => {
  const brief = fallbackBrief('a coin tapper');

  it('writes a progress checklist FlowPlanService can parse, with exactly one active step', () => {
    const steps = parseChecklist(renderProgressMarkdown(brief));

    expect(steps).toHaveLength(brief.increments.length);
    expect(steps.filter(step => step.status === 'active')).toHaveLength(1);
    // Even the blind fallback checklist opens on what makes the game itself: the recipe already
    // shipped the controls and the loop, so an increment for them is a wasted turn.
    expect(steps[0]).toMatchObject({ status: 'active', title: brief.increments[0] });
    expect(steps[0].title).not.toMatch(/controls|core loop/i);
    expect(steps[1].status).toBe('todo');
  });

  it('appends the wow beats to the same checklist as late pending items', () => {
    const withWow: PrototypeBrief = {
      ...brief,
      wow: ['combo popups on a streak', 'slow motion on the last life'],
    };

    const steps = parseChecklist(renderProgressMarkdown(withWow));

    expect(steps).toHaveLength(brief.increments.length + 2);
    expect(steps.filter(step => step.status === 'active')).toHaveLength(1);
    expect(steps.slice(-2).map(step => [step.title, step.status])).toEqual([
      ['combo popups on a streak', 'todo'],
      ['slow motion on the last life', 'todo'],
    ]);
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
      [
        'playerSpeed',
        { key: 'playerSpeed', node: 'player', property: 'speed', min: 100, max: 900 },
      ],
    ]);
    const resolution = resolveTunables({ playerSpeed: 5000, enemyWaves: 3 }, declared);

    const markdown = renderBriefMarkdown(brief, 'a coin tapper', resolution, ['a bootstrap note']);

    expect(markdown).toContain('`playerSpeed` = 900 (clamped from 5000)');
    expect(markdown).toContain('For the agent — asked for, not applied');
    expect(markdown).toContain('`enemyWaves`: 3');
    expect(markdown).toContain('- a bootstrap note');
  });
});

describe('renderFirstTurnMessage', () => {
  const brief = fallbackBrief('a coin tapper');

  it('carries the plan and takes only the first increment', () => {
    const message = renderFirstTurnMessage(brief, 'a coin tapper');

    expect(message).toContain('**first increment only**');
    expect(message).not.toContain('Project map');
  });

  it('inlines the project map so the agent does not spend its first hops re-reading it', () => {
    // Measured: 22 of 55 round-trips in a first increment were reads of a project that had just
    // been generated. The map is the cheap half of that fix — it must reach the model verbatim.
    const map = [
      '## Project map — the current contents of every script and scene',
      '',
      '### scripts/Spawner.ts',
      '```ts',
      'export class Spawner {}',
      '```',
    ].join('\n');

    const message = renderFirstTurnMessage(brief, 'a coin tapper', map);

    expect(message).toContain('### scripts/Spawner.ts');
    expect(message).toContain('export class Spawner {}');
    expect(message.indexOf('Project map')).toBeGreaterThan(message.indexOf('first increment only'));
  });
});
