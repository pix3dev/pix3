import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Json } from '@/core/agent-introspection';
import {
  batchSteps,
  buildRoutineIndexLines,
  InMemoryRoutineStore,
  isMacroRoutine,
  parseRoutine,
  parseRoutineText,
  prepareRoutine,
  ROUTINE_DIRECTORY,
  routineFilePath,
  routineIndexEntry,
  runRoutine,
  type GameRoutine,
  type RoutineWorld,
} from './game-routines';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const routine = (overrides: Partial<GameRoutine> = {}): GameRoutine => ({
  name: 'buy-item',
  description: 'Open the shop, buy the item in a slot, close the shop.',
  uses: ['ShopButton'],
  steps: [{ type: 'invoke', target: 'ShopButton', interaction: 'click' }],
  expect: [],
  ...overrides,
});

interface WorldOverrides extends Partial<RoutineWorld> {
  present?: string[];
  properties?: Record<string, unknown>;
  state?: Record<string, Json>;
}

const makeWorld = (overrides: WorldOverrides = {}) => {
  const { present = ['ShopButton'], properties = {}, state, ...rest } = overrides;
  const runInput = vi.fn(async () => ({ ok: true }));
  const dispatchCommand = vi.fn(() => ({ ok: true }));
  const world: RoutineWorld = {
    nodeExists: (query: string) => present.includes(query),
    runInput,
    dispatchCommand,
    sampleGameState: () => (state ? { name: 'test', snapshot: state } : null),
    errorCount: () => 0,
    errorsSince: () => [],
    snapshotNode: () => null,
    readNodeProperty: (name, path) => properties[`${name}.${path}`] as never,
    countNodesOfType: () => 0,
    settle: async () => {},
    framesElapsed: () => 6,
    ...rest,
  };
  return { world, runInput, dispatchCommand };
};

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe('routine format', () => {
  it('accepts the canonical shape: game_input steps, a command step, kind-discriminated expectations', () => {
    const parsed = parseRoutine({
      name: 'mute',
      description: 'Mute the music.',
      scope: 'scenes/menu.pix3scene',
      note: 'ignored by the runner',
      uses: ['music-toggle'],
      steps: [
        { type: 'command', name: 'open-settings', why: 'the highest channel available' },
        {
          type: 'invoke',
          target: 'music-toggle',
          interaction: 'setChecked',
          args: { checked: false },
        },
        { type: 'tap', target: 'close-button', holdMs: 700 },
      ],
      expect: [
        { kind: 'nodeProperty', name: 'music-toggle', path: 'checked', op: 'eq', value: false },
      ],
    });

    expect('routine' in parsed).toBe(true);
    if (!('routine' in parsed)) return;
    expect(parsed.routine.steps.map(step => step.type)).toEqual(['command', 'invoke', 'tap']);
    expect(parsed.routine.expect[0].kind).toBe('nodeProperty');
    expect(parsed.routine.note).toBe('ignored by the runner');
  });

  it('refuses the old `predicate` dialect in expectations, naming `kind`', () => {
    const parsed = parseRoutine(
      routine({
        expect: [
          { predicate: 'nodeProperty', node: 'x', path: 'checked', op: '==', value: false },
        ] as never,
      })
    );
    expect('error' in parsed && parsed.error).toMatch(/kind/);
  });

  it('refuses the `==` operator, which the predicate vocabulary does not have', () => {
    const parsed = parseRoutine(
      routine({
        expect: [
          { kind: 'nodeProperty', name: 'x', path: 'checked', op: '==', value: false },
        ] as never,
      })
    );
    expect('error' in parsed && parsed.error).toMatch(/eq/);
  });

  it('refuses a `channel`/`intent` step — a routine may not call a component method', () => {
    const parsed = parseRoutine(
      routine({
        steps: [
          { channel: 'intent', node: 'game-root', component: 'user:GameFlow', method: 'finish' },
        ] as never,
      })
    );
    expect('error' in parsed && parsed.error).toMatch(/step type/);
    expect('error' in parsed && parsed.error).toMatch(/command/);
  });

  it('refuses unknown fields on the routine and on a step rather than dropping them', () => {
    expect(parseRoutine({ ...routine(), assertions: [] })).toEqual({
      error: expect.stringContaining('unknown field'),
    });
    const badStep = parseRoutine(
      routine({ steps: [{ type: 'tap', target: 'x', pressure: 2 }] as never })
    );
    expect('error' in badStep && badStep.error).toMatch(/unknown field\(s\) "pressure"/);
  });

  it('requires a one-line description, because that is the only part the agent ever sees', () => {
    const parsed = parseRoutine({ ...routine(), description: '' });
    expect('error' in parsed && parsed.error).toMatch(/description/);
  });

  it('requires the pieces a command step and an invoke step cannot work without', () => {
    const noName = parseRoutine(routine({ steps: [{ type: 'command' }] as never }));
    expect('error' in noName && noName.error).toMatch(/command step needs "name"/);
    const noInteraction = parseRoutine(routine({ steps: [{ type: 'invoke', target: 'x' }] }));
    expect('error' in noInteraction && noInteraction.error).toMatch(/interaction/);
  });

  it('refuses a `uses` placeholder that names no declared param', () => {
    const parsed = parseRoutine(routine({ uses: ['Slot{slot}'] }));
    expect('error' in parsed && parsed.error).toMatch(/\{slot\}/);
  });

  it('reports unparseable JSON as a sentence', () => {
    expect(parseRoutineText('{oops')).toEqual({ error: expect.stringContaining('not valid JSON') });
  });

  it('normalizes a routine name to its project path', () => {
    expect(routineFilePath('buy-item')).toBe(`${ROUTINE_DIRECTORY}/buy-item.json`);
    expect(routineFilePath(`${ROUTINE_DIRECTORY}/buy-item.json`)).toBe(
      `${ROUTINE_DIRECTORY}/buy-item.json`
    );
  });
});

// ---------------------------------------------------------------------------
// The templates ARE the format (the anti-drift test)
// ---------------------------------------------------------------------------

describe('the routines shipped in the templates load through this loader', () => {
  const examples = [
    'minigame-2d/files/design/tests/routines/mute-music.json',
    'playable-2d/files/design/tests/routines/intro-to-cta.json',
    'playable-3d/files/design/tests/routines/intro-to-cta.json',
  ];

  for (const example of examples) {
    it(example, () => {
      const text = readFileSync(join(process.cwd(), 'src/templates/projects', example), 'utf8');
      const parsed = parseRoutineText(text);
      // A template is what an agent copies from. A shipped example the runner cannot
      // load teaches a format the tools do not speak — which is exactly how the two
      // examples had drifted into two different dialects before this test existed.
      expect('error' in parsed ? parsed.error : null).toBeNull();
      if (!('routine' in parsed)) return;
      expect(parsed.routine.expect.length).toBeGreaterThan(0);
      expect(isMacroRoutine(parsed.routine)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

describe('routine parameters', () => {
  const parameterised = routine({
    params: { slot: 'number' },
    uses: ['Slot{slot}'],
    steps: [
      { type: 'invoke', target: 'Slot{slot}', interaction: 'click' },
      { type: 'command', name: 'shop.buy', args: { slot: '{slot}', label: 'slot {slot}' } },
    ],
  });

  it('substitutes into `uses` and into step fields', () => {
    const prepared = prepareRoutine(parameterised, { slot: 2 });
    expect('routine' in prepared).toBe(true);
    if (!('routine' in prepared)) return;
    expect(prepared.routine.uses).toEqual(['Slot2']);
    expect(prepared.routine.steps[0]).toMatchObject({ target: 'Slot2' });
    // A whole-placeholder value keeps its type; an embedded one interpolates.
    expect(prepared.routine.steps[1]).toMatchObject({ args: { slot: 2, label: 'slot 2' } });
  });

  it('refuses a missing arg, a wrong type, and an undeclared one', () => {
    expect(prepareRoutine(parameterised, {})).toEqual({
      error: expect.stringContaining('args.slot'),
    });
    expect(prepareRoutine(parameterised, { slot: 'two' })).toEqual({
      error: expect.stringContaining('finite number'),
    });
    expect(prepareRoutine(parameterised, { slot: 1, extra: true })).toEqual({
      error: expect.stringContaining('no param "extra"'),
    });
  });

  it('checks the SUBSTITUTED name against the scene, so a parameterised routine can go stale', async () => {
    const { world, runInput } = makeWorld({ present: ['Slot1'] });
    const result = await runRoutine(world, parameterised, { slot: 2 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ROUTINE STALE');
    expect(result.error).toContain('"Slot2"');
    expect(runInput).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe('staleness', () => {
  it('answers ROUTINE STALE with the missing node and runs nothing', async () => {
    const { world, runInput, dispatchCommand } = makeWorld({ present: [] });
    const result = await runRoutine(
      world,
      routine({ uses: ['ShopButton', 'BuyButton'], steps: [{ type: 'command', name: 'x' }] })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ROUTINE STALE');
    expect(result.error).toContain('"ShopButton", "BuyButton"');
    expect(result.error).toContain('Nothing was executed');
    expect(runInput).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Index (§5.7.2)
// ---------------------------------------------------------------------------

describe('routine index', () => {
  const shop = routine({
    name: 'buy-item',
    scope: 'scenes/shop.pix3scene',
    params: { slot: 'number' },
    uses: ['ShopButton'],
    expect: [{ kind: 'frames', n: 1 }],
  });
  const menu = routine({
    name: 'mute-music',
    description: 'Mute the music.',
    scope: 'scenes/menu.pix3scene',
  });
  const tagged = routine({ name: 'smoke', description: 'Smoke test.', scope: 'ui' });

  it('carries only name, params and description — never the body', () => {
    const entry = routineIndexEntry(shop);
    expect(Object.keys(entry).sort()).toEqual(['description', 'macro', 'name', 'params', 'scope']);

    const [line] = buildRoutineIndexLines([shop], { activeScene: 'scenes/shop.pix3scene' });
    expect(line).toBe(
      '    - buy-item(slot: number) — Open the shop, buy the item in a slot, close the shop.'
    );
    expect(line).not.toContain('ShopButton');
    expect(line).not.toContain('invoke');
  });

  it('filters scene-scoped routines by the active scene and keeps tag-scoped ones', () => {
    const lines = buildRoutineIndexLines([shop, menu, tagged], {
      activeScene: 'scenes/shop.pix3scene',
    });
    expect(lines.join('\n')).toContain('buy-item');
    expect(lines.join('\n')).not.toContain('mute-music');
    expect(lines.join('\n')).toContain('smoke');
  });

  it('matches a scope by file name too, since the same routine is addressed both ways', () => {
    const lines = buildRoutineIndexLines([menu], { activeScene: 'menu.pix3scene' });
    expect(lines.join('\n')).toContain('mute-music');
  });

  it('marks a routine with no expectations as a MACRO', () => {
    const [line] = buildRoutineIndexLines([menu], { activeScene: 'scenes/menu.pix3scene' });
    expect(line).toContain('[MACRO');
  });

  it('caps the number of lines and says how many were left out', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      routine({ name: `r${index}`, description: 'x', expect: [{ kind: 'frames', n: 1 }] })
    );
    const lines = buildRoutineIndexLines(many, { maxLines: 2 });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('+3 more routines');
  });
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

describe('routine execution', () => {
  it('batches contiguous input steps into one input call, split by command steps', () => {
    const batches = batchSteps([
      { type: 'tap', target: 'a' },
      { type: 'wait', ms: 100 },
      { type: 'command', name: 'finish' },
      { type: 'tap', target: 'b' },
    ]);
    expect(batches.map(batch => batch.kind)).toEqual(['input', 'command', 'input']);
    expect(batches[0].kind === 'input' && batches[0].steps).toHaveLength(2);
  });

  it('runs the steps in the authored order and reports each one', async () => {
    const { world, runInput, dispatchCommand } = makeWorld({ present: ['a', 'b'] });
    const result = await runRoutine(
      world,
      routine({
        uses: ['a'],
        steps: [
          { type: 'tap', target: 'a' },
          { type: 'command', name: 'finish', args: { fast: true } },
          { type: 'invoke', target: 'b', interaction: 'click' },
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(runInput).toHaveBeenCalledTimes(2);
    expect(dispatchCommand).toHaveBeenCalledWith('finish', { fast: true });
    expect(result.steps?.map(step => `${step.channel}:${step.label}`)).toEqual([
      'input:tap a',
      'command:command finish {"fast":true}',
      'input:invoke b .click',
    ]);
    expect(result.frames).toBe(6);
  });

  it('a routine with no expectations is a MACRO, never a pass', async () => {
    const { world } = makeWorld();
    const result = await runRoutine(world, routine());
    expect(result.verdict).toMatch(/^ROUTINE MACRO/);
    expect(result.verdict).toContain('NOTHING WAS ASSERTED');
    expect(result.expectations).toBeUndefined();
    expect(result.routine?.macro).toBe(true);
  });

  it('ANDs the expectations: one failure fails the routine and every entry is reported', async () => {
    const { world } = makeWorld({
      properties: { 'music-toggle.checked': false, 'settings-window.visible': true },
      present: ['music-toggle', 'settings-window'],
    });
    const result = await runRoutine(
      world,
      routine({
        uses: [],
        expect: [
          { kind: 'nodeProperty', name: 'music-toggle', path: 'checked', op: 'eq', value: false },
          {
            kind: 'nodeProperty',
            name: 'settings-window',
            path: 'visible',
            op: 'eq',
            value: false,
          },
        ],
      })
    );

    expect(result.verdict).toMatch(/^ROUTINE FAIL/);
    expect(result.verdict).toContain('1/2 expectation(s) held');
    expect(result.expectations?.map(entry => entry.met)).toEqual([true, false]);
    expect(result.expectations?.[1].detail).toContain('settings-window.visible');
  });

  it('passes when every expectation holds, and reports the game-state diff', async () => {
    const { world } = makeWorld({ state: { phase: 'ended' } });
    const result = await runRoutine(
      world,
      routine({
        uses: [],
        expect: [{ kind: 'gameState', path: 'phase', op: 'eq', value: 'ended' }],
      })
    );

    expect(result.verdict).toMatch(/^ROUTINE PASS/);
    expect(result.verdict).toContain('1/1 expectation(s) held');
    expect(result.game?.snapshot).toEqual({ phase: 'ended' });
  });

  it('stops at an undelivered step and judges nothing', async () => {
    const { world, runInput } = makeWorld({
      present: ['a'],
      dispatchCommand: () => null,
    });
    const result = await runRoutine(
      world,
      routine({
        uses: [],
        steps: [
          { type: 'tap', target: 'a' },
          { type: 'command', name: 'nope' },
          { type: 'tap', target: 'a' },
        ],
        expect: [{ kind: 'frames', n: 1 }],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.verdict).toMatch(/^ROUTINE FAIL/);
    expect(result.verdict).toContain('step 2');
    expect(result.verdict).toContain('NOT judged');
    // The third step never ran, so the input layer was called exactly once.
    expect(runInput).toHaveBeenCalledTimes(1);
    expect(result.steps).toHaveLength(2);
    expect(result.expectations?.[0].detail).toContain('not judged');
  });

  it('attributes a failed input batch to its first step and marks the rest as not run', async () => {
    const { world } = makeWorld({
      present: [],
      runInput: async () => ({ ok: false, error: 'no live node named "a"' }),
    });
    const result = await runRoutine(
      world,
      routine({
        uses: [],
        steps: [
          { type: 'tap', target: 'a' },
          { type: 'tap', target: 'b' },
        ],
      })
    );
    expect(result.steps?.[0].error).toContain('no live node');
    expect(result.steps?.[1].error).toContain('not run');
  });

  it('notes a missing debug provider instead of reporting a plain false', async () => {
    const { world } = makeWorld();
    const result = await runRoutine(
      world,
      routine({ uses: [], expect: [{ kind: 'gameState', path: 'phase', op: 'eq', value: 'x' }] })
    );
    expect(result.notes?.join(' ')).toContain('GameDebugProvider');
  });
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('InMemoryRoutineStore', () => {
  it('addresses a routine by bare name or full path, and answers null for an unknown one', async () => {
    const store = new InMemoryRoutineStore();
    store.put(routine({ name: 'buy-item' }));
    expect(await store.load('buy-item')).not.toBeNull();
    expect(await store.load(`${ROUTINE_DIRECTORY}/buy-item.json`)).not.toBeNull();
    expect(await store.load('sell-item')).toBeNull();
    expect((await store.loadAll()).routines).toHaveLength(1);
  });
});
