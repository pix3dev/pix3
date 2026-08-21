import { describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';

import type { ComposerAttachment } from '@/ui/shared/composer-attachments';
import type {
  CreateProjectOptions,
  ActivateProjectOptions,
} from '@/services/project/ProjectService';
import { createDefaultProjectManifest, type ProjectManifest } from '@/core/ProjectManifest';
import type { FlowReferenceItem } from '@/services/flow/FlowReferencesService';
import { IDEA_PRESERVED_PATHS } from '@/services/flow/recipe-contract';
import {
  IDEA_TEMPLATE_ID,
  PrototypeBootstrapService,
  renderIdeaFirstTurnMessage,
  renderIdeaGddMarkdown,
  renderDecisionsMarkdown,
  renderReferencesIndex,
  extractDecisionLines,
  extractIdeaPrompt,
  parseStylePalette,
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

  it('stops at the first clause instead of ending mid-phrase', () => {
    expect(
      deriveTitle('ant colony strategy: build tunnels, gather food, defend from termites')
    ).toBe('Ant colony strategy');
    expect(deriveTitle('tap the falling coins, miss a bomb and you lose')).toBe(
      'Tap the falling coins'
    );
  });

  it('keeps a one-word clause from swallowing the whole title', () => {
    // "Snake" alone is a clause, but a title of one word from a longer prompt tells the user less
    // than the words that follow it.
    expect(deriveTitle('snake: eat, grow, do not hit the wall')).toBe('Snake: eat, grow, do not');
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

// ---------------------------------------------------------------------------
// The idea stage (design §3.1)
// ---------------------------------------------------------------------------

/** Everything `startIdea` touches, recorded so the assertions can be about behaviour, not mocks. */
interface IdeaHarness {
  readonly service: PrototypeBootstrapService;
  readonly files: Map<string, string>;
  readonly binaries: Map<string, number>;
  readonly created: CreateProjectOptions[];
  readonly sent: string[];
  readonly conversations: { count: number };
  readonly planner: { calls: number };
  readonly remembered: string[];
}

const buildIdeaHarness = (): IdeaHarness => {
  const files = new Map<string, string>();
  const binaries = new Map<string, number>();
  const created: CreateProjectOptions[] = [];
  const sent: string[] = [];
  const conversations = { count: 0 };
  const planner = { calls: 0 };
  const remembered: string[] = [];

  const service = new PrototypeBootstrapService();
  const stubs: Record<string, unknown> = {
    projectService: {
      createNewProjectWithOptions: async (
        options: CreateProjectOptions,
        activate?: ActivateProjectOptions
      ) => {
        created.push(options);
        await activate?.beforeActivate?.();
      },
    },
    storage: {
      writeTextFile: async (path: string, contents: string) => {
        files.set(path, contents);
      },
      writeBinaryFile: async (path: string, buffer: ArrayBuffer) => {
        binaries.set(path, buffer.byteLength);
      },
    },
    templates: {
      getTemplate: () => ({
        id: IDEA_TEMPLATE_ID,
        projectType: '2d',
        targetPlatform: 'universal',
        viewport: { width: 1920, height: 1080 },
      }),
      getVisibleTemplates: () => [],
    },
    browserStore: { requestPersistence: async () => true },
    workspaceMode: { remember: (mode: string) => remembered.push(mode) },
    agentChat: {
      newConversation: async () => {
        conversations.count += 1;
      },
      send: async (text: string) => {
        sent.push(text);
      },
    },
    // The planner is reachable only through these three, so a call to any of them means an LLM
    // round-trip happened on a path whose whole promise is that none does.
    agentSettings: {
      getSelectedProvider: () => {
        planner.calls += 1;
        return null;
      },
    },
    vision: {
      describeImages: async () => {
        planner.calls += 1;
        return [];
      },
    },
    catalog: {
      getModel: () => {
        planner.calls += 1;
        return null;
      },
    },
  };
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(service, key, { value, configurable: true });
  }
  return { service, files, binaries, created, sent, conversations, planner, remembered };
};

/** A 1x1 transparent PNG — only that it reaches `references/` matters, never its pixels. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const imageAttachment = (
  name: string,
  role: 'style' | 'content' | 'layout'
): ComposerAttachment => ({
  id: name,
  kind: 'image',
  name,
  mimeType: 'image/png',
  base64: PNG_1PX,
  size: 68,
  role,
});

describe('PrototypeBootstrapService.startIdea', () => {
  it('creates the project at the idea stage from the blank template', async () => {
    const harness = buildIdeaHarness();

    const result = await harness.service.startIdea({
      prompt: 'a strategy about ants',
      startAgentTurn: false,
    });

    expect(result.templateId).toBe(IDEA_TEMPLATE_ID);
    expect(harness.created).toHaveLength(1);
    const [options] = harness.created;
    expect(options.templateId).toBe(IDEA_TEMPLATE_ID);
    expect(options.backend).toBe('browser');
    expect(options.name).toBe(deriveTitle('a strategy about ants'));
    const manifest: ProjectManifest = options.manifest;
    expect(manifest.metadata?.flowStage).toBe('idea');
    expect(manifest.metadata?.templateId).toBe(IDEA_TEMPLATE_ID);
    // A project born in Flow reopens in Flow.
    expect(harness.remembered).toEqual(['flow']);
  });

  it('writes the recipe card as a HINT, never as the chosen recipe', async () => {
    const harness = buildIdeaHarness();

    await harness.service.startIdea({
      prompt: 'a tapper',
      recipeId: 'recipe-tapper-2d',
      startAgentTurn: false,
    });

    expect(harness.created[0].manifest.metadata?.recipeHint).toBe('recipe-tapper-2d');
    expect(harness.files.get('design/gdd.md')).toContain('Genre hint from the launcher');
  });

  it('seeds exactly the three idea-stage files, with the prompt inside the document', async () => {
    const harness = buildIdeaHarness();

    await harness.service.startIdea({
      prompt: 'a strategy about ants',
      startAgentTurn: false,
    });

    expect([...harness.files.keys()].sort()).toEqual([
      'design/decisions.md',
      'design/gdd.md',
      'references/index.json',
    ]);
    const gdd = harness.files.get('design/gdd.md') ?? '';
    expect(gdd).toMatch(/^# A strategy about ants$/m);
    expect(gdd).toContain('a strategy about ants');
    expect(gdd).toContain('## Open questions');
    // No recipe was chosen, so none of the prototype-stage documents may exist yet.
    expect(harness.files.has('design/brief.md')).toBe(false);
    expect(harness.files.has('design/progress.md')).toBe(false);
  });

  it('saves attachments as project files and indexes the images', async () => {
    const harness = buildIdeaHarness();

    const result = await harness.service.startIdea({
      prompt: 'ants',
      attachments: [imageAttachment('mood.png', 'style')],
      startAgentTurn: false,
    });

    expect([...harness.binaries.keys()]).toEqual(['references/mood.png']);
    expect(JSON.parse(harness.files.get('references/index.json') ?? '{}')).toEqual({
      'mood.png': { role: 'style', origin: 'user' },
    });
    expect(result.references).toEqual([
      expect.objectContaining({ path: 'res://references/mood.png', kind: 'image', role: 'style' }),
    ]);
  });

  it('calls no planner and no model on the way in', async () => {
    const harness = buildIdeaHarness();

    await harness.service.startIdea({ prompt: 'ants', startAgentTurn: false });

    // The promise of design §3.1: the idea stage opens FASTER than the prototype stage, because
    // there is no LLM call between the prompt and the editor at all.
    expect(harness.planner.calls).toBe(0);
    expect(harness.conversations.count).toBe(0);
    expect(harness.sent).toEqual([]);
  });

  it('starts exactly one agent turn, on a fresh conversation', async () => {
    const harness = buildIdeaHarness();

    await harness.service.startIdea({ prompt: 'ants' });
    // The turn is fired and not awaited, so let the microtasks it queues run.
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.conversations.count).toBe(1);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toContain('idea-stage');
  });

  it('refuses to run twice at once', async () => {
    const harness = buildIdeaHarness();
    let release = (): void => {};
    Object.defineProperty(harness.service, 'projectService', {
      value: {
        createNewProjectWithOptions: () =>
          new Promise<void>(resolve => {
            release = () => resolve();
          }),
      },
      configurable: true,
    });

    const first = harness.service.startIdea({ prompt: 'ants', startAgentTurn: false });
    await expect(
      harness.service.startIdea({ prompt: 'bees', startAgentTurn: false })
    ).rejects.toThrow(/already being created/);
    release();
    await first;
  });

  it('never fails the project over a document it could not write', async () => {
    const harness = buildIdeaHarness();
    Object.defineProperty(harness.service, 'storage', {
      value: {
        writeTextFile: vi.fn(async () => {
          throw new Error('disk is full');
        }),
        writeBinaryFile: vi.fn(async () => undefined),
      },
      configurable: true,
    });

    const result = await harness.service.startIdea({ prompt: 'ants', startAgentTurn: false });

    expect(result.notes.join(' ')).toContain('disk is full');
    expect(harness.created).toHaveLength(1);
  });
});

describe('renderIdeaGddMarkdown', () => {
  it('renders the section skeleton with the prompt quoted and nothing invented', () => {
    const markdown = renderIdeaGddMarkdown('Ant Wars', 'a strategy about ants', undefined);

    expect(markdown).toMatch(/^# Ant Wars$/m);
    expect(markdown).toMatch(/^\*\*Pitch:\*\* _to be filled_$/m);
    expect(markdown).toMatch(/^## What the user asked for$/m);
    expect(markdown).toContain('a strategy about ants');
    for (const heading of [
      'Concept',
      'Core loop & mechanics',
      'Controls',
      'Screens & UI',
      'Art & audio',
      'Progression & difficulty',
      'Open questions',
    ]) {
      expect(markdown).toContain(`## ${heading}`);
    }
    // No launcher card was clicked and nothing was attached, so neither may appear.
    expect(markdown).not.toContain('Genre hint');
    expect(markdown).not.toContain('## References');
  });

  it('says so when there is no prompt text at all (references only)', () => {
    expect(renderIdeaGddMarkdown('Untitled', '   ', undefined)).toContain(
      '(no prompt text — see the references)'
    );
  });

  it('lists the saved references with their roles', () => {
    const markdown = renderIdeaGddMarkdown('Ant Wars', 'ants', undefined, [
      { path: 'res://references/mood.png', kind: 'image', role: 'style' },
      { path: 'design/source/pitch.md', kind: 'doc' },
    ]);

    expect(markdown).toContain('## References');
    expect(markdown).toContain('`res://references/mood.png` (image — style)');
    expect(markdown).toContain('`design/source/pitch.md` (doc)');
  });

  it('has no checklist for the plan tracker to find (there is no plan yet)', () => {
    expect(parseChecklist(renderIdeaGddMarkdown('Ant Wars', 'ants', undefined))).toEqual([]);
  });
});

describe('renderReferencesIndex', () => {
  it('is an empty object when nothing was attached', () => {
    expect(renderReferencesIndex([]).trim()).toBe('{}');
  });

  it('keys images by file name and ignores documents', () => {
    const json = JSON.parse(
      renderReferencesIndex([
        { path: 'res://references/mood.png', kind: 'image', role: 'layout' },
        { path: 'res://references/hero.png', kind: 'image' },
        { path: 'design/source/pitch.md', kind: 'doc' },
      ])
    );

    expect(json).toEqual({
      'mood.png': { role: 'layout', origin: 'user' },
      // No role on the attachment degrades to `style`, the same default as `guessAttachmentRole`.
      'hero.png': { role: 'style', origin: 'user' },
    });
  });
});

describe('renderIdeaFirstTurnMessage', () => {
  it('points the agent at the skill, the document and a question — and at no game', () => {
    const message = renderIdeaFirstTurnMessage('a strategy about ants', undefined);

    expect(message).toContain('idea-stage');
    expect(message).toContain('design/gdd.md');
    expect(message).toContain('ask_user');
    expect(message).toContain('str_replace');
    // The failure this stage exists to prevent: a turn that builds instead of asking.
    expect(message).toContain('no play mode');
    expect(message).not.toContain('increment');
  });

  it('carries the recipe card as a hint and lists the attachments with roles', () => {
    const message = renderIdeaFirstTurnMessage('ants', 'recipe-arena-2d', [
      { path: 'res://references/mood.png', kind: 'image', role: 'style' },
    ]);

    expect(message).toContain('`recipe-arena-2d`');
    expect(message).toContain('treat it as a hint');
    expect(message).toContain('`res://references/mood.png`');
    expect(message).toContain('role `style`');
  });
});

// ---------------------------------------------------------------------------
// The transition (design §3.1 `startPrototype`, §2.4)
// ---------------------------------------------------------------------------

/** `design/gdd.md` as it looks after a few idea-stage turns. */
const GDD_MD = `# Ant Colony Strategy

**Pitch:** Grow a colony and defend the queen.

## What the user asked for

a strategy about ants where you dig tunnels

## Concept

The colony grows underground; the player never controls an ant directly.

## Core loop & mechanics

Dig, gather, defend.
`;

const STYLE_MD = `# Style — Ant Colony Strategy

- **Palette:** #2b1a0e, #8a5a2b, #e8c07d
- **Art style:** flat vector
- **Mood:** earthy
`;

/** Both shapes the decisions log can hold, plus the scaffold's own fenced example. */
const DECISIONS_MD = [
  '# Decisions',
  '',
  'Every fork the user settled. Append one entry per decision:',
  '',
  '```',
  '## <the question>',
  '- **Chosen:** <the answer>',
  '- **Why:** <one line>',
  '```',
  '',
  '## Portrait or landscape?',
  '- **Chosen:** Portrait',
  '- **Why:** It is a phone game.',
  '',
  '- **Session length** → about two minutes. Matches an ad-break attention span.',
  '',
].join('\n');

/** A recipe contract with one node tunable, so the scene patch can be observed on disk. */
const TRANSITION_RECIPE_MD = [
  '# Recipe: recipe-arena-2d',
  '',
  '## Tunables',
  '',
  '```yaml',
  'tunables:',
  '  bgColor: { node: game-background, property: color, default: "#0f3460" }',
  '```',
  '',
].join('\n');

const TRANSITION_SCENE = `version: 1.0.0
root:
  - id: game-root
    type: Group2D
    children:
      - id: game-background
        type: ColorRect2D
        properties:
          color: "#0f3460"
`;

const PLANNED_BRIEF = JSON.stringify({
  title: 'Ant Colony',
  pitch: 'Grow a colony and defend the queen.',
  recipeId: 'recipe-arena-2d',
  style: { palette: ['#ffffff'], artStyle: 'flat vector', mood: 'earthy' },
  entities: [{ role: 'player', name: 'Queen', assetSpec: { prompt: 'an ant queen' } }],
  tunables: {},
  winLose: { win: 'The colony survives ten days', lose: 'The queen dies' },
  increments: ['digging tunnels', 'raiders', 'seasons'],
});

interface TransitionHarness {
  readonly service: PrototypeBootstrapService;
  readonly files: Map<string, string>;
  readonly applied: Array<{
    name: string;
    manifest: ProjectManifest;
    templateId?: string;
    skip?: readonly string[];
  }>;
  readonly created: CreateProjectOptions[];
  /** Manifests written through `saveProjectManifest`, i.e. after the copy succeeded. */
  readonly saved: ProjectManifest[];
  readonly reactivated: Array<{ entryScenePath?: string }>;
  readonly plannerPrompts: string[];
  readonly sent: string[];
  readonly phases: string[];
  readonly conversations: { count: number };
}

const referenceItem = (
  overrides: Partial<FlowReferenceItem> & Pick<FlowReferenceItem, 'path' | 'name' | 'group'>
): FlowReferenceItem => ({
  kind: 'image',
  origin: 'user',
  role: null,
  caption: null,
  previewLine: null,
  sizeBytes: null,
  modifiedAt: null,
  readOnly: false,
  pinned: false,
  missing: false,
  ...overrides,
});

const buildTransitionHarness = (options?: {
  /** No provider configured — the transition must still expand, from the fallback brief. */
  readonly withoutProvider?: boolean;
  /** What the planner replies (raw text, so a garbage reply can be tested too). */
  readonly plannerReply?: string;
}): TransitionHarness => {
  resetAppState();
  const files = new Map<string, string>([
    ['design/gdd.md', GDD_MD],
    ['design/style.md', STYLE_MD],
    ['design/decisions.md', DECISIONS_MD],
    ['design/recipe.md', TRANSITION_RECIPE_MD],
    ['scenes/main.pix3scene', TRANSITION_SCENE],
  ]);
  const applied: TransitionHarness['applied'] = [];
  const created: CreateProjectOptions[] = [];
  const saved: ProjectManifest[] = [];
  const reactivated: Array<{ entryScenePath?: string }> = [];
  const plannerPrompts: string[] = [];
  const sent: string[] = [];
  const phases: string[] = [];
  const conversations = { count: 0 };

  appState.project.status = 'ready';
  appState.project.id = 'idea-project';
  appState.project.projectName = 'Ant Colony Strategy';
  appState.project.manifest = {
    ...createDefaultProjectManifest(),
    metadata: {
      projectName: 'Ant Colony Strategy',
      templateId: IDEA_TEMPLATE_ID,
      flowStage: 'idea',
      recipeHint: 'recipe-tapper-2d',
    },
  };

  const service = new PrototypeBootstrapService();
  const stubs: Record<string, unknown> = {
    flowStage: { isIdeaStage: () => true },
    projectService: {
      applyTemplateFiles: async (
        name: string,
        manifest: ProjectManifest,
        templateId?: string,
        opts?: { skip?: readonly string[] }
      ) => {
        applied.push({ name, manifest, templateId, skip: opts?.skip });
      },
      saveProjectManifest: async (manifest: ProjectManifest) => {
        saved.push(manifest);
      },
      reactivateCurrentProject: async (opts?: { entryScenePath?: string }) => {
        reactivated.push({ ...opts });
        // Reactivation is what makes a scene active again; the first agent turn waits for it.
        appState.scenes.activeSceneId = 'scenes-main';
      },
      createNewProjectWithOptions: async (createOptions: CreateProjectOptions) => {
        created.push(createOptions);
      },
    },
    storage: {
      readTextFile: async (path: string) => {
        const contents = files.get(path);
        if (contents === undefined) {
          throw new Error(`no such file: ${path}`);
        }
        return contents;
      },
      writeTextFile: async (path: string, contents: string) => {
        files.set(path, contents);
      },
      writeBinaryFile: async () => undefined,
      listDirectory: async (path: string) =>
        path === 'scenes'
          ? [{ kind: 'file', name: 'main.pix3scene', path: 'scenes/main.pix3scene' }]
          : [],
    },
    templates: {
      getVisibleTemplates: () => [{ id: 'recipe-arena-2d' }, { id: 'recipe-tapper-2d' }],
      getTemplate: (id: string) => ({
        id,
        projectType: '2d',
        targetPlatform: 'mobile',
        viewport: { width: 1080, height: 1920 },
        entryScenePath: 'scenes/main.pix3scene',
      }),
    },
    references: {
      list: async () => ({
        document: referenceItem({
          path: 'design/gdd.md',
          name: 'gdd.md',
          group: 'document',
          kind: 'markdown',
          pinned: true,
        }),
        references: [
          referenceItem({
            path: 'references/mood.png',
            name: 'mood.png',
            group: 'references',
            role: 'style',
            caption: 'earthy tunnels',
          }),
          referenceItem({
            path: 'references/mood-cartoon.png',
            name: 'mood-cartoon.png',
            group: 'references',
            role: 'style-candidate',
            origin: 'agent',
          }),
        ],
        sources: [
          referenceItem({
            path: 'design/source/old-gdd.md',
            name: 'old-gdd.md',
            group: 'sources',
            kind: 'markdown',
            readOnly: true,
          }),
        ],
      }),
    },
    agentChat: {
      newConversation: async () => {
        conversations.count += 1;
      },
      send: async (text: string) => {
        sent.push(text);
      },
    },
    agentSettings: {
      getSelectedProvider: () =>
        options?.withoutProvider
          ? null
          : {
              id: 'bridge',
              chat: async (params: { messages: Array<{ content: unknown }> }) => {
                const [message] = params.messages;
                plannerPrompts.push(
                  typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content)
                );
                return {
                  content: [{ type: 'text', text: options?.plannerReply ?? PLANNED_BRIEF }],
                };
              },
            },
      getSelectedModelId: () => 'model-1',
      getApiKey: async () => 'key',
      getBaseUrl: () => undefined,
    },
    vision: { analyze: async () => '' },
    catalog: { getModel: () => ({ capabilities: { supportsImages: false } }) },
    workspaceMode: { remember: () => undefined },
    browserStore: { requestPersistence: async () => true },
  };
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(service, key, { value, configurable: true });
  }
  service.subscribe(status => phases.push(status.phase));
  return {
    service,
    files,
    applied,
    created,
    saved,
    reactivated,
    plannerPrompts,
    sent,
    phases,
    conversations,
  };
};

describe('PrototypeBootstrapService.startPrototype', () => {
  it('lays the recipe over the OPEN project instead of creating a second one', async () => {
    const harness = buildTransitionHarness();

    const result = await harness.service.startPrototype({ startAgentTurn: false });

    expect(result.templateId).toBe('recipe-arena-2d');
    // A new project would mint a new id and orphan the chat history, the recents entry and the
    // remembered workspace mode (design §3.1).
    expect(harness.created).toEqual([]);
    expect(harness.applied).toHaveLength(1);
    expect(harness.applied[0].templateId).toBe('recipe-arena-2d');
    expect(harness.applied[0].name).toBe('Ant Colony Strategy');
    expect(harness.applied[0].skip).toEqual(IDEA_PRESERVED_PATHS);
    // …and the editor is re-opened onto the template's own entry scene.
    expect(harness.reactivated).toEqual([{ entryScenePath: 'scenes/main.pix3scene' }]);
  });

  it('keeps the idea documents and writes the prototype ones', async () => {
    const harness = buildTransitionHarness();

    await harness.service.startPrototype({ startAgentTurn: false });

    // The two files the whole idea stage produced are untouched.
    expect(harness.files.get('design/gdd.md')).toBe(GDD_MD);
    expect(harness.files.get('design/decisions.md')).toBe(DECISIONS_MD);
    // The three the prototype stage runs on are written.
    expect(harness.files.get('design/brief.md')).toContain('# Ant Colony');
    expect(harness.files.get('design/progress.md')).toContain('digging tunnels');
    expect(harness.files.get('design/style.md')).toContain('flat vector');
  });

  it('flips flowStage to prototype and carries the idea metadata over', async () => {
    const harness = buildTransitionHarness();

    await harness.service.startPrototype({ startAgentTurn: false });

    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0].metadata).toEqual({
      projectName: 'Ant Colony Strategy',
      templateId: 'recipe-arena-2d',
      flowStage: 'prototype',
      recipeHint: 'recipe-tapper-2d',
    });
    // The recipe's own shape comes from the template it resolved to.
    expect(harness.saved[0].viewportBaseSize).toEqual({ width: 1080, height: 1920 });
    expect(harness.saved[0].defaultExportScenePath).toBe('scenes/main.pix3scene');
  });

  it('flips the stage only after the recipe is fully on disk', async () => {
    const harness = buildTransitionHarness();

    await harness.service.startPrototype({ startAgentTurn: false });

    // The copy is the step that can fail half-done. A manifest that already said `prototype` over
    // a half-copied recipe would be unrecoverable — the CTA refuses a project that is not at the
    // idea stage — so the stage flip is a separate write that happens after.
    expect(harness.applied[0].manifest.metadata?.flowStage).toBe('idea');
    expect(harness.saved[0].metadata?.flowStage).toBe('prototype');
  });

  it('leaves the project at the idea stage when the template copy fails', async () => {
    const harness = buildTransitionHarness();
    Object.defineProperty(harness.service, 'projectService', {
      value: {
        applyTemplateFiles: async () => {
          throw new Error('storage is gone');
        },
        saveProjectManifest: async (manifest: ProjectManifest) => {
          harness.saved.push(manifest);
        },
      },
      configurable: true,
    });

    await expect(harness.service.startPrototype({ startAgentTurn: false })).rejects.toThrow(
      'storage is gone'
    );
    // Nothing flipped the stage, so the CTA still works and the transition can be retried.
    expect(harness.saved).toEqual([]);
  });

  it('feeds the planner the prompt first, then the document, the style and the decisions', async () => {
    const harness = buildTransitionHarness();

    await harness.service.startPrototype({ startAgentTurn: false });

    expect(harness.plannerPrompts).toHaveLength(1);
    const prompt = harness.plannerPrompts[0];
    // The user's own words come first — the priority rule of parent §5.7 expressed as ordering.
    expect(prompt).toContain('IDEA: a strategy about ants where you dig tunnels');
    expect(prompt.indexOf('IDEA:')).toBeLessThan(prompt.indexOf('DESIGN DOCUMENT'));
    expect(prompt.indexOf('DESIGN DOCUMENT')).toBeLessThan(prompt.indexOf('STYLE `design'));
    expect(prompt.indexOf('STYLE `design')).toBeLessThan(prompt.indexOf('DECISIONS ALREADY'));
    expect(prompt).toContain('Portrait or landscape? → Portrait');
    expect(prompt).toContain('Session length → about two minutes.');
    // The scaffold's own fenced example must not arrive as a decision.
    expect(prompt).not.toContain('<the question>');
  });

  it('treats the launcher card as a hint, never as the chosen recipe', async () => {
    const harness = buildTransitionHarness();

    const result = await harness.service.startPrototype({ startAgentTurn: false });

    const prompt = harness.plannerPrompts[0];
    expect(prompt).toContain('RECIPE CATALOG');
    expect(prompt).toContain('recipe-tapper-2d" card');
    expect(prompt).toContain('HINT, not an instruction');
    // The pinned-recipe wording belongs to the welcome-card path and must not appear here.
    expect(prompt).not.toContain('The user already chose the recipe');
    // The planner picked the arena recipe over the hinted tapper, and that choice stands.
    expect(result.brief.recipeId).toBe('recipe-arena-2d');
  });

  it('reuses the palette measured for design/style.md over the planner one', async () => {
    const harness = buildTransitionHarness();

    const result = await harness.service.startPrototype({ startAgentTurn: false });

    expect(result.brief.style.palette).toEqual(['#2b1a0e', '#8a5a2b', '#e8c07d']);
    // And it reached the scene the template just copied: the dominant colour is the background.
    expect(harness.files.get('scenes/main.pix3scene')).toContain('#2b1a0e');
  });

  it('leaves rejected style candidates out of the brief', async () => {
    const harness = buildTransitionHarness();

    await harness.service.startPrototype({ startAgentTurn: false });

    const brief = harness.files.get('design/brief.md') ?? '';
    expect(brief).toContain('res://references/mood.png');
    expect(brief).toContain('design/source/old-gdd.md');
    // A mood board the user did not pick is a question that was already answered (design §3.9).
    expect(brief).not.toContain('mood-cartoon.png');
  });

  it('still expands when no provider is configured', async () => {
    const harness = buildTransitionHarness({ withoutProvider: true });

    const result = await harness.service.startPrototype({ startAgentTurn: false });

    expect(result.templateId).toBe(FALLBACK_RECIPE_ID);
    expect(result.notes.join(' ')).toContain('No LLM provider');
    // The title still comes from the user's own words, through the fallback brief.
    expect(result.brief.title).toBe(deriveTitle('a strategy about ants where you dig tunnels'));
    expect(harness.applied).toHaveLength(1);
    expect(harness.reactivated).toHaveLength(1);
  });

  it('narrates planning → expanding → ready on the existing status stream', async () => {
    const harness = buildTransitionHarness();

    await harness.service.startPrototype({ startAgentTurn: false });

    expect(harness.phases).toEqual(['idle', 'planning', 'expanding', 'ready']);
  });

  it('reports a failure on the same stream instead of dying silently', async () => {
    const harness = buildTransitionHarness();
    Object.defineProperty(harness.service, 'projectService', {
      value: {
        applyTemplateFiles: async () => {
          throw new Error('storage is gone');
        },
      },
      configurable: true,
    });

    await expect(harness.service.startPrototype({ startAgentTurn: false })).rejects.toThrow(
      'storage is gone'
    );
    expect(harness.phases.at(-1)).toBe('error');
    expect(harness.service.getStatus().error).toBe('storage is gone');
    // The flag is released, so the CTA can be tried again.
    expect(harness.service.isRunning()).toBe(false);
  });

  it('does not fail the transition over a scene that would not open', async () => {
    const harness = buildTransitionHarness();
    Object.defineProperty(harness.service, 'projectService', {
      value: {
        applyTemplateFiles: async () => undefined,
        saveProjectManifest: async () => undefined,
        reactivateCurrentProject: async () => {
          throw new Error('Could not open the scene res://scenes/main.pix3scene.');
        },
      },
      configurable: true,
    });

    const result = await harness.service.startPrototype({ startAgentTurn: false });

    // The recipe is on disk and the stage retries the load itself; an error banner over a project
    // that is actually fine would be the worse outcome.
    expect(result.notes.join(' ')).toContain('did not open yet');
    expect(harness.phases.at(-1)).toBe('ready');
  });

  it('starts one agent turn on a fresh conversation, after the scene is back', async () => {
    const harness = buildTransitionHarness();

    await harness.service.startPrototype();
    // The turn is fired and not awaited (the CTA is done once the project is playable), and it
    // waits for the scene before it sends.
    await vi.waitFor(() => expect(harness.sent).toHaveLength(1));

    expect(harness.conversations.count).toBe(1);
    expect(harness.sent[0]).toContain('recipe-arena-2d');
    expect(harness.sent[0]).toContain('digging tunnels');
  });

  it('refuses when the project is already a prototype', async () => {
    const harness = buildTransitionHarness();
    Object.defineProperty(harness.service, 'flowStage', {
      value: { isIdeaStage: () => false },
      configurable: true,
    });

    await expect(harness.service.startPrototype()).rejects.toThrow(/already a prototype/);
    expect(harness.applied).toEqual([]);
  });

  it('refuses when no project is open', async () => {
    const harness = buildTransitionHarness();
    appState.project.status = 'idle';

    await expect(harness.service.startPrototype()).rejects.toThrow(/Open the idea project first/);
    expect(harness.applied).toEqual([]);
  });

  it('refuses to run while another bootstrap is in flight', async () => {
    const harness = buildTransitionHarness();
    // The gate is built up front, not inside the stub: the second call is made while the first is
    // still somewhere in its planner chain, so a `release` assigned only once the template copy
    // starts would still be a no-op by then.
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    Object.defineProperty(harness.service, 'projectService', {
      value: {
        applyTemplateFiles: () => gate,
        saveProjectManifest: async () => undefined,
        reactivateCurrentProject: async () => undefined,
      },
      configurable: true,
    });

    const first = harness.service.startPrototype({ startAgentTurn: false });
    // The running flag is shared with the other two entry points on purpose.
    await expect(harness.service.startIdea({ prompt: 'bees' })).rejects.toThrow(
      /already being created/
    );
    release();
    await first;
  });
});

describe('extractIdeaPrompt', () => {
  it('takes the prompt the seed quoted verbatim', () => {
    expect(extractIdeaPrompt(GDD_MD)).toBe('a strategy about ants where you dig tunnels');
  });

  it('falls back to the pitch when the section is gone', () => {
    const edited = ['# Ant Colony', '', '**Pitch:** Grow a colony.', '', '## Concept', '', 'Ants.'];
    expect(extractIdeaPrompt(edited.join('\n'))).toBe('Grow a colony.');
  });

  it('ignores both placeholders the seed writes', () => {
    const seeded = renderIdeaGddMarkdown('New Prototype', '', undefined);
    // Planning a game out of the scaffold's own words is worse than planning from the title.
    expect(extractIdeaPrompt(seeded)).toBe('New Prototype');
  });

  it('returns an empty string for a document with nothing in it', () => {
    expect(extractIdeaPrompt('')).toBe('');
  });
});

describe('extractDecisionLines', () => {
  it('reads both shapes and skips the scaffold example', () => {
    expect(extractDecisionLines(DECISIONS_MD)).toEqual([
      'Portrait or landscape? → Portrait',
      'Session length → about two minutes. Matches an ad-break attention span.',
    ]);
  });

  it('is empty for the untouched scaffold', () => {
    expect(extractDecisionLines(renderDecisionsMarkdown())).toEqual([]);
  });

  it('caps the list so a long log cannot flood the planner turn', () => {
    const many = Array.from(
      { length: 40 },
      (_, index) => `## Question ${index}\n- **Chosen:** Answer ${index}`
    ).join('\n\n');
    expect(extractDecisionLines(many, 5)).toHaveLength(5);
  });
});

describe('parseStylePalette', () => {
  it('reads the colours out of the style document', () => {
    expect(parseStylePalette(STYLE_MD)).toEqual(['#2b1a0e', '#8a5a2b', '#e8c07d']);
  });

  it('is empty when there is no palette to read', () => {
    expect(parseStylePalette('- **Palette:** (recipe defaults)')).toEqual([]);
    expect(parseStylePalette('# Style')).toEqual([]);
  });
});
