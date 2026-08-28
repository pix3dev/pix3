import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getGameDebug, Group2D, Label2D, type NodeBase } from '@pix3/runtime';

import { GameFlow } from './playable-3d/files/scripts/GameFlow';
import { GameRules } from './playable-3d/files/scripts/GameRules';

/**
 * The `playable-3d` template ships TWO scripts on one node — `GameFlow` (intro → playing → ended)
 * and `GameRules` (score, lives, clock, win/lose) — and a playable may have exactly one end screen
 * and exactly one `registerGameDebug` provider. That forces a contract between them that no other
 * template has, and every part of it is a silent failure when it breaks: a clock that runs behind
 * the tap gate, a run that ends with no outcome, a second ending that rewrites the result label.
 *
 * The scripts are project files, not engine code, so this is the only place they are executed. The
 * harness is deliberately thin — a real node with the real signal bus, and a scene stub carrying
 * only what the two scripts touch.
 */

type Rig = {
  root: Group2D;
  flow: GameFlow;
  rules: GameRules;
  endLabel: Label2D;
  intro: Group2D;
  endScreen: Group2D;
  snapshot: () => Record<string, unknown>;
  /** Advance the game loop, ticking both components in attach order. */
  tick: (seconds: number, steps?: number) => void;
};

const build = (rulesConfig: Record<string, unknown> = {}): Rig => {
  const root = new Group2D({ id: 'hud-root', name: 'HUD Root' });
  const intro = new Group2D({ id: 'intro-overlay', name: 'Intro Overlay' });
  const endScreen = new Group2D({ id: 'end-screen', name: 'End Screen' });
  const endLabel = new Label2D({ id: 'end-label', name: 'End Label', label: 'GREAT RUN!' });
  root.add(intro);
  root.add(endScreen);
  endScreen.add(endLabel);
  endScreen.visible = false;

  const flow = new GameFlow('game-flow', 'user:GameFlow');
  const rules = new GameRules('game-rules', 'user:GameRules');
  Object.assign(rules.config, rulesConfig);

  const commands = new Map<string, () => void>();
  const scene = {
    findNode: (query: string): NodeBase | null => root.findNode(query),
    commands: {
      register: (name: string, handler: () => void) => {
        commands.set(name, handler);
        return () => commands.delete(name);
      },
      dispatch: (name: string) => commands.get(name)?.(),
      list: () => [...commands.keys()].map(name => ({ name })),
    },
  };

  for (const component of [flow, rules]) {
    component.scene = scene as never;
    root.addComponent(component);
  }
  flow.onStart();
  rules.onStart();
  // Read through the same accessor the debug bridge uses — the assertions then see exactly what a
  // verification tool sees, not the components' private fields.
  const snapshot = (): Record<string, unknown> =>
    (getGameDebug()?.snapshot?.() as Record<string, unknown> | undefined) ?? {};

  return {
    root,
    flow,
    rules,
    endLabel,
    intro,
    endScreen,
    snapshot,
    tick: (seconds, steps = 1) => {
      for (let i = 0; i < steps; i++) {
        flow.onUpdate(seconds / steps);
        rules.onUpdate(seconds / steps);
      }
    },
  };
};

beforeAll(() => {
  // happy-dom has no canvas 2D context, and Label2D measures its text through one. Same minimal
  // stub as `ProjectTemplateScenes.spec.ts`, for the same reason.
  const canvasProto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => unknown;
  };
  canvasProto.getContext = vi.fn(() => ({
    setTransform: () => undefined,
    scale: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    fillRect: () => undefined,
    clearRect: () => undefined,
    fillText: () => undefined,
    strokeText: () => undefined,
    measureText: () => ({ width: 0 }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    shadowColor: '',
    shadowBlur: 0,
    font: '',
    textBaseline: '',
    textAlign: '',
  }));
});

afterEach(() => {
  // The provider lives on globalThis, so a leaked one would answer the next file's questions.
  delete (globalThis as unknown as Record<string, unknown>).__PIX3_GAME_DEBUG__;
});

describe('playable-3d: GameFlow + GameRules', () => {
  it('publishes ONE debug provider, with the rules’ numbers merged into it', () => {
    const rig = build();
    const snapshot = rig.snapshot();

    // GameFlow's own fields …
    expect(snapshot.phase).toBe('intro');
    // … and the rules', in the same JSON. A second registerGameDebug would have displaced this.
    expect(snapshot.score).toBe(0);
    expect(snapshot.lives).toBe(3);
    expect(snapshot.outcome).toBeNull();
  });

  /**
   * The bug this pins: the rules used to tick from the moment the scene loaded, so a
   * `survive` run with a time limit was WON while the tap gate was still on screen.
   */
  it('does not run the clock or judge the win while the tap gate is up', () => {
    const rig = build({ winMode: 'survive', timeLimitSec: 5 });

    rig.tick(10, 10);

    expect(rig.snapshot().phase).toBe('intro');
    expect(rig.snapshot().outcome).toBeNull();
    expect(rig.endScreen.visible).toBe(false);
  });

  it('starts the run when the gate opens, and then judges it', () => {
    const rig = build({ winMode: 'survive', timeLimitSec: 5 });

    rig.flow.start();
    expect(rig.snapshot().running).toBe(true);

    rig.tick(6, 6);

    expect(rig.snapshot().outcome).toBe('won');
    expect(rig.snapshot().phase).toBe('ended');
    expect(rig.endScreen.visible).toBe(true);
    expect(rig.endLabel.label).toBe('YOU WIN!');
  });

  /**
   * The other half: when the run ends through GameFlow (its placeholder timer, or a `finish`
   * dispatched by a routine), the rules must stop and record a verdict. Otherwise the snapshot
   * read `phase: 'ended'` with `outcome: null`, the label kept its authored text, and a time
   * limit fired a SECOND ending that rewrote the label behind the end screen.
   */
  it('records an outcome when the flow ends the run', () => {
    const rig = build({ winMode: 'score', targetScore: 3, timeLimitSec: 30 });
    rig.flow.start();
    rig.rules.addScore(1);

    rig.flow.finish();

    expect(rig.snapshot().phase).toBe('ended');
    expect(rig.snapshot().outcome).toBe('lost'); // 1 < targetScore 3
    expect(rig.endLabel.label).toBe('GAME OVER');
    expect(rig.snapshot().running).toBe(false);

    const labelAfterEnd = rig.endLabel.label;
    rig.tick(60, 60);
    expect(rig.endLabel.label).toBe(labelAfterEnd);
  });

  it('scores through the signal channel, with no reference to the component', () => {
    const rig = build({ targetScore: 2 });
    rig.flow.start();

    rig.root.emit('score-added', 2);

    expect(rig.snapshot().score).toBe(2);
    rig.tick(0.016);
    expect(rig.snapshot().outcome).toBe('won');
  });

  it('restart puts the gate back AND resets the score', () => {
    const rig = build();
    rig.flow.start();
    rig.rules.addScore(5);

    rig.flow.restart();

    expect(rig.snapshot().phase).toBe('intro');
    expect(rig.snapshot().score).toBe(0);
    // Back behind the gate: a reset that left the clock running would spend the next intro
    // overlay burning the new run's time limit.
    expect(rig.snapshot().running).toBe(false);
  });

  it('skipIntro opens the gate at start, so the run is live immediately', () => {
    const rig = build();
    rig.flow.config.skipIntro = true;
    rig.flow.restart();

    expect(rig.snapshot().phase).toBe('playing');
    expect(rig.snapshot().running).toBe(true);
    expect(rig.intro.visible).toBe(false);
  });
});
