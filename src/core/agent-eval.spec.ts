import { describe, expect, it } from 'vitest';
import {
  runEvalSpec,
  EVAL_CHECK_KINDS,
  type EvalCheck,
  type EvalHarness,
  type EvalImageStats,
  type EvalToolCall,
} from './agent-eval';
import type { Json } from './agent-introspection';

interface FakeNode {
  nodeId: string;
  name: string;
  type: string;
  properties?: Json;
  components?: Array<{ className: string; scriptId: string | null }>;
}

interface FakeOptions {
  toolCalls?: EvalToolCall[];
  /** Result (or factory) per tool name for executeTool. */
  toolResults?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  nodes?: FakeNode[];
  errors?: Array<{ source: string; message: string }>;
  /** isPlaying value after a successful play_start (default true). */
  playingAfterStart?: boolean;
  imageStats?: Record<string, EvalImageStats | null>;
}

/** In-memory harness: scripted tool results, a tiny scene, a controllable play flag. */
function fakeHarness(options: FakeOptions = {}): EvalHarness & {
  executed: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const nodes = options.nodes ?? [];
  let errors = [...(options.errors ?? [])];
  let playing = false;
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];

  return {
    executed,
    async executeTool(name, args = {}) {
      executed.push({ name, args });
      if (name === 'play_start') {
        playing = options.playingAfterStart ?? true;
        return { ok: true };
      }
      if (name === 'play_stop') {
        playing = false;
        return { ok: true };
      }
      const scripted = options.toolResults?.[name];
      if (scripted === undefined) {
        throw new Error(`no scripted result for tool ${name}`);
      }
      return typeof scripted === 'function' ? scripted(args) : scripted;
    },
    toolCalls: () => options.toolCalls ?? [],
    agentSummary: () => ({
      status: 'idle',
      notice: null,
      messageCount: 7,
      inputTokens: 1000,
      outputTokens: 50,
    }),
    findNodes(query) {
      const needle = query.toLowerCase();
      return nodes.filter(
        n => n.name.toLowerCase().includes(needle) || n.type.toLowerCase().includes(needle)
      );
    },
    nodeDetail(nodeId) {
      const node = nodes.find(n => n.nodeId === nodeId);
      if (!node) return null;
      return { properties: node.properties ?? null, components: node.components ?? [] };
    },
    errors: () => errors,
    clearErrors: () => {
      errors = [];
    },
    isPlaying: () => playing,
    imageStats: async path => options.imageStats?.[path] ?? null,
    wait: async () => {},
  };
}

const run = (harness: EvalHarness, checks: EvalCheck[]) =>
  runEvalSpec(harness, { name: 'spec', checks });

describe('runEvalSpec — tool-trace checks', () => {
  const calls: EvalToolCall[] = [
    { name: 'fs_list', input: { path: 'design' } },
    { name: 'read_skill', input: { id: 'game-prototype' } },
    { name: 'analyze_image', input: { source: 'design/ref.jpg' } },
    { name: 'generate_asset', input: { prompt: 'car', transparent: true } },
  ];

  it('finds a call by name, args regex, and position', async () => {
    const harness = fakeHarness({ toolCalls: calls });
    const report = await run(harness, [
      {
        kind: 'tool-called',
        tool: 'read_skill',
        inputMatch: 'game-prototype',
        withinFirstCalls: 2,
      },
      { kind: 'tool-called', tool: 'generate_asset', inputMatch: '"transparent":true' },
    ]);
    expect(report.ok).toBe(true);
    expect(report.checks[0].detail).toContain('call #2');
  });

  it('fails when the call happened but not early enough', async () => {
    const harness = fakeHarness({ toolCalls: calls });
    const report = await run(harness, [
      { kind: 'tool-called', tool: 'generate_asset', withinFirstCalls: 2 },
    ]);
    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toContain('within the first 2');
  });

  it('checks call order and reports a missing side', async () => {
    const harness = fakeHarness({ toolCalls: calls });
    const report = await run(harness, [
      { kind: 'tool-order', first: 'analyze_image', then: 'generate_asset' },
      { kind: 'tool-order', first: 'generate_asset', then: 'analyze_image' },
      { kind: 'tool-order', first: 'play_start', then: 'generate_asset' },
    ]);
    expect(report.checks.map(c => c.pass)).toEqual([true, false, false]);
    expect(report.checks[2].detail).toContain('never called: play_start');
  });
});

describe('runEvalSpec — compile checks', () => {
  it('passes on a clean compile and surfaces failures with location', async () => {
    const clean = fakeHarness({ toolResults: { compile_scripts: { ok: true, fileCount: 4 } } });
    expect((await run(clean, [{ kind: 'compile-clean' }])).ok).toBe(true);

    const broken = fakeHarness({
      toolResults: {
        compile_scripts: {
          ok: false,
          error: 'already declared',
          file: 'scripts/Car.ts',
          line: 127,
        },
      },
    });
    const report = await run(broken, [{ kind: 'compile-clean' }]);
    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toContain('scripts/Car.ts:127');
  });

  it('optionally requires a clean type check too', async () => {
    const harness = fakeHarness({
      toolResults: {
        compile_scripts: { ok: true, fileCount: 4 },
        check_scripts: { ok: true, filesChecked: 4, errorCount: 2, warningCount: 0 },
      },
    });
    const report = await run(harness, [{ kind: 'compile-clean', typeCheck: true }]);
    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toContain('2 error(s)');
  });
});

describe('runEvalSpec — scene checks', () => {
  const nodes: FakeNode[] = [
    {
      nodeId: 'n1',
      name: 'Player Car',
      type: 'Sprite2D',
      properties: { texture: 'res://src/assets/textures/player_car.png' },
      components: [{ className: 'CarController', scriptId: 'user:CarController' }],
    },
    { nodeId: 'n2', name: 'AI Car 1', type: 'Sprite2D' },
    { nodeId: 'n3', name: 'HUD', type: 'Group2D' },
  ];

  it('node-exists filters by name substring, type, and minCount', async () => {
    const harness = fakeHarness({ nodes });
    const report = await run(harness, [
      { kind: 'node-exists', name: 'car', type: 'Sprite2D', minCount: 2 },
      { kind: 'node-exists', name: 'car', minCount: 3 },
    ]);
    expect(report.checks[0].pass).toBe(true);
    expect(report.checks[1].pass).toBe(false);
  });

  it('node-component matches against scriptId and className', async () => {
    const harness = fakeHarness({ nodes });
    const report = await run(harness, [
      { kind: 'node-component', node: 'Player Car', componentType: 'user:CarController' },
      { kind: 'node-component', node: 'AI Car 1' },
    ]);
    expect(report.checks[0].pass).toBe(true);
    expect(report.checks[1].pass).toBe(false);
  });

  it('node-property resolves a path and supports equals/matches', async () => {
    const harness = fakeHarness({ nodes });
    const report = await run(harness, [
      {
        kind: 'node-property',
        node: 'Player Car',
        property: 'texture',
        matches: '^res://.*\\.png$',
      },
      {
        kind: 'node-property',
        node: 'Player Car',
        property: 'texture',
        equals: 'res://other.png',
      },
      { kind: 'node-property', node: 'Player Car', property: 'missing' },
    ]);
    expect(report.checks.map(c => c.pass)).toEqual([true, false, false]);
    expect(report.checks[2].detail).toContain('not set');
  });
});

describe('runEvalSpec — file and asset checks', () => {
  it('file check reads content and enforces contains', async () => {
    const harness = fakeHarness({
      toolResults: {
        fs_read: (args: Record<string, unknown>) =>
          args.path === 'design/progress.md'
            ? { path: args.path, content: '# Plan\n- [x] screens\n- [ ] win/lose' }
            : (() => {
                throw new Error('File not found');
              })(),
      },
    });
    const report = await run(harness, [
      { kind: 'file', path: 'design/progress.md', contains: '- [x]' },
      { kind: 'file', path: 'design/missing.md' },
    ]);
    expect(report.checks[0].pass).toBe(true);
    expect(report.checks[1].pass).toBe(false);
  });

  it('asset check measures alpha and dimensions deterministically', async () => {
    const harness = fakeHarness({
      imageStats: {
        'src/assets/car.png': {
          width: 512,
          height: 280,
          bytes: 280_000,
          hasAlpha: true,
          transparentFraction: 0.59,
        },
        'src/assets/raw.png': {
          width: 2048,
          height: 2048,
          bytes: 4_000_000,
          hasAlpha: false,
          transparentFraction: 0,
        },
      },
    });
    const report = await run(harness, [
      { kind: 'asset', path: 'src/assets/car.png', requireAlpha: true, maxDimension: 1024 },
      { kind: 'asset', path: 'src/assets/raw.png', requireAlpha: true },
      { kind: 'asset', path: 'src/assets/nope.png' },
    ]);
    expect(report.checks[0].pass).toBe(true);
    expect(report.checks[1].pass).toBe(false);
    expect(report.checks[1].detail).toContain('background not removed');
    expect(report.checks[2].pass).toBe(false);
  });
});

describe('runEvalSpec — play and gameplay checks', () => {
  it('play-clean passes on an error-free run and stops play afterwards', async () => {
    const harness = fakeHarness({});
    const report = await run(harness, [{ kind: 'play-clean', settleMs: 10 }]);
    expect(report.ok).toBe(true);
    expect(harness.executed.map(e => e.name)).toEqual(['play_start', 'play_stop']);
    expect(harness.isPlaying()).toBe(false);
  });

  it('play-clean fails when errors are captured during the settle window', async () => {
    // The error "appears" while the check waits — exactly how a component that throws in
    // onStart shows up in the real editor.
    const harness = fakeHarness({});
    const errs: Array<{ source: string; message: string }> = [];
    harness.clearErrors = () => {
      errs.length = 0;
    };
    harness.errors = () => errs;
    harness.wait = async () => {
      errs.push({ source: 'console', message: "Cannot assign to read only property 'rotation'" });
    };
    const report = await run(harness, [{ kind: 'play-clean', settleMs: 10 }]);
    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toContain('read only property');
  });

  it('input-moves starts play when needed and verifies the moved flags', async () => {
    const harness = fakeHarness({
      toolResults: {
        game_input: {
          ok: true,
          stepsRun: 1,
          resumedFromFocusPause: false,
          newErrors: [],
          observed: {
            'Player Car': { moved: true, delta: { x: 0, y: 120, z: 0, distance: 120 } },
            'AI Car 1': { moved: false },
          },
        },
      },
    });
    const pass = await run(harness, [
      {
        kind: 'input-moves',
        steps: [{ type: 'key', code: 'ArrowUp', ms: 800 }],
        observe: ['Player Car'],
      },
    ]);
    expect(pass.ok).toBe(true);
    expect(harness.executed.map(e => e.name)).toEqual(['play_start', 'game_input', 'play_stop']);

    const fail = await run(harness, [
      {
        kind: 'input-moves',
        steps: [{ type: 'key', code: 'ArrowUp', ms: 800 }],
        observe: ['Player Car', 'AI Car 1'],
      },
    ]);
    expect(fail.ok).toBe(false);
    expect(fail.checks[0].detail).toContain('AI Car 1: did NOT move');
  });

  it('observe-moving reads the movement flags from game_observe', async () => {
    const harness = fakeHarness({
      toolResults: {
        game_observe: {
          ok: true,
          movement: { 'AI Car 1': { moved: true, delta: { x: 3, y: 4, z: 0, distance: 5 } } },
        },
      },
    });
    const report = await run(harness, [
      { kind: 'observe-moving', nodes: ['AI Car 1'], sampleMs: 500 },
    ]);
    expect(report.ok).toBe(true);
    expect(report.checks[0].detail).toContain('AI Car 1: moving');
  });
});

describe('runEvalSpec — report shape', () => {
  it('a throwing check fails that check without aborting the run', async () => {
    const harness = fakeHarness({ toolCalls: [{ name: 'scene_tree', input: {} }] });
    const report = await run(harness, [
      { kind: 'compile-clean' }, // no scripted result → executeTool throws
      { kind: 'tool-called', tool: 'scene_tree' },
      { kind: 'no-errors' },
    ]);
    expect(report.checks[0].pass).toBe(false);
    expect(report.checks[0].detail).toContain('check threw');
    expect(report.checks[1].pass).toBe(true);
    expect(report.checks[2].pass).toBe(true);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.agent.messageCount).toBe(7);
  });

  it('exports the full check-kind list for spec authoring', () => {
    expect(EVAL_CHECK_KINDS).toContain('input-moves');
    expect(EVAL_CHECK_KINDS.length).toBe(12);
  });
});
