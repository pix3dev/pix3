import {
  AudioService,
  describeThrown,
  getGameDebug,
  NodeBase,
  registerBuiltInScripts,
  registerScriptErrorSink,
  SceneLoader,
  SceneManager,
  SceneRunner,
  SceneValidationError,
  ScriptRegistry,
  setPostprocessingModuleLoader,
  type LocalizationConfig,
  type RuntimeRenderer,
  type ScriptErrorInfo,
} from '@pix3/runtime';
import {
  DiskResourceManager,
  MissingResourceError,
  NodeAssetLoader,
  ResourceNotDecodedError,
} from '@pix3/runtime/node';

import { ProjectFiles } from '../validate/project.ts';
import { scanUserScripts } from '../validate/user-scripts.ts';
import { isRecord } from '../validate/yaml-doc.ts';
import { compileAndImportScripts, type ScriptImportUrls } from './compile-scripts.ts';
import { installDomShim } from './dom-shim.ts';
import type {
  SmokeError,
  SmokeErrorCode,
  SmokeJob,
  SmokeOutcome,
  SmokeReport,
  SmokeWarning,
  SmokeWarningCode,
} from './report.ts';

/**
 * The game loop of `pix3 smoke`, run inside a worker thread (`worker.ts`): the project's scripts
 * compiled and registered, the scene loaded from disk by the real `SceneLoader`, a real
 * `SceneRunner` in manual time stepping fixed 1/60 s frames — the same assembly as the runtime's
 * `createHeadlessGame` (`@pix3/runtime/testing`), with two differences a CLI needs: files come
 * from the project folder (`DiskResourceManager`, so nothing is base64-copied up front and a miss
 * is a precise `MissingResourceError`), and assets are checked for existence rather than decoded
 * (`NodeAssetLoader`: textures are empty, glTF models and Spine skeletons are not built).
 *
 * Stubbed, by construction: rendering (a null renderer — nothing is ever painted), audio (no
 * `AudioContext` in Node, so the `AudioService` is inert), input (the canvas never receives an
 * event), network (no `NetworkService` is installed; `scene.network` is null), post-processing
 * (never loaded; the runner stays on its plain path).
 */

/** Paint never (see `createHeadlessGame`): `renderEveryNTicks` must be ≥ 1, so "unreachable". */
const NEVER_RENDER = Number.MAX_SAFE_INTEGER;

/** Turns of the event loop granted to `onStart` spawn chains before frame 1 (as the harness). */
const START_UP_FLUSH_ROUNDS = 128;

/**
 * A `RuntimeRenderer` that owns no GL context (the harness's null renderer, plus one answer).
 *
 * `getWebGLRenderer` is reached only when a `PostProcess` node makes the runner build its effect
 * composer. The composer merely stores the renderer until the `postprocessing` module has loaded,
 * and the smoke run installs a module loader that never settles, so the runner stays on its plain
 * path forever: the placeholder is never used. The call is still counted, for the report.
 */
const createNullRenderer = (
  canvas: HTMLCanvasElement,
  onPostProcess: () => void
): RuntimeRenderer =>
  ({
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
      onPostProcess();
      return { getSize: () => ({ x: 1, y: 1 }), getPixelRatio: () => 1 };
    },
  }) as unknown as RuntimeRenderer;

const flushPending = async (rounds = 1): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    await new Promise<void>(resolveTurn => setTimeout(resolveTurn, 0));
  }
};

const countNodes = (roots: readonly NodeBase[]): number => {
  let count = 0;
  const visit = (node: NodeBase): void => {
    count += 1;
    for (const child of node.children) if (child instanceof NodeBase) visit(child);
  };
  roots.forEach(visit);
  return count;
};

const formatArg = (arg: unknown): string => {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
};

/** Browser globals whose absence is a DOM problem, not a script bug. */
const DOM_GLOBAL =
  /\b(window|document|navigator|localStorage|sessionStorage|requestAnimationFrame|customElements|getComputedStyle|matchMedia|ResizeObserver|IntersectionObserver|MutationObserver|FontFace|OffscreenCanvas|createImageBitmap|DOMParser|XMLHttpRequest|Image|Audio|AudioContext|HTML\w*Element|Element|Node|Event|PointerEvent|KeyboardEvent|MouseEvent|TouchEvent|CustomEvent|WebGL\w*|Worker)\b is not defined/;

/** `console.log`/`info` lines kept for the report (the rest are counted). */
const MAX_LOG_LINES = 40;

const PENDING = /Component type "(.*?)" is not registered yet — kept as pending on node "(.*?)"/;

/** Engine re-reports of a failure the error sink already delivered. */
const ENGINE_REPORTS = [
  /^\[NodeBase\] Script ".*" threw in/,
  /^\[SceneRunner\] Error during game update/,
  /^\[GameCommands\]/,
];

export const runSmokeJob = async (
  job: SmokeJob,
  imports: ScriptImportUrls
): Promise<SmokeOutcome> => {
  const startedAt = performance.now();
  let frame = 0;
  const errors: SmokeError[] = [];
  const warningsByKey = new Map<string, { warning: SmokeWarning; count: number }>();
  const notes: string[] = [];
  const dom = installDomShim(job.viewport);

  const addError = (error: Omit<SmokeError, 'frame' | 'domAccess'> & { frame?: number }): void => {
    const recent = dom.takeRecentMissing();
    const domRelated =
      DOM_GLOBAL.test(error.message) || (recent.length > 0 && /^TypeError\b/.test(error.message));
    errors.push({
      ...error,
      code: domRelated ? 'E_SMOKE_DOM' : error.code,
      frame: error.frame ?? frame,
      ...(domRelated && recent.length > 0 ? { domAccess: recent.slice(-5) } : {}),
    });
  };
  const addWarning = (code: SmokeWarningCode, message: string): void => {
    const key = `${code}\u0000${message}`;
    const existing = warningsByKey.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    warningsByKey.set(key, { warning: { code, frame, message }, count: 1 });
  };

  let modelsNotDecoded = 0;
  const original = {
    warn: console.warn,
    error: console.error,
    log: console.log,
    info: console.info,
    debug: console.debug,
  };
  const logs: string[] = [];
  let logCount = 0;
  const keepLog = (...args: unknown[]): void => {
    logCount += 1;
    if (logs.length < MAX_LOG_LINES) logs.push(`[frame ${frame}] ${args.map(formatArg).join(' ')}`);
  };
  console.log = keepLog;
  console.info = keepLog;
  console.debug = () => {};
  console.warn = (...args: unknown[]) => {
    const thrown = args.find(arg => arg instanceof Error);
    if (thrown instanceof ResourceNotDecodedError) {
      modelsNotDecoded += 1;
      return;
    }
    const message = args.map(formatArg).join(' ');
    if (/^Lit is in dev mode/.test(message)) return;
    // SceneRunner's own clock; not the game's business.
    if (/^THREE\.THREE\.Clock: This module has been deprecated/.test(message)) return;
    if (/^\[AudioService\] Web Audio API is not supported/.test(message)) return;
    const pending = PENDING.exec(message);
    if (pending) {
      addWarning(
        'W_SMOKE_PENDING_COMPONENT',
        `${pending[1]} on node "${pending[2]}" is not registered — it never runs.`
      );
    } else if (thrown instanceof MissingResourceError) {
      addWarning(
        'W_SMOKE_MISSING_RESOURCE',
        `${thrown.resource} does not exist (${message.split(':')[0]}).`
      );
    } else if (
      /^\[(SceneLoader|AssetLoader|ResourceManager|SceneRunner|SceneService)\]/.test(message)
    ) {
      addWarning('W_SMOKE_LOADER', message);
    } else {
      addWarning('W_SMOKE_CONSOLE_WARN', message);
    }
  };
  console.error = (...args: unknown[]) => {
    const message = args.map(formatArg).join(' ');
    if (ENGINE_REPORTS.some(pattern => pattern.test(message))) return;
    const thrown = args.find(arg => arg instanceof Error);
    addError({
      code: 'E_SMOKE_CONSOLE_ERROR',
      message,
      ...(thrown instanceof Error && thrown.stack ? { stack: thrown.stack } : {}),
    });
  };

  const onRejection = (reason: unknown): void => {
    const { message, stack } = describeThrown(reason);
    addError({ code: 'E_SMOKE_UNHANDLED', phase: 'promise', message, ...(stack ? { stack } : {}) });
  };
  const onException = (thrown: unknown): void => {
    const { message, stack } = describeThrown(thrown);
    addError({ code: 'E_SMOKE_UNHANDLED', phase: 'timer', message, ...(stack ? { stack } : {}) });
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  const releaseSink = registerScriptErrorSink((info: ScriptErrorInfo) => {
    const code: SmokeErrorCode =
      info.phase === 'tick'
        ? 'E_SMOKE_TICK'
        : info.phase === 'command'
          ? 'E_SMOKE_COMMAND'
          : 'E_SMOKE_SCRIPT';
    addError({
      code,
      phase: info.phase,
      message: info.message,
      ...(info.componentType ? { script: info.componentType } : {}),
      ...(info.nodeId ? { nodeId: info.nodeId } : {}),
      ...(info.nodeName ? { nodeName: info.nodeName } : {}),
      ...(info.stack ? { stack: info.stack } : {}),
    });
  });

  let runner: SceneRunner | null = null;
  const timings = { compile: 0, load: 0, firstFrame: 0 };
  const stepTimes: number[] = [];
  let nodesStart = 0;
  let nodesEnd = 0;
  let executed = 0;
  let started = false;
  let registered: readonly string[] = [];

  const finish = (): SmokeOutcome => {
    const sorted = [...stepTimes].sort((a, b) => a - b);
    const total = stepTimes.reduce((sum, value) => sum + value, 0);
    const round = (value: number): number => Math.round(value * 100) / 100;
    if (modelsNotDecoded > 0) {
      notes.push(
        `${modelsNotDecoded} model/Spine asset load(s) not decoded headless: those nodes exist but have no mesh or skeleton.`
      );
    }
    if (dom.imagesLoaded > 0) {
      notes.push(
        `${dom.imagesLoaded} image(s) loaded through the DOM (three's TextureLoader) resolved as blank 1×1 pictures.`
      );
    }
    let game: SmokeReport['game'] = null;
    const provider = getGameDebug();
    if (provider) {
      let snapshot: unknown = null;
      try {
        snapshot = JSON.parse(JSON.stringify(provider.snapshot?.() ?? null)) as unknown;
      } catch (thrown) {
        snapshot = { error: describeThrown(thrown).message };
      }
      game = { name: provider.name, snapshot };
    }
    const warnings = [...warningsByKey.values()].map(({ warning, count }) =>
      count > 1 ? { ...warning, count } : warning
    );
    return {
      ok: errors.length === 0,
      scene: job.scene,
      frames: executed,
      framesRequested: job.frames,
      firstFrameOk:
        started && executed >= Math.min(1, job.frames) && !errors.some(e => e.frame <= 1),
      errors,
      warnings,
      nodes: { start: nodesStart, end: nodesEnd },
      timingsMs: {
        compile: round(timings.compile),
        load: round(timings.load),
        firstFrame: round(timings.firstFrame),
        step: {
          total: round(total),
          mean: round(stepTimes.length > 0 ? total / stepTimes.length : 0),
          p95: round(
            sorted.length > 0
              ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
              : 0
          ),
          max: round(sorted.length > 0 ? sorted[sorted.length - 1] : 0),
        },
        total: round(performance.now() - startedAt),
      },
      scripts: registered,
      domMissing: [...dom.missing],
      notes,
      game,
      logs: { count: logCount, lines: logs },
    };
  };

  try {
    const project = new ProjectFiles(job.projectRoot);
    const registry = new ScriptRegistry();
    registerBuiltInScripts(registry);

    // --- Scripts --------------------------------------------------------------------------------
    const compileStart = performance.now();
    const index = scanUserScripts(project);
    const compiled = await compileAndImportScripts(project, index.entries, registry, imports, {
      esbuildSpecifier: job.esbuildSpecifier,
      fallbackResolveDir: job.fallbackResolveDir,
    });
    timings.compile = performance.now() - compileStart;
    switch (compiled.status) {
      case 'unavailable':
        return {
          ok: false,
          code: 'E_SMOKE_UNSUPPORTED',
          reason: compiled.reason,
          scene: job.scene,
        };
      case 'compile-failed':
        for (const failure of compiled.failures) {
          addError({
            code: 'E_SMOKE_SCRIPT_COMPILE',
            message: `${failure.file ? `${failure.file}${failure.line ? `:${failure.line}` : ''}: ` : ''}${failure.message}`,
          });
        }
        return finish();
      case 'import-failed': {
        const { message, stack } = describeThrown(compiled.error);
        addError({
          code: 'E_SMOKE_SCRIPT_IMPORT',
          message: `The project scripts threw when imported (module top level): ${message}`,
          ...(stack ? { stack } : {}),
        });
        for (const specifier of compiled.stubbed) {
          addWarning(
            'W_SMOKE_STUBBED_IMPORT',
            `import "${specifier}" resolved nowhere and was replaced by an empty module.`
          );
        }
        return finish();
      }
      case 'loaded':
        registered = compiled.registered;
        for (const specifier of compiled.stubbed) {
          addWarning(
            'W_SMOKE_STUBBED_IMPORT',
            `import "${specifier}" resolved nowhere (not installed in the project) and was replaced by an empty module — code using it will not work headless.`
          );
        }
        if (compiled.bundledPackages.length > 0) {
          notes.push(
            `Bundled from the project's node_modules: ${compiled.bundledPackages.join(', ')}.`
          );
        }
        if (compiled.bundledPackages.some(name => name.startsWith('@dimforge/rapier'))) {
          notes.push(
            'Rapier physics is loaded from the project (WASM, initialised by the game scripts).'
          );
        }
        break;
      case 'none':
        break;
    }

    // --- Runtime --------------------------------------------------------------------------------
    const disk = new DiskResourceManager(project.root);
    const assetLoader = new NodeAssetLoader(disk);
    const sceneLoader = new SceneLoader(assetLoader, registry, disk);
    const sceneManager = new SceneManager(sceneLoader);
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    let postProcessSkipped = false;
    // Never settles: the effect composer never becomes ready, so it never renders (see above).
    setPostprocessingModuleLoader(() => new Promise<never>(() => {}));
    const audio = new AudioService();
    runner = new SceneRunner(
      sceneManager,
      createNullRenderer(canvas, () => {
        if (!postProcessSkipped)
          notes.push(
            'The scene has an active PostProcess node: post-processing is not run headless.'
          );
        postProcessSkipped = true;
      }),
      audio,
      assetLoader,
      job.viewport
    );
    runner.setTimeMode({
      mode: 'manual',
      fixedDeltaSec: 1 / 60,
      renderEveryNTicks: NEVER_RENDER,
      muteAudio: true,
    });
    if (isRecord(job.localization) && typeof job.localization.defaultLocale === 'string') {
      runner.setLocalizationConfig(job.localization as unknown as LocalizationConfig);
    }

    // --- Frame 0: load + onAttach/onStart ------------------------------------------------------
    const loadStart = performance.now();
    try {
      await runner.loadAndStartScene(job.scene);
      await flushPending(START_UP_FLUSH_ROUNDS);
      started = true;
    } catch (thrown) {
      const detail =
        thrown instanceof SceneValidationError && thrown.details.length > 0
          ? ` (${thrown.details.join('; ')})`
          : '';
      const { message, stack } = describeThrown(thrown);
      addError({
        code: 'E_SMOKE_LOAD',
        message: `${message}${detail}`,
        ...(stack ? { stack } : {}),
      });
      return finish();
    } finally {
      timings.load = performance.now() - loadStart;
    }
    nodesStart = countNodes(runner.getLiveRootNodes());

    // --- Frames 1..N ----------------------------------------------------------------------------
    for (let next = 1; next <= job.frames; next += 1) {
      frame = next;
      // Only reads made during this frame are attached to this frame's errors.
      dom.takeRecentMissing();
      const stepStart = performance.now();
      const ran = runner.stepFrames(1);
      const elapsed = performance.now() - stepStart;
      if (ran === 0) {
        addWarning(
          'W_SMOKE_STOPPED',
          `The runner stopped before frame ${next} (a script stopped or paused the game).`
        );
        break;
      }
      executed += 1;
      stepTimes.push(elapsed);
      if (next === 1) timings.firstFrame = elapsed;
      await flushPending();
    }
    nodesEnd = countNodes(runner.getLiveRootNodes());
    notes.push(
      'Audio is silent (no Web Audio in Node); input receives no events; nothing is rendered.'
    );
    return finish();
  } catch (thrown) {
    const { message, stack } = describeThrown(thrown);
    addError({ code: 'E_SMOKE_TICK', message, ...(stack ? { stack } : {}) });
    return finish();
  } finally {
    try {
      runner?.stop();
    } catch {
      // A stop that throws must not hide the report.
    }
    releaseSink();
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    Object.assign(console, original);
    dom.uninstall();
  }
};
