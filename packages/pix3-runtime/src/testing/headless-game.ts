import { AssetLoader } from '../core/AssetLoader';
import { AudioService } from '../core/AudioService';
import type { GameCommandArgs, GameCommandRegistry } from '../core/GameCommands';
import { getGameDebug, registerScriptErrorSink, type ScriptErrorInfo } from '../core/game-debug';
import { ResourceManager, type EmbeddedResourceMap } from '../core/ResourceManager';
import type { RuntimeRenderer } from '../core/RuntimeRenderer';
import { SceneLoader } from '../core/SceneLoader';
import { SceneManager } from '../core/SceneManager';
import { SceneRunner } from '../core/SceneRunner';
import type { SceneService } from '../core/SceneService';
import { ScriptRegistry, type ComponentTypeInfo } from '../core/ScriptRegistry';
import { registerBuiltInScripts } from '../behaviors/register-behaviors';
import type { NodeBase } from '../nodes/NodeBase';

import { installCanvas2DStub } from './canvas-2d-stub';

/**
 * Boot a real scene, advance it a fixed number of steps, and read its state — with no browser, no
 * dev server and no debugger round trip.
 *
 * ## Why this exists
 *
 * Building the Carrom sample shipped a bug where the striker was placed on the opposing baseline,
 * aimed off the board. The game was 100 % unplayable. It passed `tsc --noEmit`, `prettier --check`,
 * YAML validation of every scene, a headless `SceneLoader.parseScene` that asserted the striker's
 * world position, and a set of hand-written geometry cross-checks — because the authored coordinate
 * in the scene file was correct and nothing at load time calls the function that derived the wrong
 * one. What caught it was running the AI against the rack and measuring the contact rate: 0.000.
 *
 * That is the shape of the whole problem. Static gates check the artefact; only motion checks the
 * *behaviour*, and until now the only way to put a Pix3 scene in motion was to start a dev server,
 * open Chrome, load a project, enter play mode and poll over an MCP connection. So behavioural
 * checks were the most expensive thing in the pipeline and were skipped accordingly.
 *
 * ## What it is not
 *
 * Nothing renders. There is no GL context and no rasterizer, so this cannot answer "does it look
 * right", "is the sprite visible", "did the shader compile" — those stay a screenshot's job, in the
 * editor. What it answers is everything downstream of a number: positions, velocities, scores, turn
 * order, signals, command effects, conservation laws, whether a run settles, whether it errors.
 *
 * ## Shape of a test
 *
 * ```ts
 * const game = await createHeadlessGame({
 *   files: readProjectFiles('samples/Carrom'),       // caller owns node:fs
 *   scripts: { CarromRules, CarromAI },
 * });
 * await game.start('scenes/main.pix3scene');
 * game.dispatch('shoot', { angleDeg: 90, power: 1 });
 * await game.step(600);                              // 10 s of game time, ~instant
 * expect(game.snapshot().settled).toBe(true);
 * expect(game.errors).toEqual([]);
 * game.dispose();
 * ```
 *
 * The file seam is deliberate. `@pix3/runtime` is a browser library and must not import `node:fs`;
 * the caller reads the files and hands them over, which also means the same harness drives a project
 * held in memory, in OPFS, or assembled by a generator.
 */
export interface HeadlessGameOptions {
  /**
   * Project files keyed by **project-relative path** — `'scenes/main.pix3scene'`, not `'res://…'`
   * and not an absolute path. Text arrives as a string, binary as bytes.
   *
   * Only what the run touches has to be present; a `res://` miss behaves as it does in a
   * single-file export (the asset does not load) rather than failing the boot, which is what lets a
   * logic test skip megabytes of art.
   */
  readonly files: Readonly<Record<string, string | Uint8Array>>;

  /**
   * User script classes, keyed by the name scenes reference as `type: user:<Name>`.
   *
   * These are the project's own compiled classes, imported directly by the spec. Built-in `core:*`
   * behaviours are always registered and need no entry here.
   */
  readonly scripts?: Readonly<Record<string, ComponentTypeInfo['componentClass']>>;

  /** Design resolution that anchor layout resolves against. Defaults to 1920×1080. */
  readonly viewport?: { readonly width: number; readonly height: number };

  /** Seconds of game time per {@link HeadlessGame.step}. Defaults to 1/60. */
  readonly fixedDeltaSec?: number;
}

export interface HeadlessGame {
  /** The live runner — for anything this facade does not wrap. */
  readonly runner: SceneRunner;
  /** The scripts-facing scene API: `commands`, `juice`, `time`, `physics2d`, `audio`, … */
  readonly scene: SceneService;
  /** The game's command registry — the same one `this.scene.commands` gives a script. */
  readonly commands: GameCommandRegistry;
  /**
   * Script and lifecycle failures captured since the run started, in order.
   *
   * This is the field that makes a green test trustworthy. A component that throws in
   * `onStart`/`onUpdate` is **auto-disabled** by the engine and the game keeps running, looking
   * fine while the thing that threw is frozen — so a run that asserts only on the final state can
   * pass with half the game dead. Assert this is empty.
   */
  readonly errors: readonly ScriptErrorInfo[];

  /** Load a `.pix3scene` by project-relative path (a `res://` prefix is accepted) and start it. */
  start(scenePath: string): Promise<void>;
  /**
   * Advance exactly `frames` fixed steps. Returns how many actually ran (short of `frames` when
   * the scene stopped or a tick threw).
   *
   * **Await it.** Real games do asynchronous work from inside a frame — `scene.instantiate` spawns
   * a prefab, `changeScene` loads a file, an asset resolves — and in a browser those continuations
   * land between animation frames because each frame is its own task. A synchronous loop of ticks
   * gives them nowhere to run, so a prefab spawned in `onStart` would still not exist 600 frames
   * later and the game under test would be a different game. This yields between ticks so the
   * engine's own promises settle in the gaps, exactly as they do live.
   */
  step(frames?: number): Promise<number>;
  /** Advance approximately `seconds` of game time, rounded up to whole steps. */
  run(seconds: number): Promise<number>;
  /**
   * Let pending asynchronous work finish without advancing game time.
   *
   * Use after an action whose effect is loaded rather than computed — `changeScene`, a command that
   * instantiates — when the next assertion must see the result and no frames should pass first.
   */
  flush(): Promise<void>;
  /** Dispatch a registered game command. Returns false when no such command exists. */
  dispatch(name: string, args?: GameCommandArgs): boolean;
  /** The game's `registerGameDebug` snapshot, or `null` when it registered no provider. */
  snapshot(): Record<string, unknown> | null;
  /** Ask the game's debug provider a named question. */
  inspect(query: string, args?: unknown): unknown;
  /** Find a live node by name (forward DFS, first match). */
  findNode(name: string): NodeBase | null;
  /** Find a live node by its id. */
  getNode(id: string): NodeBase | null;
  /** Every live root node of the running scene. */
  roots(): readonly NodeBase[];
  /** Stop the run and release the stub/sink globals. Safe to call twice. */
  dispose(): void;
  /** {@link dispose}, after letting in-flight engine promises land. Prefer this in `afterEach`. */
  disposeAsync(): Promise<void>;
}

/**
 * A `RuntimeRenderer` that owns no GL context.
 *
 * `RuntimeRenderer` builds a real `WebGLRenderer` in its constructor, so it cannot be subclassed
 * here; this is the same structural double that specs across the runtime have been hand-rolling,
 * packaged once. The run never paints (see `renderEveryNTicks` below), so these are called at most
 * once — `SceneRunner` paints the loaded scene a single time when it starts in `manual` mode.
 *
 * `getWebGLRenderer` throws rather than returning a stub: it is reached only when a `PostProcess`
 * node builds a composer, and post-processing without a GL context has no meaningful headless
 * answer. A loud failure naming the cause beats a run that silently skips the effect stack.
 */
function createNullRenderer(width: number, height: number): RuntimeRenderer {
  const canvas = globalThis.document?.createElement('canvas') ?? ({} as HTMLCanvasElement);
  Object.defineProperty(canvas, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });

  return {
    domElement: canvas,
    beginStatsFrame: () => {},
    render: () => {},
    setAutoClear: () => {},
    clear: () => {},
    clearDepth: () => {},
    getStatsSnapshot: () => ({
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    }),
    getWebGLRenderer: () => {
      throw new Error(
        '[headless] This scene has an active PostProcess node, which needs a WebGL context. ' +
          'Disable post-processing for the headless run, or verify that part in the editor.'
      );
    },
  } as unknown as RuntimeRenderer;
}

/** Bytes → base64, without `Buffer` (which a browser-targeted package cannot assume). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Reuse the single-file export's own asset mechanism rather than inventing a second one.
 *
 * `ResourceManager` already resolves `res://` out of an embedded base64 map — that is how a
 * playable HTML build works — so handing it one gives a headless run the exact asset resolution a
 * shipped game has, including the miss behaviour, with no new code path to keep honest.
 */
function toEmbeddedResources(
  files: Readonly<Record<string, string | Uint8Array>>
): EmbeddedResourceMap {
  const encoder = new TextEncoder();
  const map: Record<string, { base64: string }> = {};
  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    map[path] = { base64: toBase64(bytes) };
  }
  return map;
}

/**
 * A `ResourceManager` with the network amputated.
 *
 * Without this, a `res://` path that is not in `files` falls through to `fetch()` against the
 * document's origin — which in a test environment is a localhost port nobody is serving. The result
 * is a wall of `ECONNREFUSED` for every missing sprite, several seconds of connect timeouts, and a
 * misleading story: the run looks like it has a networking problem when it simply was not given the
 * file. Failing at the miss says what is actually wrong, and is instant.
 *
 * Missing *art* is still not an error — `AssetLoader` catches a failed texture load and leaves the
 * node untextured, which is what makes it reasonable to run a logic test without shipping megabytes
 * of sprites. What this changes is only how the miss is reported.
 */
class OfflineResourceManager extends ResourceManager {
  protected override async fetchText(url: string): Promise<string> {
    throw new Error(
      `[headless] "${url}" is not in the files map and there is no network here. ` +
        'Add it to `createHeadlessGame({ files })`, keyed by its project-relative path.'
    );
  }

  protected override async fetchBlob(url: string): Promise<Blob> {
    throw new Error(
      `[headless] "${url}" is not in the files map and there is no network here. ` +
        'Add it to `createHeadlessGame({ files })` (binary content as a Uint8Array), or ignore ' +
        'this if the asset is art the assertions do not depend on.'
    );
  }
}

/**
 * Paint never, so the null renderer is never asked to do anything real.
 *
 * `renderEveryNTicks` is clamped to >= 1 and compared with `>=` against a per-tick counter, so a
 * value this large means the branch cannot be reached inside any run a test would write. Setting it
 * to 0 or negative is not an option (the config rejects it), and letting it render every tick would
 * walk the whole 2D order + batching path for nothing.
 */
const NEVER_RENDER = Number.MAX_SAFE_INTEGER;

export async function createHeadlessGame(options: HeadlessGameOptions): Promise<HeadlessGame> {
  const canvasStub = installCanvas2DStub();
  const viewport = options.viewport ?? { width: 1920, height: 1080 };
  const fixedDeltaSec = options.fixedDeltaSec ?? 1 / 60;

  const resourceManager = new OfflineResourceManager('./', toEmbeddedResources(options.files));
  const audioService = new AudioService();
  const assetLoader = new AssetLoader(resourceManager, audioService);

  const scriptRegistry = new ScriptRegistry();
  registerBuiltInScripts(scriptRegistry);
  for (const [name, componentClass] of Object.entries(options.scripts ?? {})) {
    scriptRegistry.registerComponent({
      id: `user:${name}`,
      displayName: name,
      description: `Project script ${name} (headless run).`,
      category: 'user',
      componentClass,
      keywords: [],
    });
  }

  const sceneLoader = new SceneLoader(assetLoader, scriptRegistry, resourceManager);
  // No SceneSaver: a headless run never writes scenes back, and omitting it keeps this harness on
  // the same "player" path an export takes rather than the editor's.
  const sceneManager = new SceneManager(sceneLoader);
  const renderer = createNullRenderer(viewport.width, viewport.height);
  const runner = new SceneRunner(sceneManager, renderer, audioService, assetLoader, viewport);

  const errors: ScriptErrorInfo[] = [];
  const releaseErrorSink = registerScriptErrorSink(error => {
    errors.push(error);
  });

  // Manual time is the whole point: no animation frame is ever scheduled, ticks come only from
  // `stepFrames`, and the run advances as fast as the CPU allows instead of in wall-clock time.
  runner.setTimeMode({
    mode: 'manual',
    fixedDeltaSec,
    renderEveryNTicks: NEVER_RENDER,
    muteAudio: true,
  });

  /**
   * Drain the microtask queue, then one macrotask.
   *
   * The two are not interchangeable. Chained `await`s inside the engine resolve as microtasks, but
   * anything that goes through a timer or an event (an asset callback, a debounce) needs a real
   * task turn, and a game that spawns from a spawn needs several microtask rounds. This is the
   * cheapest thing that covers all three, and it is why stepping is asynchronous at all.
   */
  const flushPending = async (rounds = 1): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
      await new Promise<void>(resolveTurn => {
        setTimeout(resolveTurn, 0);
      });
    }
  };

  /**
   * Turns granted to a scene's own start-up work before the first assertion.
   *
   * A game's `onStart` routinely spawns a rack of prefabs with `await` in a loop, and each spawn
   * parses a file — so the work is a long *chain* of promises, not a batch, and one turn resolves
   * one link. Under-flushing here does not fail; it hands the test a half-built board that looks
   * like a game with a rules bug, which is the most expensive way for a harness to be wrong.
   * 128 turns of an empty event loop costs single-digit milliseconds.
   */
  const START_UP_FLUSH_ROUNDS = 128;

  let disposed = false;

  /**
   * The `SceneService` a script sees, reached the way a script reaches it.
   *
   * The runner injects itself into every root node as `node.scene`, and that is the only public
   * route to it — `SceneRunner` exposes no accessor. Going through a live node instead of adding
   * one keeps this harness a *consumer* of the runtime's existing surface rather than a reason to
   * widen it, and it fails honestly: with no scene running there is no scene service to hand back.
   */
  const sceneService = (): SceneService => {
    const service = runner.getLiveRootNodes()[0]?.scene;
    if (!service) {
      throw new Error(
        "[headless] No scene is running — call `await game.start('scenes/…')` first."
      );
    }
    return service;
  };

  const game: HeadlessGame = {
    runner,
    get scene() {
      return sceneService();
    },
    get commands() {
      return sceneService().commands;
    },
    errors,

    async start(scenePath: string): Promise<void> {
      await runner.loadAndStartScene(scenePath);
      // Components spawn from `onStart`, which the first `updateNodes` inside `runGraph` triggers.
      // Those spawns are promises; without this the caller's very first assertion races them.
      await flushPending(START_UP_FLUSH_ROUNDS);
    },

    async step(frames = 1): Promise<number> {
      let executed = 0;
      for (let i = 0; i < frames; i += 1) {
        const ran = runner.stepFrames(1);
        if (ran === 0) {
          break;
        }
        executed += ran;
        await flushPending();
      }
      return executed;
    },

    async run(seconds: number): Promise<number> {
      return await game.step(Math.ceil(seconds / fixedDeltaSec));
    },

    flush: () => flushPending(START_UP_FLUSH_ROUNDS),

    dispatch(name: string, args?: GameCommandArgs): boolean {
      return sceneService().commands.dispatch(name, args);
    },

    snapshot(): Record<string, unknown> | null {
      return getGameDebug()?.snapshot?.() ?? null;
    },

    inspect(query: string, args?: unknown): unknown {
      return getGameDebug()?.inspect?.(query, args);
    },

    findNode(name: string): NodeBase | null {
      return runner.findLiveNodeByName(name);
    },

    getNode(id: string): NodeBase | null {
      return runner.getLiveNodeById(id);
    },

    roots(): readonly NodeBase[] {
      return runner.getLiveRootNodes();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      runner.stop();
      releaseErrorSink();
      canvasStub.uninstall();
    },

    async disposeAsync(): Promise<void> {
      // Give in-flight engine promises (a spawn, a scene load) a chance to land before the runner
      // is torn out from under them — otherwise tearing down mid-spawn surfaces as an unhandled
      // rejection attributed to whichever test happened to be running.
      await flushPending(START_UP_FLUSH_ROUNDS);
      game.dispose();
    },
  };

  return game;
}
